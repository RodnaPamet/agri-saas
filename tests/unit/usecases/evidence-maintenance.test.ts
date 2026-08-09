/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks + fake DB. */
/**
 * Unit tests for `src/app-layer/usecases/evidence-maintenance.ts` — the
 * three background-job usecases that keep the evidence corpus honest:
 *   - `reconcileUnlinkedEvidence` flags FILE evidence still unattached
 *     after a TTL (compliance-required follow-up)
 *   - `cleanupFailedOrPendingUploads` retires stuck uploads + their
 *     temp-storage payloads
 *   - `detectBrokenEvidence` walks every FILE evidence row looking
 *     for a missing / DELETED / FAILED underlying file record
 *
 * Wave-3 of the `usecases/` branch-coverage ratchet. Each test
 * exercises a SPECIFIC decision branch rather than a happy-path
 * smoke — the file is mostly conditional emit / per-row classifier
 * logic, so the branch matrix is where the regression risk lives.
 *
 * Coverage targets:
 *   - empty-flagged-set vs flagged-set branches (no audit emit /
 *     N audit emits)
 *   - per-record `provider.delete` swallowing inside
 *     `cleanupFailedOrPendingUploads` (best-effort contract)
 *   - all four broken-evidence classifier reasons
 *     (missing_file_record_id, file_record_not_found,
 *      file_record_deleted, file_record_failed)
 *   - tenantId propagation through `withTenantDb`
 */

const withTenantDbCalls: string[] = [];
const appendAuditEntryCalls: any[] = [];
const providerDeleteCalls: string[] = [];

const mockDb: any = {
    evidence: { findMany: jest.fn() },
    fileRecord: { findMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
};

jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        withTenantDb: jest.fn(async (tenantId: string, callback: any) => {
            withTenantDbCalls.push(tenantId);
            return callback(mockDb);
        }),
    };
});

jest.mock('@/lib/audit/audit-writer', () => ({
    appendAuditEntry: jest.fn(async (entry: any) => {
        appendAuditEntryCalls.push(entry);
    }),
}));

let _shouldThrowOnDelete = false;
jest.mock('@/lib/storage', () => ({
    getProviderByName: jest.fn(() => ({
        delete: jest.fn(async (pathKey: string) => {
            providerDeleteCalls.push(pathKey);
            if (_shouldThrowOnDelete) throw new Error('storage offline');
        }),
    })),
}));

import {
    reconcileUnlinkedEvidence,
    cleanupFailedOrPendingUploads,
    detectBrokenEvidence,
} from '@/app-layer/usecases/evidence-maintenance';

beforeEach(() => {
    withTenantDbCalls.length = 0;
    appendAuditEntryCalls.length = 0;
    providerDeleteCalls.length = 0;
    _shouldThrowOnDelete = false;
    mockDb.evidence.findMany.mockReset();
    mockDb.fileRecord.findMany.mockReset();
    mockDb.fileRecord.update.mockReset();
    mockDb.fileRecord.findUnique.mockReset();
    mockDb.fileRecord.update.mockResolvedValue({ id: 'fr-x', status: 'FAILED' });
});

// ──────────────────────────────────────────────────────────────────────
// reconcileUnlinkedEvidence
// ──────────────────────────────────────────────────────────────────────
describe('reconcileUnlinkedEvidence', () => {
    it('returns flagged=0 + no audit emit when nothing is unlinked', async () => {
        mockDb.evidence.findMany.mockResolvedValueOnce([]);

        const result = await reconcileUnlinkedEvidence('tenant-1');

        expect(result).toEqual({ flagged: 0, items: [] });
        expect(appendAuditEntryCalls).toHaveLength(0);
        expect(withTenantDbCalls).toEqual(['tenant-1']);
    });

    it('emits ONE EVIDENCE_UNLINKED_WARNING audit per unlinked row', async () => {
        mockDb.evidence.findMany.mockResolvedValueOnce([
            {
                id: 'ev-1',
                title: 'Q3 SOC2 screenshot',
                fileName: 'soc2.png',
                createdAt: new Date('2026-01-01T00:00:00Z'),
            },
            {
                id: 'ev-2',
                title: null,
                fileName: 'pen-test.pdf',
                createdAt: new Date('2026-01-02T00:00:00Z'),
            },
        ]);

        const result = await reconcileUnlinkedEvidence('tenant-1');

        expect(result.flagged).toBe(2);
        expect(appendAuditEntryCalls).toHaveLength(2);
        // Audit row is JOB-actor (no userId — these come from cron, not requests).
        for (const call of appendAuditEntryCalls) {
            expect(call.actorType).toBe('JOB');
            expect(call.userId).toBeNull();
            expect(call.action).toBe('EVIDENCE_UNLINKED_WARNING');
            expect(call.tenantId).toBe('tenant-1');
            expect(call.entity).toBe('Evidence');
        }
        expect(appendAuditEntryCalls[0].entityId).toBe('ev-1');
        expect(appendAuditEntryCalls[1].entityId).toBe('ev-2');
    });

    it('passes the configured olderThanMinutes through to the cutoff query', async () => {
        mockDb.evidence.findMany.mockResolvedValueOnce([]);
        const before = Date.now();

        await reconcileUnlinkedEvidence('tenant-1', 24 * 60); // 24h

        const where = mockDb.evidence.findMany.mock.calls[0][0].where;
        // cutoff is `now - minutes * 60_000`. Allow a tiny clock-skew
        // window for the test's own runtime.
        const cutoff = where.createdAt.lt as Date;
        const expectedAbout = before - 24 * 60 * 60_000;
        expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedAbout - 2000);
        expect(cutoff.getTime()).toBeLessThanOrEqual(expectedAbout + 2000);
        // The query only ever matches unlinked FILE evidence — these
        // four guards are the load-bearing filters and must not drift.
        expect(where.tenantId).toBe('tenant-1');
        expect(where.type).toBe('FILE');
        expect(where.practiceId).toBeNull();
        expect(where.deletedAt).toBeNull();
    });
});

// ──────────────────────────────────────────────────────────────────────
// cleanupFailedOrPendingUploads
// ──────────────────────────────────────────────────────────────────────
describe('cleanupFailedOrPendingUploads', () => {
    it('returns cleaned=0 when no PENDING/FAILED records exist', async () => {
        mockDb.fileRecord.findMany.mockResolvedValueOnce([]);

        const result = await cleanupFailedOrPendingUploads('tenant-1');

        expect(result).toEqual({ cleaned: 0 });
        expect(providerDeleteCalls).toHaveLength(0);
        expect(mockDb.fileRecord.update).not.toHaveBeenCalled();
    });

    it('marks each PENDING/FAILED record as FAILED and increments cleaned', async () => {
        mockDb.fileRecord.findMany.mockResolvedValueOnce([
            { id: 'fr-1', tenantId: 'tenant-1', status: 'PENDING', pathKey: 'tmp/a', storageProvider: 'local' },
            { id: 'fr-2', tenantId: 'tenant-1', status: 'FAILED',  pathKey: 'tmp/b', storageProvider: 's3' },
        ]);

        const result = await cleanupFailedOrPendingUploads('tenant-1');

        expect(result.cleaned).toBe(2);
        expect(providerDeleteCalls).toEqual(['tmp/a', 'tmp/b']);
        expect(mockDb.fileRecord.update).toHaveBeenCalledTimes(2);
        expect(mockDb.fileRecord.update.mock.calls[0][0]).toMatchObject({
            where: { id: 'fr-1' },
            data: { status: 'FAILED' },
        });
    });

    it('SWALLOWS provider.delete failure and still flips the record to FAILED', async () => {
        // Best-effort: a missing temp file (already swept by the
        // storage backend) or a transient S3 hiccup must not block
        // the DB-side cleanup. The status flip is the load-bearing
        // bit; the unlink is hygiene.
        _shouldThrowOnDelete = true;
        mockDb.fileRecord.findMany.mockResolvedValueOnce([
            { id: 'fr-3', tenantId: 'tenant-1', status: 'PENDING', pathKey: 'tmp/c', storageProvider: 'local' },
        ]);

        const result = await cleanupFailedOrPendingUploads('tenant-1');

        expect(result.cleaned).toBe(1);
        expect(mockDb.fileRecord.update).toHaveBeenCalledTimes(1);
    });

    it('defaults storageProvider to local when the column is null', async () => {
        mockDb.fileRecord.findMany.mockResolvedValueOnce([
            { id: 'fr-4', tenantId: 'tenant-1', status: 'PENDING', pathKey: 'tmp/d', storageProvider: null },
        ]);
        const result = await cleanupFailedOrPendingUploads('tenant-1');
        // Reaching the delete + update branch is enough to confirm
        // the fallback didn't throw on the `as 'local' | 's3'` cast.
        expect(result.cleaned).toBe(1);
        expect(providerDeleteCalls).toEqual(['tmp/d']);
    });

    it('passes the configured olderThanMinutes through to the cutoff query', async () => {
        mockDb.fileRecord.findMany.mockResolvedValueOnce([]);
        await cleanupFailedOrPendingUploads('tenant-1', 5);

        const where = mockDb.fileRecord.findMany.mock.calls[0][0].where;
        expect(where.tenantId).toBe('tenant-1');
        expect(where.status).toEqual({ in: ['PENDING', 'FAILED'] });
        expect(where.createdAt.lt).toBeInstanceOf(Date);
    });
});

// ──────────────────────────────────────────────────────────────────────
// detectBrokenEvidence — the four-reason classifier
// ──────────────────────────────────────────────────────────────────────
describe('detectBrokenEvidence', () => {
    it('returns broken=0 when every evidence row has a healthy file record', async () => {
        mockDb.evidence.findMany.mockResolvedValueOnce([
            { id: 'ev-ok', tenantId: 'tenant-1', title: 'fine', type: 'FILE', fileRecordId: 'fr-ok', deletedAt: null },
        ]);
        mockDb.fileRecord.findUnique.mockResolvedValueOnce({ status: 'COMPLETED' });

        const result = await detectBrokenEvidence('tenant-1');

        expect(result.broken).toBe(0);
        expect(result.items).toHaveLength(0);
        expect(appendAuditEntryCalls).toHaveLength(0);
    });

    it('classifies "missing_file_record_id" when fileRecordId is null', async () => {
        mockDb.evidence.findMany.mockResolvedValueOnce([
            { id: 'ev-1', tenantId: 'tenant-1', title: 't', type: 'FILE', fileRecordId: null, deletedAt: null },
        ]);

        const result = await detectBrokenEvidence('tenant-1');

        expect(result.broken).toBe(1);
        expect(result.items[0]).toMatchObject({ id: 'ev-1', reason: 'missing_file_record_id' });
        // Audit fired since broken.length > 0.
        expect(appendAuditEntryCalls).toHaveLength(1);
        expect(appendAuditEntryCalls[0].action).toBe('EVIDENCE_BROKEN_DETECTED');
        // The expensive findUnique is skipped on the null branch
        // (the `continue` short-circuits before the DB hit).
        expect(mockDb.fileRecord.findUnique).not.toHaveBeenCalled();
    });

    it('classifies "file_record_not_found" when the referenced record is gone', async () => {
        mockDb.evidence.findMany.mockResolvedValueOnce([
            { id: 'ev-2', tenantId: 'tenant-1', title: 't', type: 'FILE', fileRecordId: 'fr-gone', deletedAt: null },
        ]);
        mockDb.fileRecord.findUnique.mockResolvedValueOnce(null);

        const result = await detectBrokenEvidence('tenant-1');

        expect(result.broken).toBe(1);
        expect(result.items[0]).toMatchObject({ reason: 'file_record_not_found' });
    });

    it('classifies "file_record_deleted" when the underlying record is DELETED', async () => {
        mockDb.evidence.findMany.mockResolvedValueOnce([
            { id: 'ev-3', tenantId: 'tenant-1', title: 't', type: 'FILE', fileRecordId: 'fr-d', deletedAt: null },
        ]);
        mockDb.fileRecord.findUnique.mockResolvedValueOnce({ status: 'DELETED' });

        const result = await detectBrokenEvidence('tenant-1');

        expect(result.items[0].reason).toBe('file_record_deleted');
    });

    it('classifies "file_record_failed" when the underlying record is FAILED', async () => {
        mockDb.evidence.findMany.mockResolvedValueOnce([
            { id: 'ev-4', tenantId: 'tenant-1', title: 't', type: 'FILE', fileRecordId: 'fr-f', deletedAt: null },
        ]);
        mockDb.fileRecord.findUnique.mockResolvedValueOnce({ status: 'FAILED' });

        const result = await detectBrokenEvidence('tenant-1');

        expect(result.items[0].reason).toBe('file_record_failed');
    });

    it('emits one EVIDENCE_BROKEN_DETECTED audit per broken item (not per evidence row)', async () => {
        mockDb.evidence.findMany.mockResolvedValueOnce([
            { id: 'ev-a', tenantId: 'tenant-1', title: 'a', type: 'FILE', fileRecordId: null, deletedAt: null },
            { id: 'ev-b', tenantId: 'tenant-1', title: 'b', type: 'FILE', fileRecordId: 'fr-x', deletedAt: null },
            { id: 'ev-c', tenantId: 'tenant-1', title: 'c', type: 'FILE', fileRecordId: 'fr-y', deletedAt: null },
        ]);
        // ev-b is healthy, ev-c is FAILED.
        mockDb.fileRecord.findUnique
            .mockResolvedValueOnce({ status: 'COMPLETED' })
            .mockResolvedValueOnce({ status: 'FAILED' });

        const result = await detectBrokenEvidence('tenant-1');

        // ev-a (null id) + ev-c (FAILED) — ev-b is fine.
        expect(result.broken).toBe(2);
        expect(appendAuditEntryCalls).toHaveLength(2);
        const ids = appendAuditEntryCalls.map((c) => c.entityId).sort();
        expect(ids).toEqual(['ev-a', 'ev-c']);
    });

    it('handles a mix of all four broken-reason classes in one sweep', async () => {
        mockDb.evidence.findMany.mockResolvedValueOnce([
            { id: 'no-id',  tenantId: 'tenant-1', title: 't', type: 'FILE', fileRecordId: null,      deletedAt: null },
            { id: 'gone',   tenantId: 'tenant-1', title: 't', type: 'FILE', fileRecordId: 'fr-1',    deletedAt: null },
            { id: 'deld',   tenantId: 'tenant-1', title: 't', type: 'FILE', fileRecordId: 'fr-2',    deletedAt: null },
            { id: 'fail',   tenantId: 'tenant-1', title: 't', type: 'FILE', fileRecordId: 'fr-3',    deletedAt: null },
        ]);
        mockDb.fileRecord.findUnique
            .mockResolvedValueOnce(null)                       // "gone" — file_record_not_found
            .mockResolvedValueOnce({ status: 'DELETED' })      // "deld"
            .mockResolvedValueOnce({ status: 'FAILED' });      // "fail"

        const result = await detectBrokenEvidence('tenant-1');

        expect(result.broken).toBe(4);
        const reasonsByEntity = Object.fromEntries(
            result.items.map((i) => [i.id, i.reason]),
        );
        expect(reasonsByEntity).toEqual({
            'no-id': 'missing_file_record_id',
            'gone': 'file_record_not_found',
            'deld': 'file_record_deleted',
            'fail': 'file_record_failed',
        });
    });
});
