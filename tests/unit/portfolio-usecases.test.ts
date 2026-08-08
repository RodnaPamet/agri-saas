/**
 * Epic O-3 — portfolio aggregation usecase tests.
 *
 * Covers the three usecases plus the underlying repository's
 * mocked-Prisma branching:
 *
 *   * empty-state shapes (no tenants, no snapshots)
 *   * mixed-state aggregation (some snapshotted + some pending)
 *   * RAG bucket counts derived from per-tenant coverage / criticals /
 *     overdue
 *   * trend aggregation reconstructs coverage % from the implemented /
 *     applicable sums (NOT averaged across tenants)
 *   * canViewPortfolio gate refuses callers who somehow reached the
 *     usecase without the permission flag
 *
 * Mocks Prisma at the module boundary so the test exercises only the
 * usecase + repository layers. Live-DB integration is the API route's
 * responsibility (not in this prompt's scope).
 */

const tenantFindManyMock = jest.fn();
const complianceSnapshotFindManyMock = jest.fn();
const complianceSnapshotGroupByMock = jest.fn();

jest.mock('@/lib/prisma', () => {
    const client = {
        tenant: { findMany: (...a: unknown[]) => tenantFindManyMock(...a) },
        complianceSnapshot: {
            findMany: (...a: unknown[]) => complianceSnapshotFindManyMock(...a),
            groupBy: (...a: unknown[]) => complianceSnapshotGroupByMock(...a),
        },
    };
    return { __esModule: true, default: client, prisma: client };
});

import {
    getPortfolioSummary,
    getPortfolioTenantHealth,
    getPortfolioTrends,
} from '@/app-layer/usecases/portfolio';
import type { OrgContext } from '@/app-layer/types';

// ── Test fixtures ────────────────────────────────────────────────────

function ctxFor(overrides: Partial<OrgContext> = {}): OrgContext {
    return {
        requestId: 'req-test',
        userId: 'user-1',
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
        ...overrides,
    };
}

function readerCtx(): OrgContext {
    return ctxFor({
        orgRole: 'ORG_READER',
        permissions: {
            canViewPortfolio: true,
            canDrillDown: false,
            canExportReports: true,
            canManageTenants: false,
            canManageMembers: false,
            canConfigureDashboard: false,
        },
    });
}

function makeSnapshot(
    tenantId: string,
    overrides: Partial<{
        snapshotDate: Date;
        controlsApplicable: number;
        controlsImplemented: number;
        controlCoverageBps: number;
        risksOpen: number;
        risksCritical: number;
        risksHigh: number;
        risksTotal: number;
        evidenceOverdue: number;
        evidenceTotal: number;
        evidenceDueSoon7d: number;
        policiesTotal: number;
        policiesOverdueReview: number;
        tasksOpen: number;
        tasksOverdue: number;
        findingsOpen: number;
    }> = {},
) {
    return {
        id: `snap-${tenantId}`,
        tenantId,
        snapshotDate: overrides.snapshotDate ?? new Date('2026-04-26'),
        controlsTotal: 100,
        controlsApplicable: overrides.controlsApplicable ?? 100,
        controlsImplemented: overrides.controlsImplemented ?? 90,
        controlsInProgress: 5,
        controlsNotStarted: 5,
        controlCoverageBps: overrides.controlCoverageBps ?? 900, // 90.0%
        risksMitigating: 1,
        risksAccepted: 2,
        risksClosed: 3,
        risksLow: 5,
        risksMedium: 3,
        evidenceTotal: overrides.evidenceTotal ?? 50,
        evidenceOverdue: overrides.evidenceOverdue ?? 0,
        evidenceDueSoon7d: overrides.evidenceDueSoon7d ?? 0,
        evidenceDueSoon30d: 0,
        evidenceCurrent: 50,
        policiesTotal: overrides.policiesTotal ?? 5,
        policiesPublished: 5,
        policiesOverdueReview: overrides.policiesOverdueReview ?? 0,
        tasksTotal: 20,
        tasksOpen: overrides.tasksOpen ?? 5,
        tasksOverdue: overrides.tasksOverdue ?? 0,
        vendorsTotal: 0,
        vendorsOverdueReview: 0,
        findingsOpen: overrides.findingsOpen ?? 0,
        createdAt: new Date(),
    };
}

beforeEach(() => {
    tenantFindManyMock.mockReset();
    complianceSnapshotFindManyMock.mockReset();
    complianceSnapshotGroupByMock.mockReset();
});

// ── getPortfolioSummary ──────────────────────────────────────────────

describe('getPortfolioSummary', () => {
    it('returns zeros + empty rag bucket for an org with no tenants', async () => {
        tenantFindManyMock.mockResolvedValue([]);
        complianceSnapshotFindManyMock.mockResolvedValue([]);

        const summary = await getPortfolioSummary(ctxFor());

        expect(summary.tenants).toEqual({ total: 0, snapshotted: 0, pending: 0 });
        expect(summary.controls.coveragePercent).toBe(0);
        expect(summary.rag).toEqual({ green: 0, amber: 0, red: 0, pending: 0 });
        expect(summary.organizationId).toBe('org-1');
        expect(summary.organizationSlug).toBe('acme-org');
    });

    it('counts pending tenants when no snapshot exists yet', async () => {
        tenantFindManyMock.mockResolvedValue([
            { id: 't-1', slug: 'a', name: 'Alpha' },
            { id: 't-2', slug: 'b', name: 'Beta' },
        ]);
        complianceSnapshotFindManyMock.mockResolvedValue([]);

        const summary = await getPortfolioSummary(ctxFor());

        expect(summary.tenants).toEqual({ total: 2, snapshotted: 0, pending: 2 });
        expect(summary.rag).toEqual({ green: 0, amber: 0, red: 0, pending: 2 });
        expect(summary.controls.applicable).toBe(0);
    });

    it('aggregates totals + RAG buckets across mixed-state tenants', async () => {
        tenantFindManyMock.mockResolvedValue([
            { id: 't-green', slug: 'g', name: 'Green Co' },
            { id: 't-amber', slug: 'a', name: 'Amber Co' },
            { id: 't-red',   slug: 'r', name: 'Red Co' },
            { id: 't-pending', slug: 'p', name: 'Pending Co' },
        ]);
        complianceSnapshotFindManyMock.mockResolvedValue([
            // GREEN: cov=95%, no criticals, no overdue
            makeSnapshot('t-green', {
                controlsApplicable: 100, controlsImplemented: 95,
                controlCoverageBps: 950, evidenceOverdue: 0,
            }),
            // AMBER: cov=70%, no criticals, no overdue
            makeSnapshot('t-amber', {
                controlsApplicable: 100, controlsImplemented: 70,
                controlCoverageBps: 700, evidenceOverdue: 0,
            }),
            // RED: cov=50%, no criticals, no overdue
            makeSnapshot('t-red', {
                controlsApplicable: 100, controlsImplemented: 50,
                controlCoverageBps: 500, evidenceOverdue: 0,
            }),
        ]);

        const summary = await getPortfolioSummary(ctxFor());

        expect(summary.tenants).toEqual({ total: 4, snapshotted: 3, pending: 1 });
        expect(summary.rag).toEqual({ green: 1, amber: 1, red: 1, pending: 1 });
        // Org-wide coverage = (95 + 70 + 50) / (100 + 100 + 100) = 71.667…%
        expect(summary.controls.applicable).toBe(300);
        expect(summary.controls.implemented).toBe(215);
        expect(summary.controls.coveragePercent).toBeCloseTo(71.6667, 2);
    });
});

// ── getPortfolioTenantHealth ─────────────────────────────────────────

describe('getPortfolioTenantHealth', () => {
    it('emits one row per tenant with hasSnapshot=false for pending', async () => {
        tenantFindManyMock.mockResolvedValue([
            { id: 't-1', slug: 'has', name: 'Has Snapshot' },
            { id: 't-2', slug: 'pending', name: 'Pending Tenant' },
        ]);
        complianceSnapshotFindManyMock.mockResolvedValue([
            makeSnapshot('t-1', {
                controlCoverageBps: 850, risksCritical: 0,
                evidenceOverdue: 0,
            }),
        ]);

        const rows = await getPortfolioTenantHealth(ctxFor());

        expect(rows).toHaveLength(2);

        const has = rows.find((r) => r.tenantId === 't-1')!;
        expect(has.hasSnapshot).toBe(true);
        expect(has.coveragePercent).toBe(85);
        expect(has.overdueEvidence).toBe(0);
        expect(has.rag).toBe('GREEN');
        expect(has.drillDownUrl).toBe('/t/has/dashboard');

        const pending = rows.find((r) => r.tenantId === 't-2')!;
        expect(pending.hasSnapshot).toBe(false);
        expect(pending.coveragePercent).toBeNull();
        expect(pending.rag).toBeNull();
        expect(pending.drillDownUrl).toBe('/t/pending/dashboard');
    });

    it('drill-down URL uses the slug, not the id', async () => {
        tenantFindManyMock.mockResolvedValue([
            { id: 'cuid-abc-123', slug: 'pretty-slug', name: 'Pretty' },
        ]);
        complianceSnapshotFindManyMock.mockResolvedValue([
            makeSnapshot('cuid-abc-123'),
        ]);

        const [row] = await getPortfolioTenantHealth(ctxFor());
        expect(row.drillDownUrl).toBe('/t/pretty-slug/dashboard');
        expect(row.drillDownUrl).not.toContain('cuid-abc-123');
    });
});

// ── getPortfolioTrends ───────────────────────────────────────────────

describe('getPortfolioTrends', () => {
    it('returns empty data points when no tenants exist', async () => {
        tenantFindManyMock.mockResolvedValue([]);

        const trend = await getPortfolioTrends(ctxFor(), 30);

        expect(trend.daysRequested).toBe(30);
        expect(trend.daysAvailable).toBe(0);
        expect(trend.tenantsAggregated).toBe(0);
        expect(trend.dataPoints).toEqual([]);
        // groupBy must NOT be called when there are zero tenants — saves a round-trip.
        expect(complianceSnapshotGroupByMock).not.toHaveBeenCalled();
    });

    it('reconstructs coverage % from implemented / applicable sums', async () => {
        tenantFindManyMock.mockResolvedValue([
            { id: 't-1', slug: 'a', name: 'Alpha' },
            { id: 't-2', slug: 'b', name: 'Beta' },
        ]);
        // Two snapshot dates, 2 tenants each, summed by groupBy.
        complianceSnapshotGroupByMock.mockResolvedValue([
            {
                snapshotDate: new Date('2026-04-25'),
                _sum: {
                    controlsApplicable: 200,
                    controlsImplemented: 150, // 75% risksOpen: 8, risksCritical: 1, risksHigh: 3,
                    evidenceOverdue: 2, evidenceDueSoon7d: 5, evidenceCurrent: 100,
                    policiesTotal: 10, policiesOverdueReview: 1,
                    tasksOpen: 12, tasksOverdue: 1,
                    findingsOpen: 3,
                },
                _count: { tenantId: 2 },
            },
            {
                snapshotDate: new Date('2026-04-26'),
                _sum: {
                    controlsApplicable: 200,
                    controlsImplemented: 170, // 85% risksOpen: 6, risksCritical: 0, risksHigh: 2,
                    evidenceOverdue: 1, evidenceDueSoon7d: 4, evidenceCurrent: 110,
                    policiesTotal: 10, policiesOverdueReview: 0,
                    tasksOpen: 10, tasksOverdue: 0,
                    findingsOpen: 2,
                },
                _count: { tenantId: 2 },
            },
        ]);

        const trend = await getPortfolioTrends(ctxFor(), 7);

        expect(trend.daysAvailable).toBe(2);
        expect(trend.tenantsAggregated).toBe(2);
        expect(trend.dataPoints[0].date).toBe('2026-04-25');
        expect(trend.dataPoints[0].controlCoveragePercent).toBe(75);
        expect(trend.dataPoints[1].date).toBe('2026-04-26');
        expect(trend.dataPoints[1].controlCoveragePercent).toBe(85);
    });

    it('caps days to 365', async () => {
        tenantFindManyMock.mockResolvedValue([{ id: 't-1', slug: 'a', name: 'A' }]);
        complianceSnapshotGroupByMock.mockResolvedValue([]);

        const trend = await getPortfolioTrends(ctxFor(), 9999);
        expect(trend.daysRequested).toBe(365);
    });

    it('clamps days to a minimum of 1', async () => {
        tenantFindManyMock.mockResolvedValue([{ id: 't-1', slug: 'a', name: 'A' }]);
        complianceSnapshotGroupByMock.mockResolvedValue([]);

        const trend = await getPortfolioTrends(ctxFor(), 0);
        expect(trend.daysRequested).toBe(1);
    });
});

// ── canViewPortfolio gate ────────────────────────────────────────────

describe('canViewPortfolio gate', () => {
    it('refuses when canViewPortfolio is false', async () => {
        const ctx = ctxFor({
            permissions: {
                canViewPortfolio: false,
                canDrillDown: false,
                canExportReports: false,
                canManageTenants: false,
                canManageMembers: false,
            canConfigureDashboard: false,
            },
        });

        await expect(getPortfolioSummary(ctx)).rejects.toMatchObject({ status: 403 });
        await expect(getPortfolioTenantHealth(ctx)).rejects.toMatchObject({ status: 403 });
        await expect(getPortfolioTrends(ctx, 30)).rejects.toMatchObject({ status: 403 });
    });

    it('allows ORG_READER (canViewPortfolio = true; canDrillDown = false is for tenant-side)', async () => {
        tenantFindManyMock.mockResolvedValue([]);
        complianceSnapshotFindManyMock.mockResolvedValue([]);

        await expect(getPortfolioSummary(readerCtx())).resolves.toBeDefined();
    });
});
