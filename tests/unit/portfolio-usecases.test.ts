/**
 * Epic O-3 — portfolio aggregation usecase tests.
 *
 * Covers the three snapshot-driven usecases plus the underlying
 * repository's mocked-Prisma branching:
 *
 *   * empty-state shapes (no tenants, no snapshots)
 *   * mixed-state aggregation (some snapshotted + some pending)
 *   * RAG bucket counts derived from per-tenant overdue evidence
 *   * trend aggregation sums the evidence + task columns per
 *     snapshotDate (summed across tenants, NOT averaged)
 *   * canViewPortfolio gate refuses callers who somehow reached the
 *     usecase without the permission flag
 *
 * GRC teardown phase 2 (plan §8f): the `practices` / `policies` /
 * `findings` blocks left `PortfolioSummary`, `coveragePercent` left
 * `TenantHealthRow`, and the reconstructed coverage % left
 * `PortfolioTrendDataPoint` — all with their models. The assertions
 * that used to read them now assert the surviving evidence + task
 * aggregates, which are computed by the same code paths. The fixtures
 * below supply ONLY columns something still reads: a fixture that keeps
 * feeding a deleted shape is exactly how a stale read stays green.
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

// Only the ComplianceSnapshot columns the surviving projections read.
// The practice / policy / vendor / finding columns still exist on the
// model until the phase-3 migration, but nothing computes or reads them
// any more, so the fixture no longer supplies them — and the risk
// columns it used to set (risksMitigating / risksAccepted / …) left the
// model with the risk register before this teardown began.
function makeSnapshot(
    tenantId: string,
    overrides: Partial<{
        snapshotDate: Date;
        evidenceTotal: number;
        evidenceOverdue: number;
        evidenceDueSoon7d: number;
        tasksOpen: number;
        tasksOverdue: number;
    }> = {},
) {
    return {
        id: `snap-${tenantId}`,
        tenantId,
        snapshotDate: overrides.snapshotDate ?? new Date('2026-04-26'),
        evidenceTotal: overrides.evidenceTotal ?? 50,
        evidenceOverdue: overrides.evidenceOverdue ?? 0,
        evidenceDueSoon7d: overrides.evidenceDueSoon7d ?? 0,
        evidenceDueSoon30d: 0,
        evidenceCurrent: 50,
        tasksTotal: 20,
        tasksOpen: overrides.tasksOpen ?? 5,
        tasksOverdue: overrides.tasksOverdue ?? 0,
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
        expect(summary.evidence).toEqual({ total: 0, overdue: 0, dueSoon7d: 0 });
        expect(summary.tasks).toEqual({ open: 0, overdue: 0 });
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
        // Tenants with no snapshot contribute nothing to the metric
        // aggregates — they're counted as pending, not as measured zeros.
        expect(summary.evidence).toEqual({ total: 0, overdue: 0, dueSoon7d: 0 });
    });

    it('aggregates totals + RAG buckets across mixed-state tenants', async () => {
        tenantFindManyMock.mockResolvedValue([
            { id: 't-green', slug: 'g', name: 'Green Co' },
            { id: 't-amber', slug: 'a', name: 'Amber Co' },
            { id: 't-red',   slug: 'r', name: 'Red Co' },
            { id: 't-pending', slug: 'p', name: 'Pending Co' },
        ]);
        // RAG is driven by overdue EVIDENCE now, not practice coverage —
        // see computeRag's docblock and plan §8f. The fixture drives the
        // three buckets through the axis that still exists.
        complianceSnapshotFindManyMock.mockResolvedValue([
            // GREEN: nothing overdue.
            makeSnapshot('t-green', { evidenceOverdue: 0 }),
            // AMBER: 1–9 overdue.
            makeSnapshot('t-amber', { evidenceOverdue: 3 }),
            // RED: 10 or more overdue.
            makeSnapshot('t-red', { evidenceOverdue: 14 }),
        ]);

        const summary = await getPortfolioSummary(ctxFor());

        expect(summary.tenants).toEqual({ total: 4, snapshotted: 3, pending: 1 });
        expect(summary.rag).toEqual({ green: 1, amber: 1, red: 1, pending: 1 });
        // Sums span the three snapshotted tenants only (3 × the fixture
        // defaults); the pending tenant adds nothing.
        expect(summary.evidence.total).toBe(150);
        expect(summary.evidence.overdue).toBe(17);
        expect(summary.tasks).toEqual({ open: 15, overdue: 0 });
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
            makeSnapshot('t-1', { evidenceOverdue: 0 }),
        ]);

        const rows = await getPortfolioTenantHealth(ctxFor());

        expect(rows).toHaveLength(2);

        const has = rows.find((r) => r.tenantId === 't-1')!;
        expect(has.hasSnapshot).toBe(true);
        expect(has.snapshotDate).toBe('2026-04-26');
        expect(has.overdueEvidence).toBe(0);
        expect(has.rag).toBe('GREEN');
        expect(has.drillDownUrl).toBe('/t/has/dashboard');

        // The metric fields are NULL — not 0 — for a tenant with no
        // snapshot, so the UI renders "pending" rather than a clean bill
        // of health. `coveragePercent` used to carry the same assertion;
        // it left the DTO with the practice models, and `overdueEvidence`
        // is the surviving nullable metric that proves the same rule.
        const pending = rows.find((r) => r.tenantId === 't-2')!;
        expect(pending.hasSnapshot).toBe(false);
        expect(pending.snapshotDate).toBeNull();
        expect(pending.overdueEvidence).toBeNull();
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

    it('carries the evidence + task sums through, one data point per snapshot date', async () => {
        tenantFindManyMock.mockResolvedValue([
            { id: 't-1', slug: 'a', name: 'Alpha' },
            { id: 't-2', slug: 'b', name: 'Beta' },
        ]);
        // Two snapshot dates, 2 tenants each, summed by groupBy. The
        // practice / policy / finding sums this fixture used to carry went
        // with the columns the repository stopped requesting (plan §8f).
        complianceSnapshotGroupByMock.mockResolvedValue([
            {
                snapshotDate: new Date('2026-04-25'),
                _sum: {
                    evidenceOverdue: 2, evidenceDueSoon7d: 5, evidenceCurrent: 100,
                    tasksOpen: 12, tasksOverdue: 1,
                },
                _count: { tenantId: 2 },
            },
            {
                snapshotDate: new Date('2026-04-26'),
                _sum: {
                    evidenceOverdue: 1, evidenceDueSoon7d: 4, evidenceCurrent: 110,
                    tasksOpen: 10, tasksOverdue: 0,
                },
                _count: { tenantId: 2 },
            },
        ]);

        const trend = await getPortfolioTrends(ctxFor(), 7);

        expect(trend.daysAvailable).toBe(2);
        expect(trend.tenantsAggregated).toBe(2);
        // Whole-object equality (not field-by-field): it pins the sums AND
        // proves no practice / policy / finding key is reintroduced into
        // the data point, which is what the old
        // `not.toHaveProperty('practiceCoveragePercent')` line reached for.
        expect(trend.dataPoints[0]).toEqual({
            date: '2026-04-25',
            evidenceOverdue: 2,
            evidenceDueSoon7d: 5,
            evidenceCurrent: 100,
            tasksOpen: 12,
            tasksOverdue: 1,
        });
        expect(trend.dataPoints[1]).toEqual({
            date: '2026-04-26',
            evidenceOverdue: 1,
            evidenceDueSoon7d: 4,
            evidenceCurrent: 110,
            tasksOpen: 10,
            tasksOverdue: 0,
        });
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
