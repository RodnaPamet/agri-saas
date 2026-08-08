/**
 * Compliance Snapshot & Trends — Unit Tests
 *
 * Verifies:
 * 1. Snapshot date normalization (toSnapshotDate)
 * 2. Snapshot generation writes correct data shape
 * 3. Idempotency — re-run for same day uses upsert
 * 4. Trend retrieval returns ordered data
 * 5. Tenant scoping is preserved
 * 6. Edge cases — empty datasets, date clamping
 * 7. Job registration in scheduler
 */

// ─── Mocks ───

const mockUpsert = jest.fn();
const mockFindMany = jest.fn();
const mockFindingCount = jest.fn();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTx: Record<string, any> = {};

jest.mock('@/lib/db-context', () => ({
    withTenantDb: jest.fn(async (_tenantId: string, fn: (db: unknown) => unknown) => {
        return fn(mockTx);
    }),
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => {
        return fn(mockTx);
    }),
}));

jest.mock('@/lib/prisma', () => ({
    prisma: {
        tenant: {
            findMany: jest.fn(async () => [
                { id: 'tenant-1' },
                { id: 'tenant-2' },
            ]),
        },
    },
}));

jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

import { toSnapshotDate, runSnapshotJob } from '@/app-layer/jobs/snapshot';
import { getComplianceTrends } from '@/app-layer/usecases/compliance-trends';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
    return {
        requestId: 'req-test',
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
        ...overrides,
    };
}

function setupDashboardMocks() {
    mockTx.control = {
        groupBy: jest.fn(async () => [
            { status: 'IMPLEMENTED', _count: 10 },
            { status: 'NOT_STARTED', _count: 5 },
        ]),
        count: jest.fn(async () => 17),
    };
    mockTx.risk = {
        count: jest.fn(async () => 3),
        groupBy: jest.fn(async () => [
            { status: 'OPEN', _count: 5 },
            { status: 'CLOSED', _count: 2 },
        ]),
    };
    mockTx.evidence = {
        count: jest.fn(async () => 20),
    };
    mockTx.policy = {
        groupBy: jest.fn(async () => [
            { status: 'PUBLISHED', _count: 4 },
            { status: 'DRAFT', _count: 2 },
        ]),
        count: jest.fn(async () => 1),
    };
    mockTx.task = {
        groupBy: jest.fn(async () => [
            { status: 'OPEN', _count: 3 },
            { status: 'IN_PROGRESS', _count: 2 },
        ]),
        count: jest.fn(async () => 1),
    };
    mockTx.vendor = {
        count: jest.fn(async () => 5),
    };
    mockTx.asset = {
        // getAssetSummary issues 4 counts (total/active/highCriticality/retired).
        // A single fixed return is enough to assert the fields are wired.
        count: jest.fn(async () => 7),
    };
    mockTx.finding = {
        count: jest.fn(async () => 4),
    };
    mockTx.complianceSnapshot = {
        upsert: mockUpsert,
        findMany: mockFindMany,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockTx).forEach(k => delete mockTx[k]);
    mockUpsert.mockReset();
    mockFindMany.mockReset();
    mockFindingCount.mockReset();
});

// ─── toSnapshotDate ───

describe('toSnapshotDate', () => {
    it('normalizes to UTC midnight', () => {
        const d = new Date('2026-04-18T15:30:00Z');
        const result = toSnapshotDate(d);

        expect(result.getUTCHours()).toBe(0);
        expect(result.getUTCMinutes()).toBe(0);
        expect(result.getUTCSeconds()).toBe(0);
        expect(result.getUTCMilliseconds()).toBe(0);
        expect(result.getUTCFullYear()).toBe(2026);
        expect(result.getUTCMonth()).toBe(3); // April = 3
        expect(result.getUTCDate()).toBe(18);
    });

    it('uses current date when no argument provided', () => {
        const result = toSnapshotDate();
        const now = new Date();

        expect(result.getUTCFullYear()).toBe(now.getUTCFullYear());
        expect(result.getUTCMonth()).toBe(now.getUTCMonth());
        expect(result.getUTCDate()).toBe(now.getUTCDate());
        expect(result.getUTCHours()).toBe(0);
    });

    it('handles midnight edge case', () => {
        const d = new Date('2026-04-18T00:00:00Z');
        const result = toSnapshotDate(d);

        expect(result.getUTCDate()).toBe(18);
    });

    it('handles end of day', () => {
        const d = new Date('2026-04-18T23:59:59.999Z');
        const result = toSnapshotDate(d);

        expect(result.getUTCDate()).toBe(18);
    });
});

// ─── Snapshot Job ───

describe('Snapshot Job', () => {
    it('calls upsert for each tenant', async () => {
        setupDashboardMocks();
        mockUpsert.mockResolvedValue({});

        const { snapshotCount } = await runSnapshotJob({ tenantId: 'tenant-1' });

        expect(snapshotCount).toBe(1);
        expect(mockUpsert).toHaveBeenCalledTimes(1);
    });

    it('upsert uses tenantId_snapshotDate composite key (idempotent)', async () => {
        setupDashboardMocks();
        mockUpsert.mockResolvedValue({});

        const testDate = new Date('2026-04-18T00:00:00Z');
        await runSnapshotJob({ tenantId: 'tenant-1', date: testDate });

        const upsertCall = mockUpsert.mock.calls[0][0];
        expect(upsertCall.where).toHaveProperty('tenantId_snapshotDate');
        expect(upsertCall.where.tenantId_snapshotDate.tenantId).toBe('tenant-1');
    });

    it('stores control coverage BPS correctly', async () => {
        setupDashboardMocks();
        mockUpsert.mockResolvedValue({});

        await runSnapshotJob({ tenantId: 'tenant-1' });

        const upsertCall = mockUpsert.mock.calls[0][0];
        // 10 implemented / 15 applicable = 66.7% → BPS = 667
        expect(upsertCall.create.controlCoverageBps).toBe(667);
        expect(upsertCall.create.controlsImplemented).toBe(10);
    });

    it('stores the asset KPI buckets', async () => {
        setupDashboardMocks();
        mockUpsert.mockResolvedValue({});

        await runSnapshotJob({ tenantId: 'tenant-1' });

        const upsertCall = mockUpsert.mock.calls[0][0];
        expect(upsertCall.create).toMatchObject({
            assetsTotal: 7,
            assetsActive: 7,
            assetsHighCriticality: 7,
            assetsRetired: 7,
        });
        // mirrored into update so re-runs overwrite (idempotent upsert)
        expect(upsertCall.update).toHaveProperty('assetsTotal', 7);
    });

    it('result reports success with correct counts', async () => {
        setupDashboardMocks();
        mockUpsert.mockResolvedValue({});

        const { result, snapshotCount } = await runSnapshotJob({ tenantId: 'tenant-1' });

        expect(result.success).toBe(true);
        expect(result.jobName).toBe('compliance-snapshot');
        expect(result.itemsScanned).toBe(1);
        expect(result.itemsActioned).toBe(1);
        expect(snapshotCount).toBe(1);
    });

    it('re-running for same day uses upsert (idempotent)', async () => {
        setupDashboardMocks();
        mockUpsert.mockResolvedValue({});

        const date = new Date('2026-04-18T00:00:00Z');

        // Run twice for the same date
        await runSnapshotJob({ tenantId: 'tenant-1', date });
        await runSnapshotJob({ tenantId: 'tenant-1', date });

        // Both calls should use upsert (not create)
        expect(mockUpsert).toHaveBeenCalledTimes(2);
        // Both should target the same snapshotDate
        const call1 = mockUpsert.mock.calls[0][0].where.tenantId_snapshotDate;
        const call2 = mockUpsert.mock.calls[1][0].where.tenantId_snapshotDate;
        expect(call1.tenantId).toEqual(call2.tenantId);
    });

    it('handles errors in one tenant without aborting', async () => {
        setupDashboardMocks();
        // First call succeeds, second fails — but for single-tenant test, just test error path
        mockUpsert.mockRejectedValueOnce(new Error('DB error'));

        const { result, snapshotCount } = await runSnapshotJob({ tenantId: 'tenant-1' });

        // Should report the error gracefully
        expect(snapshotCount).toBe(0);
        expect(result.itemsSkipped).toBe(1); // errored tenant
    });
});

// ─── Trend Retrieval ───

describe('Compliance Trends', () => {
    it('returns ordered data points', async () => {
        mockTx.complianceSnapshot = {
            findMany: jest.fn(async () => [
                { snapshotDate: new Date('2026-04-16'), controlCoverageBps: 700, controlsImplemented: 7, controlsApplicable: 10, risksTotal: 5, risksOpen: 3, risksCritical: 1, risksHigh: 2, evidenceOverdue: 1, evidenceDueSoon7d: 2, evidenceCurrent: 10, policiesTotal: 4, policiesOverdueReview: 0, tasksOpen: 3, tasksOverdue: 1, findingsOpen: 2 },
                { snapshotDate: new Date('2026-04-17'), controlCoverageBps: 750, controlsImplemented: 8, controlsApplicable: 10, risksTotal: 5, risksOpen: 2, risksCritical: 1, risksHigh: 1, evidenceOverdue: 0, evidenceDueSoon7d: 1, evidenceCurrent: 12, policiesTotal: 4, policiesOverdueReview: 0, tasksOpen: 2, tasksOverdue: 0, findingsOpen: 1 },
            ]),
        };

        const result = await getComplianceTrends(makeCtx(), 90);

        expect(result.daysRequested).toBe(90);
        expect(result.daysAvailable).toBe(2);
        expect(result.dataPoints).toHaveLength(2);
        expect(result.dataPoints[0].date).toBe('2026-04-16');
        expect(result.dataPoints[1].date).toBe('2026-04-17');
    });

    it('converts BPS to percentage correctly', async () => {
        mockTx.complianceSnapshot = {
            findMany: jest.fn(async () => [
                { snapshotDate: new Date('2026-04-18'), controlCoverageBps: 753, controlsImplemented: 8, controlsApplicable: 10, risksTotal: 0, risksOpen: 0, risksCritical: 0, risksHigh: 0, evidenceOverdue: 0, evidenceDueSoon7d: 0, evidenceCurrent: 0, policiesTotal: 0, policiesOverdueReview: 0, tasksOpen: 0, tasksOverdue: 0, findingsOpen: 0 },
            ]),
        };

        const result = await getComplianceTrends(makeCtx(), 30);

        expect(result.dataPoints[0].controlCoveragePercent).toBe(75.3);
    });

    it('returns empty array for no snapshots', async () => {
        mockTx.complianceSnapshot = {
            findMany: jest.fn(async () => []),
        };

        const result = await getComplianceTrends(makeCtx(), 90);

        expect(result.daysAvailable).toBe(0);
        expect(result.dataPoints).toEqual([]);
    });

    it('clamps days to max 365', async () => {
        mockTx.complianceSnapshot = {
            findMany: jest.fn(async () => []),
        };

        const result = await getComplianceTrends(makeCtx(), 999);

        expect(result.daysRequested).toBe(365);
    });

    it('clamps days to min 1', async () => {
        mockTx.complianceSnapshot = {
            findMany: jest.fn(async () => []),
        };

        const result = await getComplianceTrends(makeCtx(), 0);

        expect(result.daysRequested).toBe(1);
    });

    it('tenant scoping passes tenantId to query', async () => {
        mockTx.complianceSnapshot = {
            findMany: jest.fn(async () => []),
        };

        await getComplianceTrends(makeCtx({ tenantId: 'tenant-xyz' }), 30);

        const query = mockTx.complianceSnapshot.findMany.mock.calls[0][0];
        expect(query.where.tenantId).toBe('tenant-xyz');
    });

    it('query uses snapshotDate range filter', async () => {
        mockTx.complianceSnapshot = {
            findMany: jest.fn(async () => []),
        };

        await getComplianceTrends(makeCtx(), 90);

        const query = mockTx.complianceSnapshot.findMany.mock.calls[0][0];
        expect(query.where.snapshotDate).toHaveProperty('gte');
        expect(query.where.snapshotDate).toHaveProperty('lte');
        expect(query.orderBy).toEqual({ snapshotDate: 'asc' });
    });

    it('rejects non-reader users', async () => {
        mockTx.complianceSnapshot = {
            findMany: jest.fn(async () => []),
        };

        const ctx = makeCtx({
            permissions: { canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        });

        await expect(getComplianceTrends(ctx, 30)).rejects.toThrow(/permission/i);
    });
});

// ─── Job Registration ───

describe('Snapshot Job Registration', () => {
    it('compliance-snapshot is in SCHEDULED_JOBS', () => {
        // Avoid importing executor-registry (side effects) — just check schedules
        const { SCHEDULED_JOBS } = require('@/app-layer/jobs/schedules');
        const found = SCHEDULED_JOBS.find((s: { name: string }) => s.name === 'compliance-snapshot');
        expect(found).toBeDefined();
        expect(found.pattern).toBe('0 5 * * *');
    });

    it('compliance-snapshot is in JobPayloadMap (typed)', () => {
        // Type-level check: if ComplianceSnapshotPayload is in the map,
        // the JOB_DEFAULTS entry must exist (enforced by Record<JobName, ...>)
        const { JOB_DEFAULTS } = require('@/app-layer/jobs/types');
        expect(JOB_DEFAULTS).toHaveProperty('compliance-snapshot');
    });
});
