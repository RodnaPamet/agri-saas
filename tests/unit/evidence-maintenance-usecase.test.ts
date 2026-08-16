/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/evidence-maintenance.ts`.
 *
 * Roadmap Q1 — Evidence + files. Three background-job functions
 * that take a raw tenantId (not RequestContext) and use withTenantDb
 * for RLS-context binding. Mocks Prisma db, storage provider, and
 * the audit-writer entry point.
 *
 * Covers:
 *     exclusion, EVIDENCE_UNLINKED_WARNING audit emission, return
 *     shape with flagged count + items.
 *   - cleanupFailedOrPendingUploads — pending+failed cutoff,
 *     storage provider dispatch, best-effort delete error swallow,
 *     transition to FAILED status, cleaned counter.
 *   - detectBrokenEvidence — 3 break reasons (missing_file_record_id,
 *     file_record_not_found, file_record_deleted/failed),
 *     EVIDENCE_BROKEN_DETECTED emission, return shape.
 */

const mockDb = {
    evidence: { findMany: jest.fn() },
    fileRecord: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    withTenantDb: jest.fn(async (_id: string, fn: (db: any) => any) => fn(mockDb)),
}));

const mockProvider: any = { delete: jest.fn() };
jest.mock('@/lib/storage', () => ({
    getProviderByName: jest.fn(() => mockProvider),
}));

const mockAppendAuditEntry = jest.fn();
jest.mock('@/lib/audit/audit-writer', () => ({
    appendAuditEntry: mockAppendAuditEntry,
}));

import {
    cleanupFailedOrPendingUploads,
    detectBrokenEvidence,
} from '@/app-layer/usecases/evidence-maintenance';

beforeEach(() => {
    jest.clearAllMocks();
});



// ─── cleanupFailedOrPendingUploads ─────────────────────────────────

describe('cleanupFailedOrPendingUploads', () => {
    it('processes PENDING and FAILED records older than the cutoff', async () => {
        (mockDb.fileRecord.findMany as jest.Mock).mockResolvedValue([]);
        await cleanupFailedOrPendingUploads('tenant-1', 30);
        const args = (mockDb.fileRecord.findMany as jest.Mock).mock.calls[0][0];
        expect(args.where.status).toEqual({ in: ['PENDING', 'FAILED'] });
    });

    it('deletes from storage and marks each record as FAILED', async () => {
        (mockDb.fileRecord.findMany as jest.Mock).mockResolvedValue([
            { id: 'fr-1', pathKey: 'a/x.pdf', storageProvider: 'local' },
            { id: 'fr-2', pathKey: 'b/y.pdf', storageProvider: 's3' },
        ]);
        mockProvider.delete.mockResolvedValue(undefined);

        const res = await cleanupFailedOrPendingUploads('tenant-1');

        expect(res.cleaned).toBe(2);
        expect(mockProvider.delete).toHaveBeenCalledTimes(2);
        expect(mockDb.fileRecord.update).toHaveBeenCalledTimes(2);
        const updateArgs = (mockDb.fileRecord.update as jest.Mock).mock.calls[0][0];
        expect(updateArgs.data.status).toBe('FAILED');
    });

    it('swallows provider.delete errors (best-effort cleanup) and still updates the DB', async () => {
        (mockDb.fileRecord.findMany as jest.Mock).mockResolvedValue([
            { id: 'fr-1', pathKey: 'a/x.pdf', storageProvider: 'local' },
        ]);
        mockProvider.delete.mockRejectedValue(new Error('ENOENT'));

        const res = await cleanupFailedOrPendingUploads('tenant-1');

        expect(res.cleaned).toBe(1);
        expect(mockDb.fileRecord.update).toHaveBeenCalledTimes(1);
    });

    it('falls back to "local" storage provider when none recorded', async () => {
        const { getProviderByName } = require('@/lib/storage');
        (mockDb.fileRecord.findMany as jest.Mock).mockResolvedValue([
            { id: 'fr-1', pathKey: 'x', storageProvider: null },
        ]);
        await cleanupFailedOrPendingUploads('tenant-1');
        expect(getProviderByName).toHaveBeenCalledWith('local');
    });
});

// ─── detectBrokenEvidence ──────────────────────────────────────────

describe('detectBrokenEvidence', () => {
    it('flags evidence with no fileRecordId as missing_file_record_id', async () => {
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([
            { id: 'ev-1', title: 'A', fileRecordId: null },
        ]);

        const res = await detectBrokenEvidence('tenant-1');

        expect(res.broken).toBe(1);
        expect(res.items[0]).toEqual({ id: 'ev-1', title: 'A', reason: 'missing_file_record_id' });
    });

    it('flags evidence whose fileRecord row is missing as file_record_not_found', async () => {
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([
            { id: 'ev-1', title: 'A', fileRecordId: 'fr-orphan' },
        ]);
        (mockDb.fileRecord.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await detectBrokenEvidence('tenant-1');

        expect(res.items[0]).toEqual({ id: 'ev-1', title: 'A', reason: 'file_record_not_found' });
    });

    it('flags DELETED file records as file_record_deleted', async () => {
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([
            { id: 'ev-1', title: 'A', fileRecordId: 'fr-1' },
        ]);
        (mockDb.fileRecord.findUnique as jest.Mock).mockResolvedValue({ status: 'DELETED' });

        const res = await detectBrokenEvidence('tenant-1');

        expect(res.items[0]).toEqual({ id: 'ev-1', title: 'A', reason: 'file_record_deleted' });
    });

    it('flags FAILED file records as file_record_failed', async () => {
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([
            { id: 'ev-1', title: 'A', fileRecordId: 'fr-1' },
        ]);
        (mockDb.fileRecord.findUnique as jest.Mock).mockResolvedValue({ status: 'FAILED' });

        const res = await detectBrokenEvidence('tenant-1');

        expect(res.items[0]).toEqual({ id: 'ev-1', title: 'A', reason: 'file_record_failed' });
    });

    it('does NOT flag STORED file records (happy path)', async () => {
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([
            { id: 'ev-1', title: 'A', fileRecordId: 'fr-1' },
        ]);
        (mockDb.fileRecord.findUnique as jest.Mock).mockResolvedValue({ status: 'STORED' });

        const res = await detectBrokenEvidence('tenant-1');

        expect(res.broken).toBe(0);
        expect(mockAppendAuditEntry).not.toHaveBeenCalled();
    });

    it('emits EVIDENCE_BROKEN_DETECTED audit per broken row', async () => {
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([
            { id: 'ev-1', title: 'A', fileRecordId: null },
            { id: 'ev-2', title: 'B', fileRecordId: 'fr-x' },
        ]);
        (mockDb.fileRecord.findUnique as jest.Mock).mockResolvedValue(null);

        await detectBrokenEvidence('tenant-1');

        expect(mockAppendAuditEntry).toHaveBeenCalledTimes(2);
        const first = mockAppendAuditEntry.mock.calls[0][0];
        expect(first.action).toBe('EVIDENCE_BROKEN_DETECTED');
        expect(first.actorType).toBe('JOB');
    });
});
