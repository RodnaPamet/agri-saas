/**
 * Portfolio overview orchestrator — single-fetch contract.
 *
 * Mocks `PortfolioRepository` at the module boundary and asserts
 * that:
 *
 *   1. `getPortfolioOverview` calls each repository fetch EXACTLY ONCE
 *      regardless of how many DTOs it projects (no per-DTO refetch).
 *   2. Summary + tenant health are projected from the same shared
 *      base data as the standalone usecases — same behaviour, fewer
 *      queries.
 *   3. Trends run in parallel with the snapshots fetch (one
 *      `Promise.all` after the tenant list resolves).
 *   4. Empty-org and partial-snapshot edge cases produce the same
 *      DTO shapes the standalone usecases produced.
 *
 * Companion to `tests/unit/portfolio-schemas.test.ts` (DTO shape) and
 * `tests/unit/portfolio-usecases.test.ts` (usecase business logic).
 * The dedicated DB-backed test for the new orchestrator lives at
 * `tests/integration/portfolio-overview-orchestrator.test.ts`.
 */

const getOrgTenantIdsMock = jest.fn();
const getLatestSnapshotsMock = jest.fn();
const getSnapshotTrendsMock = jest.fn();

jest.mock('@/app-layer/repositories/PortfolioRepository', () => ({
    __esModule: true,
    PortfolioRepository: {
        getOrgTenantIds: (...a: unknown[]) => getOrgTenantIdsMock(...a),
        getLatestSnapshots: (...a: unknown[]) => getLatestSnapshotsMock(...a),
        getSnapshotTrends: (...a: unknown[]) => getSnapshotTrendsMock(...a),
    },
}));

import {
    getPortfolioOverview,
    getPortfolioSummary,
    getPortfolioTenantHealth,
    getPortfolioTrends,
} from '@/app-layer/usecases/portfolio';
import type { OrgContext } from '@/app-layer/types';

function ctxFor(): OrgContext {
    return {
        requestId: 'req-test',
        userId: 'caller-1',
        organizationId: 'org-1',
        orgSlug: 'acme-org',
        orgRole: 'ORG_ADMIN',
        permissions: {
            canViewPortfolio: true,
            canDrillDown: true,
            canExportReports: true,
            canManageTenants: true,
            canManageMembers: true,
            canConfigureDashboard: true,
        },
    };
}

const TENANTS = [
    { id: 't-1', slug: 'alpha', name: 'Alpha' },
    { id: 't-2', slug: 'beta', name: 'Beta' },
];

function snapshotFixture(tenantId: string) {
    return {
        id: `snap-${tenantId}`,
        tenantId,
        snapshotDate: new Date('2026-04-25T00:00:00Z'),
        practicesApplicable: 100,
        practicesImplemented: 80,
        // bpsToPercent divides by 10, so 800 represents 80%.
        practiceCoverageBps: 800,
        risksTotal: 10,
        risksOpen: 5,
        risksCritical: 1,
        risksHigh: 2,
        evidenceTotal: 50,
        evidenceOverdue: 3,
        evidenceDueSoon7d: 4,
        policiesTotal: 12,
        policiesOverdueReview: 1,
        tasksOpen: 8,
        tasksOverdue: 2,
        findingsOpen: 1,
    };
}

beforeEach(() => {
    getOrgTenantIdsMock.mockReset();
    getLatestSnapshotsMock.mockReset();
    getSnapshotTrendsMock.mockReset();
});

// ── Single-fetch invariant ────────────────────────────────────────────

describe('getPortfolioOverview — single-fetch invariant', () => {
    it('calls each repository fetch EXACTLY ONCE for the orchestrated overview', async () => {
        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        getLatestSnapshotsMock.mockResolvedValue([
            snapshotFixture('t-1'),
            snapshotFixture('t-2'),
        ]);
        getSnapshotTrendsMock.mockResolvedValue([]);

        await getPortfolioOverview(ctxFor());

        // The load-bearing assertion — base data fetched ONCE even
        // though both summary and tenant-health are projected from it.
        expect(getOrgTenantIdsMock).toHaveBeenCalledTimes(1);
        expect(getLatestSnapshotsMock).toHaveBeenCalledTimes(1);
        expect(getSnapshotTrendsMock).toHaveBeenCalledTimes(1);

        // Snapshot + trends queries both receive the same tenantId list.
        expect(getLatestSnapshotsMock).toHaveBeenCalledWith(['t-1', 't-2']);
        expect(getSnapshotTrendsMock).toHaveBeenCalledWith(['t-1', 't-2'], 90);
    });

    it('parallel snapshots + trends fetch — no serial dependency between them', async () => {
        // The orchestrator awaits the tenant list first, then runs
        // snapshots + trends concurrently. Verify by capturing their
        // call invocation order: both should fire before EITHER resolves.
        let snapshotResolve: ((v: unknown) => void) | undefined;
        let trendsResolve: ((v: unknown) => void) | undefined;
        const snapshotPromise = new Promise((r) => {
            snapshotResolve = r;
        });
        const trendsPromise = new Promise((r) => {
            trendsResolve = r;
        });

        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        getLatestSnapshotsMock.mockReturnValue(snapshotPromise);
        getSnapshotTrendsMock.mockReturnValue(trendsPromise);

        const overviewPromise = getPortfolioOverview(ctxFor());

        // Yield once so the orchestrator can await tenants and kick
        // off the parallel fetches.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        // BOTH fetches must have started before either resolved.
        expect(getLatestSnapshotsMock).toHaveBeenCalled();
        expect(getSnapshotTrendsMock).toHaveBeenCalled();

        // Resolve them and let the orchestrator finish.
        snapshotResolve!([snapshotFixture('t-1'), snapshotFixture('t-2')]);
        trendsResolve!([]);
        await overviewPromise;
    });

    it('respects trendDays override (clamped to [1, 365])', async () => {
        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        getLatestSnapshotsMock.mockResolvedValue([]);
        getSnapshotTrendsMock.mockResolvedValue([]);

        await getPortfolioOverview(ctxFor(), { trendDays: 30 });
        expect(getSnapshotTrendsMock).toHaveBeenCalledWith(['t-1', 't-2'], 30);

        getSnapshotTrendsMock.mockClear();
        await getPortfolioOverview(ctxFor(), { trendDays: 9999 });
        expect(getSnapshotTrendsMock).toHaveBeenCalledWith(['t-1', 't-2'], 365);

        getSnapshotTrendsMock.mockClear();
        await getPortfolioOverview(ctxFor(), { trendDays: 0 });
        expect(getSnapshotTrendsMock).toHaveBeenCalledWith(['t-1', 't-2'], 1);
    });
});

// ── Behaviour parity with standalone usecases ────────────────────────

describe('getPortfolioOverview — behaviour parity with standalone usecases', () => {
    it('summary + tenantHealth match what the standalone usecases produce', async () => {
        // Run the orchestrator first.
        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        getLatestSnapshotsMock.mockResolvedValue([
            snapshotFixture('t-1'),
            snapshotFixture('t-2'),
        ]);
        getSnapshotTrendsMock.mockResolvedValue([]);
        const overview = await getPortfolioOverview(ctxFor());

        // Reset and run each standalone usecase.
        getOrgTenantIdsMock.mockReset();
        getLatestSnapshotsMock.mockReset();
        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        getLatestSnapshotsMock.mockResolvedValue([
            snapshotFixture('t-1'),
            snapshotFixture('t-2'),
        ]);
        const standaloneSummary = await getPortfolioSummary(ctxFor());

        getOrgTenantIdsMock.mockReset();
        getLatestSnapshotsMock.mockReset();
        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        getLatestSnapshotsMock.mockResolvedValue([
            snapshotFixture('t-1'),
            snapshotFixture('t-2'),
        ]);
        const standaloneHealth = await getPortfolioTenantHealth(ctxFor());

        // Shapes match (modulo `generatedAt` which is a fresh
        // timestamp on every invocation — strip it for comparison).
        const stripGeneratedAt = (s: typeof standaloneSummary) => ({
            ...s,
            generatedAt: 'IGNORED',
        });
        expect(stripGeneratedAt(overview.summary)).toEqual(
            stripGeneratedAt(standaloneSummary),
        );
        expect(overview.tenantHealth).toEqual(standaloneHealth);
    });
});

// ── Edge cases ───────────────────────────────────────────────────────

describe('getPortfolioOverview — edge cases', () => {
    it('empty org → empty results across all three DTOs', async () => {
        getOrgTenantIdsMock.mockResolvedValue([]);
        getLatestSnapshotsMock.mockResolvedValue([]);
        getSnapshotTrendsMock.mockResolvedValue([]);

        const overview = await getPortfolioOverview(ctxFor());

        // Snapshots query gets called with an empty tenant list — the
        // shared loader doesn't short-circuit (the repo handles
        // empty input).
        expect(getLatestSnapshotsMock).toHaveBeenCalledWith([]);
        expect(getSnapshotTrendsMock).toHaveBeenCalledWith([], 90);

        expect(overview.summary.tenants.total).toBe(0);
        expect(overview.summary.tenants.snapshotted).toBe(0);
        expect(overview.summary.tenants.pending).toBe(0);
        expect(overview.summary.rag).toEqual({ green: 0, amber: 0, red: 0, pending: 0 });
        expect(overview.tenantHealth).toEqual([]);
        expect(overview.trends.dataPoints).toEqual([]);
    });

    it('partial snapshot availability — pending tenants surface in summary + tenantHealth', async () => {
        // Only one of the two tenants has a snapshot.
        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        getLatestSnapshotsMock.mockResolvedValue([snapshotFixture('t-1')]);
        getSnapshotTrendsMock.mockResolvedValue([]);

        const overview = await getPortfolioOverview(ctxFor());

        expect(overview.summary.tenants.total).toBe(2);
        expect(overview.summary.tenants.snapshotted).toBe(1);
        expect(overview.summary.tenants.pending).toBe(1);
        expect(overview.summary.rag.pending).toBe(1);

        // Pending tenant in tenantHealth has nullable metric fields.
        const pendingRow = overview.tenantHealth.find((r) => r.tenantId === 't-2');
        expect(pendingRow).toBeDefined();
        expect(pendingRow!.hasSnapshot).toBe(false);
        expect(pendingRow!.coveragePercent).toBeNull();
        expect(pendingRow!.rag).toBeNull();

        // Snapshotted tenant has populated metrics.
        const snapshottedRow = overview.tenantHealth.find((r) => r.tenantId === 't-1');
        expect(snapshottedRow!.hasSnapshot).toBe(true);
        expect(snapshottedRow!.coveragePercent).toBe(80);
    });

    it('throws forbidden when canViewPortfolio is false', async () => {
        const denied = ctxFor();
        denied.permissions.canViewPortfolio = false;

        await expect(getPortfolioOverview(denied)).rejects.toMatchObject({
            status: 403,
        });
        // No DB calls when the gate refuses.
        expect(getOrgTenantIdsMock).not.toHaveBeenCalled();
    });
});

// ── Standalone usecases preserve their existing behaviour ────────────

describe('standalone usecases — backward compatibility', () => {
    it('getPortfolioTrends still works in isolation', async () => {
        getOrgTenantIdsMock.mockResolvedValue(TENANTS);
        getSnapshotTrendsMock.mockResolvedValue([]);

        const trends = await getPortfolioTrends(ctxFor(), 30);
        expect(trends.daysRequested).toBe(30);
        // Each standalone usecase still does its own fetch — no
        // regression for the API route's per-view dispatch.
        expect(getOrgTenantIdsMock).toHaveBeenCalledTimes(1);
        expect(getSnapshotTrendsMock).toHaveBeenCalledWith(['t-1', 't-2'], 30);
    });
});
