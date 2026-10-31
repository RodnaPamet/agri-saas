/**
 * Copy a «Документи» document into the farm's own Google Drive — #2495 step 4.
 *
 * One-way, and that word carries the design. This product writes a copy into
 * the farm's Drive and never reads it back, never updates it, and never
 * deletes it — `deleteFarmDocument` and the retention sweep both say so in
 * terms. So a COPIED document whose bytes we later purge leaves the Drive copy
 * as the only surviving artefact, which is exactly what Decision 2's
 * «Само в Google Drive» tombstone tells the farmer.
 *
 * ## The copy is an EGRESS path, so it goes through the download gate
 *
 * This is the part that would be easy to get wrong by writing the obvious
 * code. Reading `FileRecord.pathKey` and streaming it to Drive would copy a
 * document that `/content` refuses to serve — an unscanned upload, or an
 * INFECTED one — and would do it to a destination outside this product
 * entirely. `download-route-gate-reachability` exists because four of five
 * byte-serving routes once skipped that gate; a background job copying to a
 * third party is the same class with a worse blast radius.
 *
 * So the bytes come from `downloadFarmDocument`, which already refuses a
 * purged row, a non-STORED record, a cross-tenant key, an INFECTED scan and
 * anything `isDownloadAllowed` declines. The copy inherits every one of those
 * refusals rather than restating them, and a new refusal added there covers
 * this path on the day it lands.
 *
 * ## `driveFileId` is the idempotency guard
 *
 * Not the state. A job that uploaded successfully and then failed to write
 * `COPIED` would, on a re-run, upload a SECOND copy — and Drive is happy to
 * hold two files with the same name, so nothing downstream would notice. The
 * guard is therefore the id of the file we are told we created: present means
 * a copy exists, whatever the state column says.
 *
 * ## PENDING is never terminal
 *
 * A row left PENDING by a worker that died is indistinguishable from one whose
 * copy is in flight, and refusing to re-enqueue it forever would strand the
 * document in a state the retention sweep also defers — so the bytes would
 * neither copy nor expire. `STALE_PENDING_MS` is what separates the two: a
 * PENDING row older than that may be re-enqueued, a fresh one may not.
 *
 * That bound is deliberately generous. The cost of re-enqueueing too early is
 * a duplicate upload (which `driveFileId` prevents) or a wasted job; the cost
 * of being too slow is an operator staring at a spinner. Fifteen minutes is
 * far longer than any copy takes and far shorter than a farmer's patience for
 * a stuck row.
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanAdmin } from '../policies/common';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { logEvent } from '../events/audit';
import {
    codedBadRequest,
    codedConflict,
    codedNotFound,
    InternalError,
} from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import {
    GOOGLE_INTEGRATION_FLAG,
    resolveGoogleConnectionToken,
} from '../integrations/providers/google';
import { GOOGLE_PROVIDER } from '../integrations/providers/google/token';
import { ensureDriveFolder, uploadToDrive } from '../integrations/providers/google/drive';
import { downloadFarmDocument } from './farm-documents';

/**
 * How long a PENDING row may sit before a re-enqueue is allowed.
 *
 * Read from `updatedAt`, which every transition touches, rather than from a
 * dedicated column: a second timestamp would be one more thing to forget to
 * write, and the only question being asked is "has anything happened to this
 * row lately".
 */
export const STALE_PENDING_MS = 15 * 60 * 1000;

/** The Drive folder every farm's documents land in. */
const DRIVE_FOLDER_NAME = 'Agrent — Документи';

export interface DriveCopyOutcome {
    documentId: string;
    state: 'COPIED' | 'FAILED';
    driveFileId: string | null;
}

/**
 * Perform the copy. Called by the job, never by a route.
 *
 * Returns the outcome rather than throwing on a copy failure: the JOB ran
 * correctly even when Drive refused, and a throw here would be retried by the
 * queue, which is the one thing that must not happen — `attempts: 1` and a
 * per-ROW `FAILED` is the same reasoning `statement-dispatch` uses, for the
 * same reason. A re-send is the operator's decision, through the route below.
 *
 * It DOES throw for the conditions that are not about this document — no
 * connection, no Drive grant, the flag off — because those are wrong for every
 * row in the batch and marking one document FAILED would hide a tenant-wide
 * misconfiguration behind a per-document error badge.
 */
export async function copyDocumentToDrive(
    ctx: RequestContext,
    documentId: string,
    deps: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<DriveCopyOutcome> {
    const now = deps.now ?? new Date();

    const doc = await runInTenantContext(ctx, (db) =>
        db.farmDocument.findFirst({
            where: { id: documentId, tenantId: ctx.tenantId },
            select: {
                id: true,
                name: true,
                driveState: true,
                driveFileId: true,
                purgedAt: true,
            },
        }),
    );
    if (!doc) throw codedNotFound('DOCUMENT_NOT_FOUND', 'That document was not found.');

    // Already copied, by `driveFileId` rather than by state. See the docblock:
    // the id is the evidence a copy exists, and the state is only our record
    // of having written it down.
    if (doc.driveFileId) {
        return { documentId, state: 'COPIED', driveFileId: doc.driveFileId };
    }

    // A purged row has no bytes to copy. Not a failure of the copy — there is
    // nothing to copy — so it is recorded as FAILED without an attempt, and
    // the tombstone's own state is what the farmer reads.
    if (doc.purgedAt) {
        throw codedBadRequest('DOCUMENT_PURGED', 'That document has been deleted.');
    }

    // TENANT-WIDE conditions, thrown rather than recorded per row.
    await assertFeatureEnabled(GOOGLE_INTEGRATION_FLAG, ctx.userId);

    const connection = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { tenantId: ctx.tenantId, provider: GOOGLE_PROVIDER, isEnabled: true },
            select: { id: true },
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
    // Refused BEFORE the bytes are read, for the reason the ДНЕВНИК export
    // gives: Google's consent screen lets the scopes be ticked individually,
    // so a connected row with `drive: false` is an ordinary state, and without
    // this the farmer would wait for a read and then get a 403 from Drive that
    // says nothing about reconnecting.
    if (!grantedProducts.drive) {
        throw codedBadRequest(
            'GOOGLE_DRIVE_NOT_GRANTED',
            'The Google connection does not include Drive access. Reconnect it and grant Drive.',
        );
    }

    try {
        // `name` is nullable because a DELETED tombstone clears it, and such a
        // row is already refused by the `purgedAt` check above — so this is
        // unreachable rather than defended.
        //
        // INSIDE the try, and an `InternalError` rather than a coded refusal
        // or a raw `Error`. All three choices were forced, by three different
        // guards, and the combination is the only one that satisfies them.
        //
        // INSIDE, because an untitled document is a PER-ROW condition: thrown
        // above, where the tenant-wide refusals live, it would make the sweep
        // mark every one of that farm's PENDING rows FAILED because one
        // document had no title.
        //
        // NOT a coded refusal, because a `coded*` code is a promise to a
        // client and no client can receive this one — the sweep is the only
        // caller and it records FAILED. `error-codes-are-documented` caught
        // the first attempt and was right to: a documented refusal nobody can
        // be shown is debt, not documentation.
        //
        // NOT a raw `Error` either: `regression-scanner` bans those in
        // usecases, and caught the second attempt. `InternalError` is the
        // answer the two constraints leave — a TYPED error carrying the
        // generic `INTERNAL` code with `expose: false`, so its message reaches
        // the log and never a person. Which is also what it IS: a row with a
        // cleared name and no purge timestamp is an internal inconsistency,
        // not something a farmer did.
        if (!doc.name) {
            throw new InternalError(
                `document ${documentId} has no title, so it cannot be named in Drive`,
            );
        }
        // THE GATE. Every refusal `/content` makes, this inherits.
        const gated = await downloadFarmDocument(ctx, documentId);
        const chunks: Buffer[] = [];
        for await (const chunk of gated.stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
        const bytes = Buffer.concat(chunks);

        const folder = await ensureDriveFolder(accessToken, null, {
            name: DRIVE_FOLDER_NAME,
            fetchImpl: deps.fetchImpl,
        });
        const uploaded = await uploadToDrive(
            accessToken,
            { name: doc.name, mimeType: gated.contentType, bytes },
            { folderId: folder.folderId, fetchImpl: deps.fetchImpl },
        );

        await runInTenantContext(ctx, async (db) => {
            await db.farmDocument.update({
                where: { id: documentId },
                data: {
                    driveState: 'COPIED',
                    driveFileId: uploaded.fileId,
                    driveCopiedAt: now,
                    driveAttempts: { increment: 1 },
                },
            });
            await logEvent(db, ctx, {
                action: 'FARM_DOCUMENT_DRIVE_COPIED',
                entityType: 'FarmDocument',
                entityId: documentId,
                // No `webViewLink`: a Drive URL in the audit trail is a
                // credential-adjacent handle to a third-party resource, and the
                // file id is what identifies the copy.
                detailsJson: {
                    category: 'data_lifecycle',
                    entityName: 'FarmDocument',
                    operation: 'copied_to_drive',
                    driveFileId: uploaded.fileId,
                },
            });
        });

        return { documentId, state: 'COPIED', driveFileId: uploaded.fileId };
    } catch (err) {
        // Per-ROW failure. Recorded, counted, and NOT rethrown — see the
        // docblock on `attempts: 1`.
        await runInTenantContext(ctx, (db) =>
            db.farmDocument.update({
                where: { id: documentId },
                data: { driveState: 'FAILED', driveAttempts: { increment: 1 } },
            }),
        );
        logger.error('documents.drive_copy_failed', {
            component: 'document-drive-copy',
            tenantId: ctx.tenantId,
            documentId,
            // The MESSAGE only. A Drive error body can carry the file name and
            // the account's email, and this line goes to the log aggregator.
            error: err instanceof Error ? err.message : String(err),
        });
        return { documentId, state: 'FAILED', driveFileId: null };
    }
}

/**
 * Re-enqueue a copy an operator can see has failed — the route's action.
 *
 * FAILED only, plus a STALE PENDING. Each refusal is its own code, because the
 * three states a caller can be in want three different next actions and one
 * code for all of them is the defect #2564 was: «изчакайте», «вече е копиран»
 * and «включете синхронизирането» are not the same sentence.
 */
export async function requeueDocumentDriveCopy(
    ctx: RequestContext,
    documentId: string,
    deps: { now?: Date } = {},
): Promise<{ documentId: string; state: 'PENDING' }> {
    assertCanAdmin(ctx);
    const now = deps.now ?? new Date();

    return runInTenantContext(ctx, async (db) => {
        const doc = await db.farmDocument.findFirst({
            where: { id: documentId, tenantId: ctx.tenantId },
            select: { id: true, driveState: true, driveFileId: true, purgedAt: true, updatedAt: true },
        });
        if (!doc) throw codedNotFound('DOCUMENT_NOT_FOUND', 'That document was not found.');
        if (doc.purgedAt) {
            throw codedNotFound('DOCUMENT_PURGED', 'That document has been deleted.');
        }

        // `driveFileId` first, ahead of the state, for the same reason the copy
        // checks it first: the id is the evidence. A row carrying one has a
        // copy in Drive whatever its state column says, and re-enqueueing
        // would make a second.
        if (doc.driveFileId || doc.driveState === 'COPIED') {
            throw codedConflict(
                'DOCUMENT_DRIVE_ALREADY_COPIED',
                'That document is already in Google Drive.',
            );
        }
        if (doc.driveState === 'OFF') {
            // NOT a failure to retry. Nothing was ever attempted, so the
            // remedy is the SETTING rather than this button — and a client
            // offering a retry here would be offering to re-do nothing.
            throw codedConflict(
                'DOCUMENT_DRIVE_SYNC_OFF',
                'Google Drive copying is switched off for this farm. Turn it on in «Документи» settings.',
            );
        }
        if (
            doc.driveState === 'PENDING'
            && now.getTime() - doc.updatedAt.getTime() < STALE_PENDING_MS
        ) {
            throw codedConflict(
                'DOCUMENT_DRIVE_COPY_IN_PROGRESS',
                'That copy is already on its way. Try again in a few minutes.',
            );
        }

        await db.farmDocument.update({
            where: { id: documentId },
            data: { driveState: 'PENDING' },
        });
        await logEvent(db, ctx, {
            action: 'FARM_DOCUMENT_DRIVE_COPY_REQUEUED',
            entityType: 'FarmDocument',
            entityId: documentId,
            detailsJson: {
                category: 'status_change',
                fromStatus: doc.driveState,
                toStatus: 'PENDING',
            },
        });

        return { documentId, state: 'PENDING' as const };
    });
}
