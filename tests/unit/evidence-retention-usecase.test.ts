/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks
 * mirror runtime Prisma contracts; per-line typing has poor cost/
 * benefit ratio in test files (standard pattern, see
 * tests/unit/evidence-usecase.test.ts). */

/**
 * Unit tests for `src/app-layer/usecases/evidence-retention.ts`.
 *
 * Roadmap Q1 — Evidence + files. Mocks Prisma db, `logEvent`,
 * `runInTenantContext`, and the retention-sweep job. Exercises:
 *
 *   - `updateEvidenceRetention` — DAYS_AFTER_UPLOAD computed
 *     retentionUntil (the only non-trivial branch); patch-shaped
 *     three-state inputs; audit event shape; notFound; RBAC.
 *   - `listExpiringEvidence` / `listExpiredEvidence` — query shape +
 *     RBAC (read gate, not admin).
 *   - `archiveEvidence` / `unarchiveEvidence` — idempotency (no
 *     write when already-in-state), audit, notFound, RBAC.
 *   - `runRetentionSweepUsecase` — admin gate + dryRun forwarding to
 *     the job runner.
 *   - `getRetentionMetrics` — three counts + top-controls aggregation
 *     (the dedup + sort + slice).
 *   - `assertNotArchived` — gate semantics + notFound.
 */

const mockDb = {
    evidence: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
    },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/app-layer/jobs/retention', () => ({
    runEvidenceRetentionSweep: jest.fn(),
}));

import { logEvent } from '@/app-layer/events/audit';
import { runEvidenceRetentionSweep } from '@/app-layer/jobs/retention';
import {
    updateEvidenceRetention,
    listExpiringEvidence,
    listExpiredEvidence,
    archiveEvidence,
    unarchiveEvidence,
    runRetentionSweepUsecase,
    getRetentionMetrics,
    assertNotArchived,
} from '@/app-layer/usecases/evidence-retention';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const adminCtx = makeRequestContext('ADMIN');
const editorCtx = makeRequestContext('EDITOR');
const readerCtx = makeRequestContext('READER');
const auditorCtx = makeRequestContext('AUDITOR');

// ─── updateEvidenceRetention ──────────────────────────────────────

describe('updateEvidenceRetention', () => {
    it('throws notFound when the evidence row does not exist', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(updateEvidenceRetention(editorCtx, 'missing', { retentionUntil: null }))
            .rejects.toThrow(/Evidence not found/i);
    });

    it('rejects READER (write gate)', async () => {
        await expect(updateEvidenceRetention(readerCtx, 'ev-1', { retentionUntil: null }))
            .rejects.toBeDefined();
        expect(mockDb.evidence.findFirst).not.toHaveBeenCalled();
    });

    it('writes a literal retentionUntil when the policy is FIXED_DATE-shaped', async () => {
        const createdAt = new Date('2026-01-01T00:00:00Z');
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue({
            id: 'ev-1', createdAt, retentionPolicy: null, retentionDays: null,
        });
        (mockDb.evidence.update as jest.Mock).mockResolvedValue({ id: 'ev-1' });

        await updateEvidenceRetention(editorCtx, 'ev-1', {
            retentionUntil: '2027-06-01T00:00:00Z',
        });

        const data = (mockDb.evidence.update as jest.Mock).mock.calls[0][0].data;
        expect(data.retentionUntil).toEqual(new Date('2027-06-01T00:00:00Z'));
    });

    it('clears retentionUntil when passed null', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue({
            id: 'ev-1', createdAt: new Date(), retentionPolicy: null, retentionDays: null,
        });
        (mockDb.evidence.update as jest.Mock).mockResolvedValue({ id: 'ev-1' });

        await updateEvidenceRetention(editorCtx, 'ev-1', { retentionUntil: null });

        const data = (mockDb.evidence.update as jest.Mock).mock.calls[0][0].data;
        expect(data.retentionUntil).toBeNull();
    });

    it('computes retentionUntil from createdAt + days when policy is DAYS_AFTER_UPLOAD', async () => {
        const createdAt = new Date('2026-01-01T00:00:00Z');
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue({
            id: 'ev-1', createdAt, retentionPolicy: null, retentionDays: null,
        });
        (mockDb.evidence.update as jest.Mock).mockResolvedValue({ id: 'ev-1' });

        await updateEvidenceRetention(editorCtx, 'ev-1', {
            retentionPolicy: 'DAYS_AFTER_UPLOAD',
            retentionDays: 30,
        });

        const data = (mockDb.evidence.update as jest.Mock).mock.calls[0][0].data;
        // 30 days after 2026-01-01 = 2026-01-31
        expect(data.retentionUntil).toEqual(new Date('2026-01-31T00:00:00Z'));
        expect(data.retentionPolicy).toBe('DAYS_AFTER_UPLOAD');
        expect(data.retentionDays).toBe(30);
    });

    it('keeps DAYS_AFTER_UPLOAD computation when only retentionDays changes (existing policy)', async () => {
        const createdAt = new Date('2026-01-01T00:00:00Z');
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue({
            id: 'ev-1', createdAt, retentionPolicy: 'DAYS_AFTER_UPLOAD', retentionDays: 30,
        });
        (mockDb.evidence.update as jest.Mock).mockResolvedValue({ id: 'ev-1' });

        await updateEvidenceRetention(editorCtx, 'ev-1', { retentionDays: 90 });

        const data = (mockDb.evidence.update as jest.Mock).mock.calls[0][0].data;
        expect(data.retentionUntil).toEqual(new Date('2026-04-01T00:00:00Z'));
    });

    it('emits an EVIDENCE_RETENTION_UPDATED audit event', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue({
            id: 'ev-1', createdAt: new Date(), retentionPolicy: null, retentionDays: null,
        });
        (mockDb.evidence.update as jest.Mock).mockResolvedValue({ id: 'ev-1' });
        await updateEvidenceRetention(editorCtx, 'ev-1', { retentionUntil: '2027-06-01T00:00:00Z' });

        expect(logEvent).toHaveBeenCalledTimes(1);
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('EVIDENCE_RETENTION_UPDATED');
        expect(payload.entityType).toBe('Evidence');
        expect(payload.detailsJson.category).toBe('data_lifecycle');
        expect(payload.detailsJson.operation).toBe('retention_updated');
    });
});

// ─── listExpiringEvidence / listExpiredEvidence ────────────────────

describe('listExpiringEvidence', () => {
    it('returns rows from the repository under the read gate', async () => {
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([{ id: 'ev-1' }]);
        const rows = await listExpiringEvidence(readerCtx);
        expect(rows).toEqual([{ id: 'ev-1' }]);
    });

    it('queries with retentionUntil <= now + days, !isArchived, deletedAt null', async () => {
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([]);
        const before = Date.now();
        await listExpiringEvidence(readerCtx, 30);
        const args = (mockDb.evidence.findMany as jest.Mock).mock.calls[0][0];
        expect(args.where.isArchived).toBe(false);
        expect(args.where.deletedAt).toBeNull();
        expect(args.where.retentionUntil).toMatchObject({ not: null });
        // The cap is ~30 days in the future from "now"
        const lte = args.where.retentionUntil.lte as Date;
        const delta = lte.getTime() - before;
        const thirtyDays = 30 * 86_400_000;
        // Allow ±1s slack for test runtime
        expect(delta).toBeGreaterThan(thirtyDays - 5_000);
        expect(delta).toBeLessThan(thirtyDays + 5_000);
    });

    it('defaults to 30 days when no value supplied', async () => {
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([]);
        const before = Date.now();
        await listExpiringEvidence(readerCtx);
        const args = (mockDb.evidence.findMany as jest.Mock).mock.calls[0][0];
        const lte = args.where.retentionUntil.lte as Date;
        const delta = lte.getTime() - before;
        const thirtyDays = 30 * 86_400_000;
        expect(delta).toBeGreaterThan(thirtyDays - 5_000);
        expect(delta).toBeLessThan(thirtyDays + 5_000);
    });

    it('orders by retentionUntil ascending (soonest-expiring first)', async () => {
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([]);
        await listExpiringEvidence(readerCtx, 30);
        const args = (mockDb.evidence.findMany as jest.Mock).mock.calls[0][0];
        expect(args.orderBy).toEqual({ retentionUntil: 'asc' });
    });
});

describe('listExpiredEvidence', () => {
    it('returns rows with expiredAt set, ordered desc', async () => {
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([{ id: 'ev-1' }]);
        const rows = await listExpiredEvidence(readerCtx);
        expect(rows).toEqual([{ id: 'ev-1' }]);
        const args = (mockDb.evidence.findMany as jest.Mock).mock.calls[0][0];
        expect(args.where.expiredAt).toEqual({ not: null });
        expect(args.where.deletedAt).toBeNull();
        expect(args.orderBy).toEqual({ expiredAt: 'desc' });
    });
});

// ─── archiveEvidence ──────────────────────────────────────────────

describe('archiveEvidence', () => {
    it('archives a non-archived row and emits an audit', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue({ id: 'ev-1', title: 'X', isArchived: false });
        (mockDb.evidence.update as jest.Mock).mockResolvedValue({ id: 'ev-1', isArchived: true });

        const res = await archiveEvidence(editorCtx, 'ev-1');

        expect(res).toEqual({ id: 'ev-1', isArchived: true });
        expect(mockDb.evidence.update).toHaveBeenCalledWith({
            where: { id: 'ev-1' },
            data: { isArchived: true },
        });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('EVIDENCE_ARCHIVED');
    });

    it('is idempotent when already archived (no write, no audit)', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue({ id: 'ev-1', title: 'X', isArchived: true });

        const res = await archiveEvidence(editorCtx, 'ev-1');

        expect(res).toEqual({ id: 'ev-1', title: 'X', isArchived: true });
        expect(mockDb.evidence.update).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('throws notFound when the row does not exist', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(archiveEvidence(editorCtx, 'missing')).rejects.toThrow(/Evidence not found/i);
    });

    it('rejects READER (write gate)', async () => {
        await expect(archiveEvidence(readerCtx, 'ev-1')).rejects.toBeDefined();
        expect(mockDb.evidence.findFirst).not.toHaveBeenCalled();
    });
});

// ─── unarchiveEvidence ────────────────────────────────────────────

describe('unarchiveEvidence', () => {
    it('unarchives an archived row and emits an audit', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue({ id: 'ev-1', title: 'X', isArchived: true });
        (mockDb.evidence.update as jest.Mock).mockResolvedValue({ id: 'ev-1', isArchived: false });

        const res = await unarchiveEvidence(editorCtx, 'ev-1');

        expect(res).toEqual({ id: 'ev-1', isArchived: false });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('EVIDENCE_UNARCHIVED');
    });

    it('is idempotent when already not-archived (no write, no audit)', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue({ id: 'ev-1', title: 'X', isArchived: false });

        const res = await unarchiveEvidence(editorCtx, 'ev-1');

        expect(res).toEqual({ id: 'ev-1', title: 'X', isArchived: false });
        expect(mockDb.evidence.update).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('throws notFound when the row does not exist', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(unarchiveEvidence(editorCtx, 'missing')).rejects.toThrow(/Evidence not found/i);
    });

    it('rejects READER (write gate)', async () => {
        await expect(unarchiveEvidence(readerCtx, 'ev-1')).rejects.toBeDefined();
    });
});

// ─── runRetentionSweepUsecase ─────────────────────────────────────

describe('runRetentionSweepUsecase', () => {
    it('delegates to runEvidenceRetentionSweep with the tenantId', async () => {
        (runEvidenceRetentionSweep as jest.Mock).mockResolvedValue({ archived: 3, expired: 1 });
        const res = await runRetentionSweepUsecase(adminCtx);
        expect(res).toEqual({ archived: 3, expired: 1 });
        expect(runEvidenceRetentionSweep).toHaveBeenCalledWith({
            tenantId: adminCtx.tenantId,
            dryRun: undefined,
        });
    });

    it('forwards the dryRun flag', async () => {
        (runEvidenceRetentionSweep as jest.Mock).mockResolvedValue({});
        await runRetentionSweepUsecase(adminCtx, { dryRun: true });
        expect(runEvidenceRetentionSweep).toHaveBeenCalledWith({
            tenantId: adminCtx.tenantId,
            dryRun: true,
        });
    });

    it('rejects EDITOR (admin gate)', async () => {
        await expect(runRetentionSweepUsecase(editorCtx)).rejects.toBeDefined();
        expect(runEvidenceRetentionSweep).not.toHaveBeenCalled();
    });

    it('rejects READER (admin gate)', async () => {
        await expect(runRetentionSweepUsecase(readerCtx)).rejects.toBeDefined();
    });
});

// ─── getRetentionMetrics ──────────────────────────────────────────

describe('getRetentionMetrics', () => {
    it('returns expiring + archived + expired counts plus top-controls aggregation', async () => {
        (mockDb.evidence.count as jest.Mock)
            .mockResolvedValueOnce(5)   // expiringCount
            .mockResolvedValueOnce(2)   // archivedCount
            .mockResolvedValueOnce(1);  // expiredCount
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([
            { controlId: 'c-1', control: { id: 'c-1', name: 'Access control', code: 'A.5' } },
            { controlId: 'c-1', control: { id: 'c-1', name: 'Access control', code: 'A.5' } },
            { controlId: 'c-2', control: { id: 'c-2', name: 'Backups', code: 'A.8' } },
        ]);

        const res = await getRetentionMetrics(readerCtx);

        expect(res.expiringCount).toBe(5);
        expect(res.archivedCount).toBe(2);
        expect(res.expiredCount).toBe(1);
        expect(res.topControlsWithExpiringEvidence).toEqual([
            { controlId: 'c-1', name: 'Access control', code: 'A.5', count: 2 },
            { controlId: 'c-2', name: 'Backups', code: 'A.8', count: 1 },
        ]);
    });

    it('drops rows whose controlId is null from the top-controls aggregation', async () => {
        (mockDb.evidence.count as jest.Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([
            { controlId: null, control: null },
        ]);
        const res = await getRetentionMetrics(readerCtx);
        expect(res.topControlsWithExpiringEvidence).toEqual([]);
    });

    it('caps the leaderboard at 10 entries', async () => {
        (mockDb.evidence.count as jest.Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
        const rows = [];
        for (let i = 0; i < 15; i++) {
            rows.push({ controlId: `c-${i}`, control: { id: `c-${i}`, name: `n${i}`, code: '' } });
        }
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue(rows);
        const res = await getRetentionMetrics(readerCtx);
        expect(res.topControlsWithExpiringEvidence).toHaveLength(10);
    });

    it('handles missing control relation with Unknown fallback', async () => {
        (mockDb.evidence.count as jest.Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([
            { controlId: 'c-orphan', control: null },
        ]);
        const res = await getRetentionMetrics(readerCtx);
        expect(res.topControlsWithExpiringEvidence[0].name).toBe('Unknown');
    });
});

// ─── assertNotArchived ────────────────────────────────────────────

describe('assertNotArchived', () => {
    it('returns the evidence row when not archived', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue({ id: 'ev-1', isArchived: false });
        const res = await assertNotArchived(adminCtx, 'ev-1');
        expect(res).toEqual({ id: 'ev-1', isArchived: false });
    });

    it('throws notFound when the row does not exist', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(assertNotArchived(adminCtx, 'missing')).rejects.toThrow(/Evidence not found/i);
    });

    it('throws badRequest when the row is archived', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue({ id: 'ev-1', isArchived: true });
        await expect(assertNotArchived(adminCtx, 'ev-1')).rejects.toThrow(/Cannot link archived evidence/i);
    });

    // assertNotArchived is intentionally not RBAC-gated — callers
    // (e.g. control linking) are gated themselves at their own
    // boundary. This is a documented sentinel — pinning behaviour.
    it('is reachable from any role context (callers gate themselves)', async () => {
        (mockDb.evidence.findFirst as jest.Mock).mockResolvedValue({ id: 'ev-1', isArchived: false });
        await expect(assertNotArchived(auditorCtx, 'ev-1')).resolves.toBeDefined();
        await expect(assertNotArchived(readerCtx, 'ev-1')).resolves.toBeDefined();
    });
});
