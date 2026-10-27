/**
 * Put a ДНЕВНИК or БАБХ document in the farmer's Google Drive — #2019.
 *
 * Follow-up A to #2005, which shipped the consent flow, and to #2369, which
 * shipped the upload. This is the orchestration: resolve the grant, refuse
 * early if Drive was never granted, render the document that already has a
 * download button, put it in a folder the app owns, and remember the folder.
 *
 * ## A button, not a hook — the owner's decision, 2026-10-16
 *
 * The automatic version — every journal PDF and БАБХ form written to Drive as
 * it is generated — is the genuinely useful one, and it is also where all the
 * hard work is: a queue, retries, and a way to surface a failure that happens
 * while a sweep runs at 03:00 with nobody watching. A button puts a person in
 * front of every attempt, so an expired token or a partial grant is found by
 * the one who clicked. That is the right way to prove the client path before
 * adding a path with no observer.
 *
 * ## Admin only, which is what "match the token" means
 *
 * The owner's ruling (2026-10-26) was to gate the export exactly as the
 * credential is gated rather than invent a looser rule for it. That falls out
 * of the design rather than being imposed on it:
 * `resolveGoogleConnectionToken` already calls `assertCanAdmin`, because it
 * decrypts and rotates a tenant-wide secret. So an export cannot be more open
 * than admin without splitting the token resolver.
 *
 * `assertCanAdmin` is ALSO called here, deliberately and redundantly. The gate
 * on a destructive-ish outward action should be legible at the top of the
 * usecase rather than reachable only by following a call into a provider
 * module — and a refactor that gave the resolver a non-admin path would
 * otherwise silently widen this.
 *
 * **The accepted cost, stated because it is a real one:** a farmer-worker who
 * just produced the document from the journal cannot export it. They see the
 * download button work and the Drive button refuse. The alternative was a
 * separate permission for "may send this tenant's documents to a third-party
 * account the admin connected", and the owner judged that not worth a new
 * permission for a first increment.
 *
 * ## Which connection
 *
 * The OLDEST enabled Google connection. The connect flow defaults the row's
 * name to `GOOGLE_CONNECTION_NAME` but accepts a custom one, so a tenant can
 * hold more than one and the uniqueness constraint is on
 * `(tenantId, provider, name)` rather than on the provider alone.
 *
 * Oldest rather than newest because the export destination should be STABLE:
 * with newest-wins, connecting a second Google account would silently move
 * where every subsequent register lands, and nobody would be told. Oldest is
 * unchanged by additions.
 *
 * @module usecases/farm-record-drive-export
 */

import type { Prisma } from '@prisma/client';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanAdmin } from '../policies/common';
import { assertModuleEnabled } from './modules';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { logEvent } from '../events/audit';
import { codedBadRequest } from '@/lib/errors/types';
import {
    GOOGLE_INTEGRATION_FLAG,
    resolveGoogleConnectionToken,
    type GoogleConfigJson,
} from '../integrations/providers/google/service';
import { GOOGLE_PROVIDER } from '../integrations/providers/google/token';
import { ensureDriveFolder, uploadToDrive } from '../integrations/providers/google/drive';
import {
    generateFarmRecordDiaryPdf,
    generateFarmRecordDiaryPdfScoped,
} from '../reports/pdf/farm-record-diary';
import { collectPdfBuffer } from '../reports/pdf/collect-buffer';
import { farmRecordAbsence } from '../reports/pdf/farm-record-absence';

/**
 * The folder these accumulate in, as it appears in the farmer's own Drive.
 *
 * Latin brand plus a Bulgarian noun: the audience is Bulgarian farms, and
 * «Дневници» says what is inside where the brand alone would not. Changing it
 * later is harmless — the folder is addressed by the stored id, so a rename
 * does not orphan anything, and only a folder created AFTER the change gets
 * the new name.
 */
const DRIVE_FOLDER_NAME = 'Agrent — Дневници';

/**
 * `configJson` as this usecase reads it: the connection's own fields plus the
 * folder id it owns. Separate from `GoogleConfigJson` because
 * `driveFolderId` is written here and nowhere else, and `service.ts` has no
 * business knowing about it.
 */
interface DriveExportConfig extends GoogleConfigJson {
    driveFolderId?: string | null;
}

export type DriveExportTarget =
    | { kind: 'treatment'; treatmentGroupId: string }
    | { kind: 'location'; locationId: string; from: string; to: string };

export interface DriveExportResult {
    fileId: string;
    fileName: string;
    /** Google's own link, or null when the upload response omitted it. */
    webViewLink: string | null;
    /**
     * True when the folder was made by this export — either the first one, or
     * because the previous folder had been deleted or binned. Surfaced so the
     * UI can explain an apparently empty folder rather than leaving a farmer
     * to wonder where the earlier exports went.
     */
    folderCreated: boolean;
}

/** `2026-10-27`, in UTC, for the exported filename. */
function isoDay(now: Date): string {
    return now.toISOString().slice(0, 10);
}

/**
 * The name the file takes in Drive.
 *
 * Deliberately NOT the same as the download filename, which is
 * `dnevnik-<id>.pdf`. `drive.file` cannot overwrite, and Drive permits
 * duplicate names, so re-exporting the same register leaves two files called
 * exactly the same thing and a farmer cannot tell which is the newer one
 * without opening both. A download lands in a folder the person is watching
 * and can rename; these accumulate unattended.
 */
function driveFileName(target: DriveExportTarget, now: Date): string {
    const id = target.kind === 'treatment' ? target.treatmentGroupId : target.locationId;
    return `dnevnik-${id}-${isoDay(now)}.pdf`;
}

export async function exportFarmRecordToDrive(
    ctx: RequestContext,
    target: DriveExportTarget,
    deps: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<DriveExportResult> {
    assertCanAdmin(ctx);
    // The flag has to be checked HERE. `resolveGoogleConnectionToken` gates on
    // admin only — `completeGoogleConnect` is the one that checks the flag, and
    // it is not on this path.
    await assertFeatureEnabled(GOOGLE_INTEGRATION_FLAG, ctx.userId);
    // The document is a journal document, so the journal module governs it even
    // though the destination is an integration.
    await assertModuleEnabled(ctx, 'JOURNAL');

    const connection = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { tenantId: ctx.tenantId, provider: GOOGLE_PROVIDER, isEnabled: true },
            select: { id: true, configJson: true },
            orderBy: { createdAt: 'asc' },
        }),
    );
    if (!connection) {
        throw codedBadRequest(
            'GOOGLE_NOT_CONNECTED',
            'No Google account is connected. An administrator connects one in Settings → Integrations.',
        );
    }

    const { accessToken, grantedProducts } = await resolveGoogleConnectionToken(ctx, connection.id);

    // Refuse BEFORE rendering a PDF nobody can receive. Google's consent screen
    // lets the scopes be ticked individually, so a connected row with
    // `drive: false` is an ordinary state rather than a corrupt one — and
    // without this check the farmer would wait for a render and then get a 403
    // from Drive that says nothing about reconnecting.
    if (!grantedProducts.drive) {
        throw codedBadRequest(
            'GOOGLE_DRIVE_NOT_GRANTED',
            'The Google connection does not include Drive access. Reconnect it and grant Drive.',
        );
    }

    // Two generators, because they report emptiness differently.
    //
    // `generateFarmRecordDiaryPdfScoped` is typed `| null` and a treatment
    // handle really can produce it, so the caller decides what the null means.
    // The per-location wrapper `generateFarmRecordDiaryPdf` is typed non-null
    // and means it — not because a block register is never empty, but because
    // it THROWS for that case: `REGISTER_EMPTY_FOR_PERIOD` (404), raised inside
    // the gatherer. Both refusals therefore reach the client correctly without
    // this function deciding anything.
    //
    // Worth stating, because the obvious assumption is the opposite and used to
    // be true: a block with no work once printed blank like the paper form. The
    // owner reversed that on 2026-10-23 and declined the blank form twice, so
    // an empty period is now a refusal rather than an empty document.
    //
    // Routing both through the scoped generator would hand this function a
    // nullable document for a case that cannot be null, and the only way to
    // satisfy the compiler would be an error code for an unreachable branch. A
    // code nothing can raise is a liability: it has to be documented, it reads
    // as a real failure mode to anyone handling errors, and no test can ever
    // exercise it.
    let pdfDoc;
    if (target.kind === 'treatment') {
        const scoped = await generateFarmRecordDiaryPdfScoped(ctx, {
            kind: 'treatment',
            treatmentGroupId: target.treatmentGroupId,
        });
        // Which of two facts a null stands for needs a second query, and the
        // download route decides it the same way — see `farmRecordAbsence`.
        if (!scoped) throw await farmRecordAbsence(ctx, target.treatmentGroupId);
        pdfDoc = scoped;
    } else {
        pdfDoc = await generateFarmRecordDiaryPdf(ctx, {
            locationId: target.locationId,
            from: target.from,
            to: target.to,
        });
    }

    const pdfBuffer = await collectPdfBuffer(pdfDoc);
    const config = (connection.configJson ?? {}) as unknown as DriveExportConfig;

    const folder = await ensureDriveFolder(accessToken, config.driveFolderId ?? null, {
        name: DRIVE_FOLDER_NAME,
        fetchImpl: deps.fetchImpl,
    });

    const now = deps.now ?? new Date();
    const fileName = driveFileName(target, now);
    const uploaded = await uploadToDrive(
        accessToken,
        { name: fileName, mimeType: 'application/pdf', bytes: new Uint8Array(pdfBuffer) },
        { folderId: folder.folderId, fetchImpl: deps.fetchImpl },
    );

    await runInTenantContext(ctx, async (db) => {
        // Written only when the folder is new. Persisting unconditionally would
        // write on every export to say nothing changed.
        if (folder.created) {
            await db.integrationConnection.update({
                where: { id: connection.id },
                data: {
                    configJson: {
                        ...config,
                        driveFolderId: folder.folderId,
                    } as unknown as Prisma.InputJsonValue,
                },
            });
        }
        // Audited because this sends a compliance document out of the platform
        // to an account the platform does not control. The file id is the only
        // handle anyone has for asking Drive what was sent.
        await logEvent(db, ctx, {
            action: 'FARM_RECORD_EXPORTED',
            entityType: 'FarmRecordDriveExport',
            entityId: uploaded.fileId,
            // `detailsJson` is the machine-readable half and is required of
            // every `logEvent` call by `audit-structured-events`. The canonical
            // `data_lifecycle` member is `.strict()` and already has the exact
            // operation for this — so the four fields it permits go here, and
            // the handles go in `metadata`, which is permissive and sanitised.
            // Splitting them is not a workaround: a strict schema that admitted
            // a Drive file id would stop being a statement about data
            // lifecycle.
            detailsJson: {
                category: 'data_lifecycle',
                operation: 'exported',
                model: 'FarmRecordDiary',
                recordCount: 1,
            },
            metadata: {
                target: target.kind,
                reference:
                    target.kind === 'treatment' ? target.treatmentGroupId : target.locationId,
                fileName,
                folderId: folder.folderId,
                folderCreated: folder.created,
                connectionId: connection.id,
            },
        });
    });

    return {
        fileId: uploaded.fileId,
        fileName,
        webViewLink: uploaded.webViewLink,
        folderCreated: folder.created,
    };
}
