/**
 * Deleting the BYTES behind evidence, not just the row.
 *
 * Every purge path did a raw `DELETE FROM "Evidence"` and stopped there. The
 * stored object was never touched, and `purgeSoftDeletedOlderThan` went
 * further: after 90 days it deleted the FileRecord too — the only pointer to
 * the object — while the bytes stayed on disk.
 *
 * That is two failures at once. Unbounded storage growth is the boring one.
 * The serious one is that the product REPORTS the evidence purged, emits a
 * DATA_PURGED audit entry saying so, and the file remains on the volume and
 * readable — which is a retention and GDPR failure, and was directly
 * reachable through the cross-tenant read paths this PR also closes.
 *
 * ## Two rules this module exists to enforce
 *
 * **1. Bytes before pointer.** Delete the object first, the FileRecord
 * second. Crash in between and the row still points at a missing object: the
 * next sweep retries, and the download surfaces a clean "not found". The
 * opposite order loses the only pointer to live bytes, permanently and
 * silently — an orphan nothing can ever find again.
 *
 * **2. Only on the LAST reference.** SHA-256 dedup means several Evidence
 * rows can share one FileRecord: uploading the same PDF to two controls
 * reuses the record rather than storing it twice. Deleting bytes because one
 * of those rows was purged would break every other row still pointing at
 * them. The object goes only when no surviving evidence references it.
 *
 * @module app-layer/usecases/evidence-bytes
 */
import type { PrismaTx } from '@/lib/db-context';
import { getStorageProvider, assertTenantKey } from '@/lib/storage';
import { logger } from '@/lib/observability/logger';

// PrismaTx is the repo's shared "client or transaction" type — the same one
// every repository takes, so this composes with both a plain client (the
// nightly job) and an open transaction (purgeEntity).
type Db = PrismaTx;

const COMPONENT = 'evidence-bytes';

export interface PurgeBytesResult {
    /** Objects removed from storage. */
    objectsDeleted: number;
    /** FileRecords removed (always ≤ objectsDeleted + already-missing). */
    recordsDeleted: number;
    /** Records left alone because other evidence still references them. */
    stillReferenced: number;
    /** Storage deletes that failed; the pointer is deliberately kept. */
    failed: number;
}

/**
 * Release the stored objects behind a set of evidence rows.
 *
 * Call this BEFORE deleting the evidence rows themselves — the reference
 * count below reads the Evidence table, and `evidenceIdsBeingPurged` tells it
 * which rows to treat as already gone.
 *
 * Never throws. A purge whose row deletion succeeds and whose byte deletion
 * fails is recoverable (the next sweep retries); a purge that throws halfway
 * through a batch is not.
 */
export async function purgeEvidenceBytes(
    db: Db,
    tenantId: string,
    evidenceIdsBeingPurged: readonly string[],
): Promise<PurgeBytesResult> {
    const result: PurgeBytesResult = {
        objectsDeleted: 0,
        recordsDeleted: 0,
        stillReferenced: 0,
        failed: 0,
    };
    if (evidenceIdsBeingPurged.length === 0) return result;

    // One query for the whole batch, not one per row (query-shape guard D1).
    const rows = await db.evidence.findMany({
        where: { id: { in: [...evidenceIdsBeingPurged] }, tenantId, fileRecordId: { not: null } },
        select: { fileRecordId: true },
    });
    const fileRecordIds = [...new Set(rows.map((r) => r.fileRecordId).filter((v): v is string => !!v))];
    if (fileRecordIds.length === 0) return result;

    // Surviving references: any evidence pointing at these records that is
    // NOT itself being purged. Counted across the whole tenant in one query.
    const survivors = await db.evidence.findMany({
        where: {
            tenantId,
            fileRecordId: { in: fileRecordIds },
            id: { notIn: [...evidenceIdsBeingPurged] },
        },
        select: { fileRecordId: true },
    });
    const stillReferenced = new Set(survivors.map((r) => r.fileRecordId));

    const releasable = fileRecordIds.filter((id) => !stillReferenced.has(id));
    result.stillReferenced = fileRecordIds.length - releasable.length;
    if (releasable.length === 0) return result;

    const records = await db.fileRecord.findMany({
        where: { id: { in: releasable }, tenantId },
        select: { id: true, pathKey: true },
    });

    const storage = getStorageProvider();
    const deletable: string[] = [];

    for (const rec of records) {
        try {
            // The key came from a tenant-filtered record, but a purge is a
            // destructive operation on a shared volume — assert anyway.
            assertTenantKey(rec.pathKey, tenantId);
            await storage.delete(rec.pathKey);
            result.objectsDeleted += 1;
            deletable.push(rec.id);
        } catch (err) {
            // KEEP THE POINTER. A FileRecord whose object we failed to delete
            // is the only thing that will let a later sweep find those bytes
            // again. Dropping it here is how orphans are made.
            result.failed += 1;
            logger.error('evidence-bytes: storage delete failed, keeping the pointer', {
                component: COMPONENT,
                tenantId,
                fileRecordId: rec.id,
                detail: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (deletable.length > 0) {
        const del = await db.fileRecord.deleteMany({
            where: { id: { in: deletable }, tenantId },
        });
        result.recordsDeleted = del.count;
    }

    logger.info('evidence-bytes: purge complete', { component: COMPONENT, tenantId, ...result });
    return result;
}
