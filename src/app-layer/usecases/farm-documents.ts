/**
 * «Документи» — a farm's document library (#2495 step 2).
 *
 * One library per farm: everyone in the farm sees and previews it, writers and
 * above upload, the uploader or an admin deletes. MECHANISATOR has NO access,
 * and that is enforced nowhere in this file on purpose — `isOperatorAllowedPath`
 * admits only `(farm-tasks|field-operations|tasks|locations|agro)`, so
 * `/documents` is refused at the Edge for that persona. Nesting these routes
 * under an allowed prefix to inherit access would defeat a confinement rather
 * than satisfy it (#2495 Decision 1), and the reason is substantive: this
 * library holds lease contracts, and `ParcelLease.lessorName` is encrypted
 * precisely because it names third parties.
 *
 * ## The two gates, and why each is where it is
 *
 * **Past-due** is asserted HERE, in `uploadFarmDocument`, and not left to
 * `ingestUploadedFile` — even though that function also asserts it. #2030
 * measured the cost of relying on one choke point: two of six byte-writing
 * paths reached it, and the other four stored bytes past the gate. The guard
 * that keeps this honest derives its population from who calls
 * `FileRepository.markStored`, so this file is in it by construction.
 *
 * **The AV gate** is in `readFarmDocumentContent` rather than in the route,
 * which makes this a USECASE SEAM registered in
 * `download-route-gate-reachability`. It owns the purged check, the
 * `isDownloadAllowed` verdict and `assertTenantKey` on the resolved key. That
 * matters more than it looks: `ingest.ts` justifies writing bytes before
 * scanning them with "every read of those bytes goes through a download route
 * that asks `isDownloadAllowed` first", so a gate missing here would
 * retroactively invalidate the reason uploads may hit disk unscanned.
 *
 * It calls `isDownloadAllowed` and does NOT reimplement the policy.
 * `downloadEvidenceFile` next door reads `env.AV_SCAN_MODE || 'permissive'`
 * inline, which is a SECOND answer to the same question — #2518 — and under
 * jest that variable is `undefined`, so the inline form resolves permissive
 * while the declared default is strict. One helper, no default on its
 * argument: `isDownloadAllowed('SKIPPED')` is true in every mode, so a default
 * meaning "unscanned" also means "downloadable".
 */
import { Readable } from 'stream';

import { assertNotPastDueRestricted } from '@/lib/billing/entitlements';
import { runInTenantContext } from '@/lib/db-context';
import { codedNotFound, forbidden } from '@/lib/errors/types';
import { isUniqueViolation } from '@/lib/errors/prisma';
import { expiryDayKey } from '@/lib/documents/retention';
import { logger } from '@/lib/observability';
import { assertTenantKey, getStorageProvider } from '@/lib/storage';
import { isDownloadAllowed } from '@/lib/storage/av-scan';
import { ingestUploadedFile } from '@/lib/upload/ingest';

import { logEvent } from '../events/audit';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { FarmDocumentRepository } from '../repositories/FarmDocumentRepository';
import { FileRepository } from '../repositories/FileRepository';
import { RequestContext } from '../types';

import type { DocumentRetention } from '@prisma/client';

/**
 * The settings a farm has before anyone has opened the settings screen.
 *
 * Mirrors the column defaults in `TenantDocumentSettings` rather than
 * restating a policy: a farm with no row is a farm that has not chosen, and
 * `@default(P1Y)` / `@default(false)` is what it has. The settings ROUTES are
 * step 3; this is the read half, and it deliberately does not create a row —
 * a GET that writes is a surprise in a request the caller believes is a read.
 */
export const DEFAULT_DOCUMENT_SETTINGS: { retention: DocumentRetention; driveSync: boolean } = {
    retention: 'P1Y',
    driveSync: false,
};

/**
 * The list page size.
 *
 * Bounded, and the bound is reported: the response carries `truncated` so a
 * farm past the page does not quietly see a short list. `take: limit + 1` in
 * the repository is how that is known without a second COUNT.
 */
export const DOCUMENT_PAGE_SIZE = 200;

/** What a client needs to render a row, including each tombstone state. */
export interface FarmDocumentRow {
    id: string;
    /** Null on a DELETED tombstone — the name is cleared, by owner ruling. */
    name: string | null;
    contentType: string;
    sizeBytes: number;
    uploadedAt: string;
    uploadedBy: { id: string; name: string | null };
    retention: DocumentRetention;
    /** Day key `YYYY-MM-DD`, null for «Без срок». */
    expiresOn: string | null;
    purgedAt: string | null;
    purgeReason: 'EXPIRED' | 'DELETED' | null;
    purgedByUserId: string | null;
    mayDelete: boolean;
    drive: { state: 'OFF' | 'PENDING' | 'COPIED' | 'FAILED' };
}

type RepoRow = Awaited<ReturnType<typeof FarmDocumentRepository.getById>>;

/**
 * Who may delete this row.
 *
 * The uploader or an admin, and the SAME predicate decides both the flag the
 * client renders and the refusal the server makes — a `mayDelete` computed one
 * way and enforced another is how a button appears that cannot work, or
 * worse, a button that is hidden and still works.
 */
function mayDelete(ctx: RequestContext, uploadedByUserId: string): boolean {
    return ctx.userId === uploadedByUserId || ctx.permissions.canAdmin === true;
}

function toRow(ctx: RequestContext, doc: NonNullable<RepoRow>): FarmDocumentRow {
    return {
        id: doc.id,
        name: doc.name,
        // The RESOLVED type and size, from the FileRecord — never what the
        // client claimed at upload.
        contentType: doc.fileRecord.mimeType,
        sizeBytes: doc.fileRecord.sizeBytes,
        uploadedAt: doc.createdAt.toISOString(),
        uploadedBy: { id: doc.uploadedBy.id, name: doc.uploadedBy.name },
        retention: doc.retention,
        expiresOn: doc.expiresOn,
        purgedAt: doc.purgedAt ? doc.purgedAt.toISOString() : null,
        purgeReason: doc.purgeReason,
        purgedByUserId: doc.purgedByUserId,
        mayDelete: mayDelete(ctx, doc.uploadedByUserId),
        drive: { state: doc.driveState },
    };
}

export async function listFarmDocuments(
    ctx: RequestContext,
    opts: { limit?: number } = {},
): Promise<{ rows: FarmDocumentRow[]; truncated: boolean }> {
    // READER and AUDITOR see the library; it is one library per farm and
    // everyone in the farm previews it (#2495).
    assertCanRead(ctx);

    const limit = Math.min(Math.max(opts.limit ?? DOCUMENT_PAGE_SIZE, 1), DOCUMENT_PAGE_SIZE);

    return runInTenantContext(ctx, async (db) => {
        const found = await FarmDocumentRepository.list(db, ctx, limit);
        const truncated = found.length > limit;
        return {
            rows: found.slice(0, limit).map((d) => toRow(ctx, d)),
            truncated,
        };
    });
}

/**
 * Store a document and file it under the farm's CURRENT retention period.
 *
 * `retention` and `expiresOn` are both fixed AT UPLOAD and stored on the row —
 * a later settings change cannot reach back. `expiresOn` alone would lose WHY
 * that date was given, so the period rides along: a row can then say «Пази се
 * 1 година, до …», and an audit can tell a 1-year document from a 2-year one
 * uploaded a year earlier.
 */
export async function uploadFarmDocument(
    ctx: RequestContext,
    file: File,
    idempotencyKey?: string | null,
): Promise<FarmDocumentRow> {
    assertCanWrite(ctx);

    // HERE, not inherited. See the docblock: #2030 measured four byte-writing
    // paths that stored past a single choke point, and
    // `past-due-capability-coverage` §5 derives its population from
    // `markStored` callers — this file among them.
    await assertNotPastDueRestricted(ctx, 'upload');

    // A replayed upload returns the ORIGINAL row rather than filing a second
    // document. Checked before the bytes are read, so the common retry costs
    // nothing; the unique index below is what makes it correct under a race.
    if (idempotencyKey) {
        const existing = await runInTenantContext(ctx, (db) =>
            FarmDocumentRepository.findByClientMutationId(db, ctx, idempotencyKey),
        );
        if (existing) return toRow(ctx, existing);
    }

    const retention = await runInTenantContext(ctx, async (db) => {
        const settings = await FarmDocumentRepository.settings(db, ctx);
        return settings?.retention ?? DEFAULT_DOCUMENT_SETTINGS.retention;
    });

    // Allowlist → write → MIME-reconcile → scan. Returns a TERMINAL
    // scanStatus, which is passed to `markStored` verbatim: never a guess, and
    // never a default.
    const ingested = await ingestUploadedFile(ctx.tenantId, file, {
        domain: 'documents',
        fallbackName: 'document',
        component: 'farm-documents',
    });

    const expiresOn = expiryDayKey(retention, new Date());

    try {
        return await runInTenantContext(ctx, async (db) => {
            // The FileRecord is minted in the SAME transaction as the document
            // row, which is the convention for a record-backed upload: a
            // FileRecord with no document, or a document pointing at nothing,
            // are both states a reader cannot tell from a crash.
            const fileRecord = await FileRepository.createPending(db, ctx, {
                pathKey: ingested.pathKey,
                originalName: ingested.originalName,
                mimeType: ingested.mimeType,
                sizeBytes: ingested.sizeBytes,
                sha256: ingested.sha256,
                storageProvider: ingested.storageProvider,
                bucket: ingested.bucket,
                domain: ingested.domain,
            });
            await FileRepository.markStored(db, ctx, fileRecord.id, ingested.scanStatus);

            const doc = await FarmDocumentRepository.create(db, ctx, {
                name: ingested.originalName,
                fileRecordId: fileRecord.id,
                retention,
                expiresOn,
                clientMutationId: idempotencyKey ?? null,
            });

            await logEvent(db, ctx, {
                action: 'FARM_DOCUMENT_UPLOADED',
                entityType: 'FarmDocument',
                entityId: doc.id,
                // The NAME is deliberately not in the audit details: it is
                // encrypted on the row precisely because a filename is
                // routinely «Договор аренда <фамилия>.pdf», and `detailsJson`
                // is not an encrypted column.
                detailsJson: {
                    category: 'data',
                    operation: 'created',
                    retention,
                    expiresOn,
                    sizeBytes: ingested.sizeBytes,
                    contentType: ingested.mimeType,
                    scanStatus: ingested.scanStatus,
                },
            });

            return toRow(ctx, doc);
        });
    } catch (err) {
        // Lost the race: another request with the same key committed first.
        // Return ITS row — the same answer the pre-check would have given.
        if (idempotencyKey && isUniqueViolation(err)) {
            const original = await runInTenantContext(ctx, (db) =>
                FarmDocumentRepository.findByClientMutationId(db, ctx, idempotencyKey),
            );
            if (original) return toRow(ctx, original);
        }
        throw err;
    }
}

/**
 * The bytes, for preview.
 *
 * This is the registered USECASE SEAM for `/documents/{id}/content` — see the
 * docblock at the top for why the gate lives here and not in the route.
 */
export async function readFarmDocumentContent(
    ctx: RequestContext,
    id: string,
): Promise<{ stream: Readable; contentType: string; sizeBytes: number; name: string | null }> {
    assertCanRead(ctx);

    const resolved = await runInTenantContext(ctx, async (db) => {
        const doc = await FarmDocumentRepository.getById(db, ctx, id);
        if (!doc) throw codedNotFound('DOCUMENT_NOT_FOUND', 'That document was not found.');

        // A tombstone has no bytes. 404 and not 403: the row is visible in the
        // list with its `purgedAt`, so the client already knows why — and the
        // bytes genuinely are not there to serve.
        if (doc.purgedAt) {
            throw codedNotFound('DOCUMENT_PURGED', 'That document has been removed.');
        }

        if (doc.fileRecord.status !== 'STORED') {
            throw codedNotFound('DOCUMENT_NOT_STORED', 'That document is not available yet.');
        }

        // Tenant isolation on the RESOLVED key, not on the id we were handed.
        assertTenantKey(doc.fileRecord.pathKey, ctx.tenantId);

        // The AV gate. No default on the argument — see the docblock.
        if (!isDownloadAllowed(doc.fileRecord.scanStatus)) {
            throw forbidden('That document cannot be served: it has not passed a virus scan.');
        }

        return doc;
    });

    const provider = getStorageProvider();
    return {
        // `readStream` is SYNCHRONOUS and returns a Readable, not a promise of
        // one — an `await` here would read as an I/O boundary that is not one.
        stream: provider.readStream(resolved.fileRecord.pathKey),
        contentType: resolved.fileRecord.mimeType,
        sizeBytes: resolved.fileRecord.sizeBytes,
        name: resolved.name,
    };
}

/**
 * Delete a document: the bytes go, the row survives as a tombstone.
 *
 * Owner ruling (#2495 Decision 2, refined in the retention comment): a manual
 * delete leaves a tombstone with who and when — the same as expiry — but the
 * NAME is cleared, because a manual delete is a person's intent and very often
 * "this was the wrong file", and keeping it would preserve indefinitely the one
 * field encrypted because it names third parties. Expiry keeps the name: that
 * is policy, and the farm's index of what it held is the point.
 *
 * Dropping the row entirely was the alternative and is worse: it makes "we
 * destroyed this by policy on 14 March" and "this never existed" the same
 * observation, which for a compliance register is the worse failure.
 */
export async function deleteFarmDocument(
    ctx: RequestContext,
    id: string,
): Promise<FarmDocumentRow> {
    assertCanRead(ctx);

    const { doc, pathKey } = await runInTenantContext(ctx, async (db) => {
        const found = await FarmDocumentRepository.getById(db, ctx, id);
        if (!found) throw codedNotFound('DOCUMENT_NOT_FOUND', 'That document was not found.');

        // The same predicate the list reports as `mayDelete`.
        if (!mayDelete(ctx, found.uploadedByUserId)) {
            throw forbidden('Only the person who uploaded this document, or an admin, can delete it.');
        }

        // Already a tombstone: idempotent, and nothing is re-stamped.
        // `purgedAt` is what an appeal and a regulator date from.
        if (found.purgedAt) return { doc: found, pathKey: null };

        assertTenantKey(found.fileRecord.pathKey, ctx.tenantId);

        const tombstone = await FarmDocumentRepository.markPurged(db, ctx, id, 'DELETED');

        await logEvent(db, ctx, {
            action: 'FARM_DOCUMENT_DELETED',
            entityType: 'FarmDocument',
            entityId: id,
            detailsJson: {
                category: 'data',
                operation: 'deleted',
                purgeReason: 'DELETED',
                retention: found.retention,
                expiresOn: found.expiresOn,
            },
        });

        return { doc: tombstone, pathKey: found.fileRecord.pathKey };
    });

    // The bytes go AFTER the row is committed, and a failure here is logged
    // rather than thrown: the tombstone is the record the farm reads, and
    // undoing it because the object store was briefly unreachable would leave
    // a document the UI says is deleted and the server still serves. The
    // orphaned object is bounded — the retention sweep (step 5) owns the
    // reconciliation.
    if (pathKey) {
        try {
            await getStorageProvider().delete(pathKey);
        } catch (err) {
            logger.error('farm document bytes survived their tombstone', {
                component: 'farm-documents',
                tenantId: ctx.tenantId,
                documentId: id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return toRow(ctx, doc);
}
