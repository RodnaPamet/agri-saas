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
 *
 * The GRC teardown left exactly ONE drill-down surface: overdue
 * evidence. The practices drill-down (`getNonPerformingPractices`)
 * and the risk-register drill-down (`getCriticalRisksAcrossOrg`)
 * are both deleted, so every fan-out assertion above is now made
 * against `getOverdueEvidenceAcrossOrg` — which routes through the
 * SAME `fanOutPerTenant` + `checkAuditorFanOutIntegrity` helpers
 * the deleted usecases did, and therefore carries the identical
 * regression class.
 */

const tenantFindManyMock = jest.fn();
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
            // Only `evidence` is stubbed: the practice + risk delegates
            // this fake DB used to carry belonged to drill-downs the GRC
            // teardown deleted. Leaving them would let a future test
            // "pass" against a model no usecase reads any more.
            const fakeDb = {
                evidence: { findMany: evidenceFindManyMock },
            };
            return callback(fakeDb);
        }),
    };
});

import { getOverdueEvidenceAcrossOrg } from '@/app-layer/usecases/portfolio';
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

// ── Per-tenant fan-out shape ──────────────────────────────────────────
//
// These four cases were originally written against
// `getNonPerformingPractices`. Their subject is not the practices
// query — it is `fanOutPerTenant`: one `withTenantDb` per org tenant,
// correct tenantId per call, tenant attribution stamped onto every
// merged row, and the merged list capped. All of that survives on the
// evidence drill-down, so they are re-pointed rather than deleted.

describe('getOverdueEvidenceAcrossOrg fan-out', () => {
    it('returns empty for an org with no tenants (no withTenantDb calls)', async () => {
        tenantFindManyMock.mockResolvedValue([]);

        const rows = await getOverdueEvidenceAcrossOrg(ctxFor());

        expect(rows).toEqual([]);
        expect(withTenantDbCalls).toHaveLength(0);
        expect(evidenceFindManyMock).not.toHaveBeenCalled();
    });

    it('iterates every org tenant inside withTenantDb', async () => {
        tenantFindManyMock.mockResolvedValue([tenantA, tenantB, tenantC]);
        evidenceFindManyMock.mockResolvedValue([]);

        await getOverdueEvidenceAcrossOrg(ctxFor());

        expect(withTenantDbCalls).toEqual(['t-a', 't-b', 't-c']);
        expect(evidenceFindManyMock).toHaveBeenCalledTimes(3);
    });

    it('enriches every row with tenant attribution + drill-down URL', async () => {
        tenantFindManyMock.mockResolvedValue([tenantA, tenantB]);
        const threeDaysAgo = new Date(Date.now() - 3 * 86400_000);
        const fourDaysAgo = new Date(Date.now() - 4 * 86400_000);
        evidenceFindManyMock
            .mockResolvedValueOnce([
                {
                    id: 'ev-a1',
                    title: 'Soil sample log',
                    nextReviewDate: threeDaysAgo,
                    status: 'SUBMITTED',
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 'ev-b1',
                    title: 'Spray application record',
                    nextReviewDate: fourDaysAgo,
                    status: 'DRAFT',
                },
            ]);

        const rows = await getOverdueEvidenceAcrossOrg(ctxFor());

        expect(rows).toHaveLength(2);
        const a = rows.find((r) => r.tenantId === 't-a')!;
        expect(a.tenantSlug).toBe('alpha');
        expect(a.tenantName).toBe('Alpha Co');
        expect(a.drillDownUrl).toBe('/t/alpha/evidence/ev-a1');
        expect(a.title).toBe('Soil sample log');
        expect(a.status).toBe('SUBMITTED');
        expect(a.nextReviewDate).toBe(threeDaysAgo.toISOString().slice(0, 10));

        const b = rows.find((r) => r.tenantId === 't-b')!;
        expect(b.tenantSlug).toBe('beta');
        expect(b.tenantName).toBe('Beta Co');
        expect(b.drillDownUrl).toBe('/t/beta/evidence/ev-b1');
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
            evidenceFindManyMock.mockResolvedValueOnce(
                Array.from({ length: 20 }, (_, j) => ({
                    id: `ev-${i}-${j}`,
                    title: `E${i}-${j}`,
                    nextReviewDate: new Date(Date.now() - (j + 1) * 86400_000),
                    status: 'SUBMITTED',
                })),
            );
        }

        const rows = await getOverdueEvidenceAcrossOrg(ctxFor());
        expect(rows).toHaveLength(50);
    });
});

// The practices drill-down had two further cases that do NOT transfer,
// and are deleted rather than hollowed out:
//
//   * "filters non-applicable + soft-deleted practices at the WHERE
//     clause" — asserted `applicability: 'APPLICABLE'` and
//     `status.notIn: ['IMPLEMENTED', 'NOT_APPLICABLE']` on a query the
//     teardown removed. The equivalent WHERE-clause lockdown for the
//     surviving surface is the first case in the describe block below.
//   * "sorts by status priority (NEEDS_REVIEW > NOT_STARTED >
//     IN_PROGRESS), then most-recent first" — its subject was
//     `CONTROL_STATUS_PRIORITY` / `statusesAtOrBelow`, deleted with the
//     usecase. Evidence sorts on `daysOverdue`, already asserted below.

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

describe('drill-down canViewPortfolio gate', () => {
    it('refuses the drill-down when canViewPortfolio is false', async () => {
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

        await expect(getOverdueEvidenceAcrossOrg(ctx)).rejects.toMatchObject({ status: 403 });

        // The org tenant lookup must NOT be reached when the gate fails —
        // a denied caller produces zero data-plane queries.
        expect(tenantFindManyMock).not.toHaveBeenCalled();
        expect(withTenantDbCalls).toHaveLength(0);
    });
});

// ── Schema-level lockdown of the drill-down rows ─────────────────────

describe('drill-down DTO schemas', () => {
    it('OverdueEvidenceRowSchema rejects APPROVED status and zero/negative daysOverdue', async () => {
        const { OverdueEvidenceRowSchema } = await import('@/app-layer/schemas/portfolio');
        const base = {
            evidenceId: 'e-1',
            tenantId: 't-a',
            tenantSlug: 'alpha',
            tenantName: 'Alpha Co',
            title: 'E1',
            nextReviewDate: '2026-04-20',
            drillDownUrl: '/t/alpha/evidence/e-1',
        };
        expect(() => OverdueEvidenceRowSchema.parse({ ...base, status: 'APPROVED', daysOverdue: 5 })).toThrow();
        expect(() => OverdueEvidenceRowSchema.parse({ ...base, status: 'SUBMITTED', daysOverdue: 0 })).toThrow();
        expect(() => OverdueEvidenceRowSchema.parse({ ...base, status: 'SUBMITTED', daysOverdue: 5 })).not.toThrow();
    });
});
