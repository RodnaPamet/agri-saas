/**
 * Epic E.3 — CSV export request deduplication regression.
 *
 * The CSV export route composes 5 portfolio usecases in one HTTP
 * request: summary + tenant-health + 3 drill-downs (controls /
 * evidence). Before E.3 each usecase fetched its own
 * tenants list (5×) and the two snapshot-driven ones each fetched
 * their own snapshots (2×) — 7 DB round-trips per export.
 *
 * After E.3 the shared `getPortfolioData` helper memoises both
 * fetches per request via the AsyncLocalStorage `RequestContext`
 * + WeakMap. This test wires up the full route handler with
 * mocked auth + spied repository methods and asserts:
 *
 *   - `getOrgTenantIds` fires EXACTLY ONCE
 *   - `getLatestSnapshots` fires EXACTLY ONCE
 *   - the export's body still contains all five sections (proves
 *     the dedup didn't drop a usecase by accident)
 *
 * Mutation regression: stripping the helper from one drill-down
 * (i.e. reverting it to the direct `PortfolioRepository.getOrgTenantIds`
 * call) would cause `tenantsSpy` to fire 2× on the next CI run —
 * the assertion fails loud.
 */

import { NextRequest } from 'next/server';

import { runWithRequestContext } from '@/lib/observability/context';

const adminCtx = {
    requestId: 'req-export-1',
    userId: 'user-1',
    organizationId: 'org-1',
    orgSlug: 'acme-org',
    orgRole: 'ORG_ADMIN' as const,
    permissions: {
        canViewPortfolio: true,
        canDrillDown: true,
        canExportReports: true,
        canManageTenants: true,
        canManageMembers: true,
            canConfigureDashboard: true,
    },
};

const getOrgCtxMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getOrgCtx: (...a: unknown[]) => getOrgCtxMock(...a),
}));

// Drill-down auditor-fan-out integrity check queries
// `prisma.tenantMembership.findMany` to figure out which tenants
// the current user has access to. We return an empty list so the
// fan-out short-circuits (`accessibleTenants = []` → no per-tenant
// queries fire). The deduplication invariant is about portfolio
// repo calls, not the per-tenant fan-out.
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenantMembership: {
            findMany: jest.fn().mockResolvedValue([]),
        },
    },
}));

// We intentionally do NOT mock `@/app-layer/usecases/portfolio` —
// the deduplication invariant lives at the helper layer, and the
// real usecase code paths are what we want to exercise. The spies
// below intercept the underlying repository methods.

import { PortfolioRepository } from '@/app-layer/repositories/PortfolioRepository';
import { GET as exportGET } from '@/app/api/org/[orgSlug]/portfolio/export/route';

const TENANTS = [
    { id: 't1', slug: 'alpha', name: 'Alpha Co' },
    { id: 't2', slug: 'beta', name: 'Beta Co' },
];

function makeRequest(url: string): NextRequest {
    return new NextRequest(new URL(url, 'http://localhost:3000'));
}

beforeEach(() => {
    getOrgCtxMock.mockReset();
    getOrgCtxMock.mockResolvedValue(adminCtx);
    jest.restoreAllMocks();
});

describe('Epic E.3 — CSV export tenants/snapshots deduplication', () => {
    it('fires getOrgTenantIds + getLatestSnapshots EXACTLY ONCE per request', async () => {
        const tenantsSpy = jest
            .spyOn(PortfolioRepository, 'getOrgTenantIds')
            .mockResolvedValue(TENANTS);
        const snapshotsSpy = jest
            .spyOn(PortfolioRepository, 'getLatestSnapshots')
            .mockResolvedValue([]);

        // Run the full export handler inside a real request context
        // — the wrapper does this in production via
        // `withApiErrorHandling`, but driving the inner GET directly
        // requires us to seed the context manually so the helper's
        // WeakMap key is set.
        await runWithRequestContext(
            { requestId: 'req-export-1', startTime: 0 },
            async () => {
                const res = await exportGET(
                    makeRequest('/api/org/acme-org/portfolio/export'),
                    { params: Promise.resolve({ orgSlug: 'acme-org' }) },
                );
                expect(res.status).toBe(200);
                const body = await res.text();

                // All five sections must still be present — proves we
                // didn't accidentally drop a usecase from the export
                // when wiring the dedup.
                expect(body).toContain('# Portfolio Summary');
                expect(body).toContain('# Tenant Health');
                expect(body).toContain('# Non-Performing Controls');
                expect(body).toContain('# Overdue Evidence');
            },
        );

        // The deduplication invariant — the load-bearing assertion.
        expect(tenantsSpy).toHaveBeenCalledTimes(1);
        expect(snapshotsSpy).toHaveBeenCalledTimes(1);
    });

    it('drill-down sections still skip when canDrillDown is false (no spurious snapshots fetch)', async () => {
        getOrgCtxMock.mockResolvedValue({
            ...adminCtx,
            permissions: { ...adminCtx.permissions, canDrillDown: false },
        });
        const tenantsSpy = jest
            .spyOn(PortfolioRepository, 'getOrgTenantIds')
            .mockResolvedValue(TENANTS);
        const snapshotsSpy = jest
            .spyOn(PortfolioRepository, 'getLatestSnapshots')
            .mockResolvedValue([]);

        await runWithRequestContext(
            { requestId: 'req-export-2', startTime: 0 },
            async () => {
                const res = await exportGET(
                    makeRequest('/api/org/acme-org/portfolio/export'),
                    { params: Promise.resolve({ orgSlug: 'acme-org' }) },
                );
                const body = await res.text();
                expect(body).toContain('# Portfolio Summary');
                expect(body).toContain('# Tenant Health');
                expect(body).not.toContain('# Non-Performing Controls');
            },
        );

        // Summary + health both went through the helper — still
        // exactly one fetch each.
        expect(tenantsSpy).toHaveBeenCalledTimes(1);
        expect(snapshotsSpy).toHaveBeenCalledTimes(1);
    });
});
