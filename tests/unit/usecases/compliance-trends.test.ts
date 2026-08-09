/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks +
 * fakeDb shims mirror runtime Prisma contracts; per-line typing has
 * poor cost/benefit in test files (codebase convention). */
/**
 * Unit tests for src/app-layer/usecases/compliance-trends.ts
 *
 * `getComplianceTrends` powers the executive dashboard time-series.
 * The branches worth protecting:
 *
 *   - the read-permission gate,
 *   - the `days` clamp — Math.min(Math.max(days, 1), 365) — both
 *     ends: a 0/negative request floors to 1, an overshoot ceils to
 *     365. A clamp regression either crashes the query or floods the
 *     dashboard with a 10-year scan.
 *   - the snapshot → DTO conversion, including the `controlCoverageBps
 *     / 10` basis-points-to-percent maths.
 *   - `daysAvailable` reflecting the ACTUAL row count, which can be
 *     lower than `daysRequested` when snapshots are missing.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

import { getComplianceTrends } from '@/app-layer/usecases/compliance-trends';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;

beforeEach(() => {
    jest.clearAllMocks();
});

function snapshotRow(overrides: Record<string, any> = {}) {
    return {
        snapshotDate: new Date('2026-05-10T00:00:00.000Z'),
        controlCoverageBps: 925, // 92.5%
        controlsImplemented: 37,
        controlsApplicable: 40,
        evidenceOverdue: 2,
        evidenceDueSoon7d: 4,
        evidenceCurrent: 30,
        policiesTotal: 18,
        policiesOverdueReview: 1,
        tasksOpen: 9,
        tasksOverdue: 2,
        assetsTotal: 42,
        assetsActive: 30,
        assetsHighCriticality: 8,
        assetsRetired: 12,
        findingsOpen: 3,
        ...overrides,
    };
}

function fakeDb(rows: any[]) {
    return {
        complianceSnapshot: { findMany: jest.fn().mockResolvedValue(rows) },
    };
}

describe('getComplianceTrends', () => {
    it('rejects a caller without read permission before any query', async () => {
        const ctx = makeRequestContext('READER', {
            permissions: {
                canRead: false,
                canWrite: false,
                canAdmin: false,
                canAudit: false,
                canExport: false,
            },
        });
        await expect(getComplianceTrends(ctx)).rejects.toThrow(/permission/i);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('converts a snapshot row to a chart DTO with bps→percent maths', async () => {
        const db = fakeDb([snapshotRow()]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const payload = await getComplianceTrends(makeRequestContext('EDITOR'));

        expect(payload.dataPoints).toHaveLength(1);
        const dp = payload.dataPoints[0];
        // 925 bps / 10 → 92.5 %
        expect(dp.controlCoveragePercent).toBe(92.5);
        expect(dp.date).toBe('2026-05-10');
        expect(dp.controlsImplemented).toBe(37);
        expect(dp.findingsOpen).toBe(3);
        // asset KPI series — backs the Assets-page sparklines
        expect(dp.assetsTotal).toBe(42);
        expect(dp.assetsActive).toBe(30);
        expect(dp.assetsHighCriticality).toBe(8);
        expect(dp.assetsRetired).toBe(12);
    });

    it('defaults to 90 days when no argument is supplied', async () => {
        const db = fakeDb([]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const payload = await getComplianceTrends(makeRequestContext('EDITOR'));

        expect(payload.daysRequested).toBe(90);
    });

    it('floors a zero/negative days request up to 1 (lower clamp bound)', async () => {
        const db = fakeDb([]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const payload = await getComplianceTrends(makeRequestContext('EDITOR'), 0);

        expect(payload.daysRequested).toBe(1);
    });

    it('ceils an over-large days request down to 365 (upper clamp bound)', async () => {
        const db = fakeDb([]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const payload = await getComplianceTrends(makeRequestContext('EDITOR'), 100000);

        expect(payload.daysRequested).toBe(365);
    });

    it('reports daysAvailable as the actual row count, not the requested span', async () => {
        // 30 days requested but only 2 snapshots exist.
        const db = fakeDb([
            snapshotRow({ snapshotDate: new Date('2026-05-09T00:00:00.000Z') }),
            snapshotRow({ snapshotDate: new Date('2026-05-10T00:00:00.000Z') }),
        ]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const payload = await getComplianceTrends(makeRequestContext('EDITOR'), 30);

        expect(payload.daysRequested).toBe(30);
        expect(payload.daysAvailable).toBe(2);
        expect(payload.dataPoints).toHaveLength(2);
    });

    it('returns an empty data set with valid range bounds when no snapshots exist', async () => {
        const db = fakeDb([]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const payload = await getComplianceTrends(makeRequestContext('EDITOR'), 7);

        expect(payload.dataPoints).toEqual([]);
        expect(payload.daysAvailable).toBe(0);
        // range bounds are still valid ISO strings
        expect(() => new Date(payload.rangeStart).toISOString()).not.toThrow();
        expect(new Date(payload.rangeEnd).getTime()).toBeGreaterThan(
            new Date(payload.rangeStart).getTime(),
        );
    });

    it('scopes the query to the caller tenant and orders snapshots oldest-first', async () => {
        const db = fakeDb([]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await getComplianceTrends(makeRequestContext('EDITOR'), 14);

        const queryArg = db.complianceSnapshot.findMany.mock.calls[0][0];
        expect(queryArg.where.tenantId).toBe('tenant-1');
        expect(queryArg.orderBy).toEqual({ snapshotDate: 'asc' });
        expect(queryArg.where.snapshotDate).toHaveProperty('gte');
        expect(queryArg.where.snapshotDate).toHaveProperty('lte');
    });
});
