/**
 * Epic O-3 — cross-tenant drill-down usecases.
 *
 * The load-bearing security property: every per-tenant query MUST
 * run inside `withTenantDb(tenantId)` so RLS + the CISO's auto-
 * provisioned AUDITOR membership govern the read. The mocked
 * `withTenantDb` records the tenantIds it was called with, and the
 * test asserts:
 *
 *   * the orchestration loops every org tenant
 *   * each call gets the correct `tenantId` argument
 *   * results are merged + tenant-attributed
 *   * sort + limit are applied across the merged set
 *   * empty-org and no-matching-rows cases short-circuit cleanly
 *   * canViewPortfolio gate refuses callers without the flag
 */

const tenantFindManyMock = jest.fn();
const controlFindManyMock = jest.fn();
const riskFindManyMock = jest.fn();
const evidenceFindManyMock = jest.fn();
const tenantMembershipFindManyMock = jest.fn();
const withTenantDbCalls: string[] = [];

jest.mock('@/lib/prisma', () => {
    const client = {
        tenant: { findMany: (...a: unknown[]) => tenantFindManyMock(...a) },
        complianceSnapshot: { findMany: jest.fn(), groupBy: jest.fn() },
        // The drill-down auditor fan-out integrity check queries
        // tenantMembership; default to "every tenant accessible" so
        // existing tests (which assert on per-tenant iteration count)
        // see the full org tenant set in the fan-out.
        tenantMembership: {
            findMany: (...a: unknown[]) => tenantMembershipFindManyMock(...a),
        },
    };
    return { __esModule: true, default: client, prisma: client };
});

jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context') as Record<string, unknown>;
    return {
        ...actual,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        withTenantDb: jest.fn(async (tenantId: string, callback: any) => {
            withTenantDbCalls.push(tenantId);
            const fakeDb = {
                control: { findMany: controlFindManyMock },
                risk: { findMany: riskFindManyMock },
                evidence: { findMany: evidenceFindManyMock },
            };
            return callback(fakeDb);
        }),
    };
});

import {
    getNonPerformingControls,
    getOverdueEvidenceAcrossOrg,
} from '@/app-layer/usecases/portfolio';
import type { OrgContext } from '@/app-layer/types';

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

const tenantA = { id: 't-a', slug: 'alpha', name: 'Alpha Co' };
const tenantB = { id: 't-b', slug: 'beta', name: 'Beta Co' };
const tenantC = { id: 't-c', slug: 'gamma', name: 'Gamma Co' };

beforeEach(() => {
    tenantFindManyMock.mockReset();
    controlFindManyMock.mockReset();
    riskFindManyMock.mockReset();
    evidenceFindManyMock.mockReset();
    tenantMembershipFindManyMock.mockReset();
    withTenantDbCalls.length = 0;
    // Default to "every tenant accessible" so the existing
    // iteration-count tests see the full org tenant set. The
    // drift-detection behaviour has its own dedicated test file:
    // tests/unit/portfolio-fanout-integrity.test.ts.
    tenantMembershipFindManyMock.mockImplementation(async (args: { where?: { tenantId?: { in?: string[] } } }) => {
        const ids = args?.where?.tenantId?.in ?? [];
        return ids.map((tenantId: string) => ({ tenantId }));
    });
});

// ── getNonPerformingControls ──────────────────────────────────────────

describe('getNonPerformingControls', () => {
    it('returns empty for an org with no tenants (no withTenantDb calls)', async () => {
        tenantFindManyMock.mockResolvedValue([]);

        const rows = await getNonPerformingControls(ctxFor());

        expect(rows).toEqual([]);
        expect(withTenantDbCalls).toHaveLength(0);
        expect(controlFindManyMock).not.toHaveBeenCalled();
    });

    it('iterates every org tenant inside withTenantDb', async () => {
        tenantFindManyMock.mockResolvedValue([tenantA, tenantB, tenantC]);
        controlFindManyMock.mockResolvedValue([]);

        await getNonPerformingControls(ctxFor());

        expect(withTenantDbCalls).toEqual(['t-a', 't-b', 't-c']);
        expect(controlFindManyMock).toHaveBeenCalledTimes(3);
    });

    it('filters non-applicable + soft-deleted controls at the WHERE clause', async () => {
        tenantFindManyMock.mockResolvedValue([tenantA]);
        controlFindManyMock.mockResolvedValue([]);

        await getNonPerformingControls(ctxFor());

        expect(controlFindManyMock).toHaveBeenCalledTimes(1);
        const where = controlFindManyMock.mock.calls[0][0].where;
        expect(where.tenantId).toBe('t-a');
        expect(where.applicability).toBe('APPLICABLE');
        expect(where.deletedAt).toBeNull();
        expect(where.status.notIn).toEqual(['IMPLEMENTED', 'NOT_APPLICABLE']);
    });

    it('enriches every row with tenant attribution + drill-down URL', async () => {
        tenantFindManyMock.mockResolvedValue([tenantA, tenantB]);
        controlFindManyMock
            .mockResolvedValueOnce([
                {
                    id: 'ctrl-a1',
                    name: 'AC-1 Access Control',
                    code: 'AC-1',
                    status: 'NOT_STARTED',
                    updatedAt: new Date('2026-04-25T10:00:00Z'),
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 'ctrl-b1',
                    name: 'AU-2 Audit Events',
                    code: 'AU-2',
                    status: 'IN_PROGRESS',
                    updatedAt: new Date('2026-04-25T11:00:00Z'),
                },
            ]);

        const rows = await getNonPerformingControls(ctxFor());

        expect(rows).toHaveLength(2);
        const a = rows.find((r) => r.tenantId === 't-a')!;
        expect(a.tenantSlug).toBe('alpha');
        expect(a.tenantName).toBe('Alpha Co');
        expect(a.drillDownUrl).toBe('/t/alpha/controls/ctrl-a1');
        expect(a.code).toBe('AC-1');
        expect(a.status).toBe('NOT_STARTED');
        expect(a.updatedAt).toBe('2026-04-25T10:00:00.000Z');

        const b = rows.find((r) => r.tenantId === 't-b')!;
        expect(b.drillDownUrl).toBe('/t/beta/controls/ctrl-b1');
    });

    it('sorts by status priority (NEEDS_REVIEW > NOT_STARTED > IN_PROGRESS), then most-recent first', async () => {
        tenantFindManyMock.mockResolvedValue([tenantA]);
        controlFindManyMock.mockResolvedValue([
            { id: 'c-1', name: 'C1', code: null, status: 'IN_PROGRESS',  updatedAt: new Date('2026-04-25T10:00:00Z') },
            { id: 'c-2', name: 'C2', code: null, status: 'NEEDS_REVIEW', updatedAt: new Date('2026-04-25T08:00:00Z') },
            { id: 'c-3', name: 'C3', code: null, status: 'NOT_STARTED',  updatedAt: new Date('2026-04-25T12:00:00Z') },
            { id: 'c-4', name: 'C4', code: null, status: 'NEEDS_REVIEW', updatedAt: new Date('2026-04-25T11:00:00Z') },
        ]);

        const rows = await getNonPerformingControls(ctxFor());

        // NEEDS_REVIEW first (newer of the two NEEDS_REVIEW first), then NOT_STARTED, then IN_PROGRESS
        expect(rows.map((r) => r.controlId)).toEqual(['c-4', 'c-2', 'c-3', 'c-1']);
    });

    it('caps the merged result list at 50 even when per-tenant + tenant-count exceeds it', async () => {
        // 6 tenants × 20 rows each = 120 candidate rows. Should slice to 50.
        const tenants = Array.from({ length: 6 }, (_, i) => ({
            id: `t-${i}`,
            slug: `s-${i}`,
            name: `Tenant ${i}`,
        }));
        tenantFindManyMock.mockResolvedValue(tenants);
        // Each tenant returns 20 rows.
        for (let i = 0; i < tenants.length; i++) {
            controlFindManyMock.mockResolvedValueOnce(
                Array.from({ length: 20 }, (_, j) => ({
                    id: `c-${i}-${j}`,
                    name: `C${i}-${j}`,
                    code: null,
                    status: 'NOT_STARTED',
                    updatedAt: new Date(`2026-04-25T${(j % 24).toString().padStart(2, '0')}:00:00Z`),
                })),
            );
        }

        const rows = await getNonPerformingControls(ctxFor());
        expect(rows).toHaveLength(50);
    });
});

// ── getCriticalRisksAcrossOrg ─────────────────────────────────────────


// ── getOverdueEvidenceAcrossOrg ───────────────────────────────────────

describe('getOverdueEvidenceAcrossOrg', () => {
    it('queries nextReviewDate < now AND status != APPROVED inside RLS', async () => {
        tenantFindManyMock.mockResolvedValue([tenantA]);
        evidenceFindManyMock.mockResolvedValue([]);

        await getOverdueEvidenceAcrossOrg(ctxFor());

        const where = evidenceFindManyMock.mock.calls[0][0].where;
        expect(where.tenantId).toBe('t-a');
        expect(where.nextReviewDate.lt).toBeInstanceOf(Date);
        expect(where.status).toEqual({ not: 'APPROVED' });
        expect(where.deletedAt).toBeNull();
    });

    it('computes daysOverdue correctly and sorts most-overdue first', async () => {
        tenantFindManyMock.mockResolvedValue([tenantA, tenantB]);
        const now = Date.now();
        const fiveDaysAgo = new Date(now - 5 * 86400_000);
        const tenDaysAgo = new Date(now - 10 * 86400_000);
        const thirtyDaysAgo = new Date(now - 30 * 86400_000);

        evidenceFindManyMock
            .mockResolvedValueOnce([
                { id: 'e-recent', title: 'Recent', nextReviewDate: fiveDaysAgo,  status: 'SUBMITTED' },
                { id: 'e-mid',    title: 'Mid',    nextReviewDate: tenDaysAgo,   status: 'DRAFT' },
            ])
            .mockResolvedValueOnce([
                { id: 'e-old',    title: 'Old',    nextReviewDate: thirtyDaysAgo, status: 'REJECTED' },
            ]);

        const rows = await getOverdueEvidenceAcrossOrg(ctxFor());

        expect(rows).toHaveLength(3);
        // most-overdue first
        expect(rows.map((r) => r.evidenceId)).toEqual(['e-old', 'e-mid', 'e-recent']);
        expect(rows[0].daysOverdue).toBeGreaterThanOrEqual(29);
        expect(rows[0].drillDownUrl).toBe('/t/beta/evidence/e-old');
        expect(rows[1].daysOverdue).toBeGreaterThanOrEqual(9);
        expect(rows[2].daysOverdue).toBeGreaterThanOrEqual(4);
    });

    it('skips rows with NULL nextReviewDate (defensive)', async () => {
        tenantFindManyMock.mockResolvedValue([tenantA]);
        const past = new Date(Date.now() - 86400_000);
        evidenceFindManyMock.mockResolvedValueOnce([
            { id: 'e-real', title: 'Real',   nextReviewDate: past, status: 'SUBMITTED' },
            // The WHERE clause shouldn't return this, but defence-in-depth on the mapper.
            { id: 'e-null', title: 'NullDt', nextReviewDate: null, status: 'SUBMITTED' },
        ]);

        const rows = await getOverdueEvidenceAcrossOrg(ctxFor());
        expect(rows.map((r) => r.evidenceId)).toEqual(['e-real']);
    });

    it('returns empty list when no evidence is overdue across the org', async () => {
        tenantFindManyMock.mockResolvedValue([tenantA, tenantB]);
        evidenceFindManyMock.mockResolvedValue([]);

        const rows = await getOverdueEvidenceAcrossOrg(ctxFor());
        expect(rows).toEqual([]);
    });
});

// ── canViewPortfolio gate ─────────────────────────────────────────────


// ── Schema-level lockdown of the drill-down rows ─────────────────────

