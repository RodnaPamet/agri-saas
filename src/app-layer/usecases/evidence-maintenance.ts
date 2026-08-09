/**
 * Evidence maintenance jobs:
 * - Reconcile unlinked evidence
 * - Cleanup failed/pending uploads
 * - Detect broken evidence (missing files)
 *
 * NOTE: These are background/cron operations that receive a raw tenantId
 * rather than a full RequestContext. They use withTenantDb to ensure
 * RLS enforcement via the app_user role + app.tenant_id session variable.
 */
import { withTenantDb } from '@/lib/db-context';
import { getProviderByName } from '@/lib/storage';

/**
 * Find FILE evidence not linked to any practice after N minutes.
 * Emits EVIDENCE_UNLINKED_WARNING events for admin review.
 */
export async function reconcileUnlinkedEvidence(
    tenantId: string,
    olderThanMinutes: number = 60,
) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);

    return withTenantDb(tenantId, async (db) => {
        const unlinked = await db.evidence.findMany({
            where: {
                tenantId,
                type: 'FILE',
                practiceId: null,
                createdAt: { lt: cutoff },
                deletedAt: null,
            },
            select: { id: true, title: true, fileName: true, createdAt: true },
        });

        if (unlinked.length > 0) {
            const { appendAuditEntry } = require('@/lib/audit/audit-writer');
            for (const ev of unlinked) {
                await appendAuditEntry({
                    tenantId,
                    userId: null,
                    actorType: 'JOB',
                    entity: 'Evidence',
                    entityId: ev.id,
                    action: 'EVIDENCE_UNLINKED_WARNING',
                    details: JSON.stringify({
                        title: ev.title,
                        fileName: ev.fileName,
                        unlinkedSince: ev.createdAt,
                    }),
                });
            }
        }

        return { flagged: unlinked.length, items: unlinked };
    });
}

/**
 * Cleanup old PENDING/FAILED FileRecords: delete temp files and mark FAILED.
 */
export async function cleanupFailedOrPendingUploads(
    tenantId: string,
    olderThanMinutes: number = 30,
) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);

    return withTenantDb(tenantId, async (db) => {
        const pending = await db.fileRecord.findMany({
            where: {
                tenantId,
                status: { in: ['PENDING', 'FAILED'] },
                createdAt: { lt: cutoff },
            },
        });

        let cleaned = 0;
        for (const record of pending) {
            try {
                const provider = getProviderByName((record.storageProvider || 'local') as 'local' | 's3');
                await provider.delete(record.pathKey);
            } catch { /* best effort */ }

            await db.fileRecord.update({
                where: { id: record.id },
                data: { status: 'FAILED' },
            });
            cleaned++;
        }

        return { cleaned };
    });
}

/**
 * Detect evidence records that reference missing/broken FileRecords.
 * Marks them for admin review.
 */
export async function detectBrokenEvidence(tenantId: string) {
    return withTenantDb(tenantId, async (db) => {
        const fileEvidence = await db.evidence.findMany({
            where: { tenantId, type: 'FILE', deletedAt: null },
        });

        const broken: Array<{ id: string; title: string | null; reason: string }> = [];

        for (const ev of fileEvidence) {
            const fileRecordId = ev.fileRecordId;
            if (!fileRecordId) {
                broken.push({ id: ev.id, title: ev.title, reason: 'missing_file_record_id' });
                continue;
            }

            const record = await db.fileRecord.findUnique({
                where: { id: fileRecordId },
                select: { status: true },
            });

            if (!record) {
                broken.push({ id: ev.id, title: ev.title, reason: 'file_record_not_found' });
            } else if (record.status === 'DELETED' || record.status === 'FAILED') {
                broken.push({ id: ev.id, title: ev.title, reason: `file_record_${record.status.toLowerCase()}` });
            }
        }

        if (broken.length > 0) {
            const { appendAuditEntry } = require('@/lib/audit/audit-writer');
            for (const b of broken) {
                await appendAuditEntry({
                    tenantId,
                    userId: null,
                    actorType: 'JOB',
                    entity: 'Evidence',
                    entityId: b.id,
                    action: 'EVIDENCE_BROKEN_DETECTED',
                    details: JSON.stringify({ title: b.title, reason: b.reason }),
                });
            }
        }

        return { broken: broken.length, items: broken };
    });
}
