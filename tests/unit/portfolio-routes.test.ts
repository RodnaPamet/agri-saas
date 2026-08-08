/**
 * Epic O-3 — portfolio API routes (view dispatch + CSV export).
 *
 * Mocks the org-context resolver and the usecase layer so the test
 * exercises the route's dispatch table, query-param parsing, and the
 * permission gates without touching Prisma. The usecase-level
 * coverage lives in:
 *   * tests/unit/portfolio-schemas.test.ts
 *   * tests/unit/portfolio-usecases.test.ts
 *   * tests/unit/portfolio-drilldown.test.ts
 */

import { NextRequest } from 'next/server';

const getOrgCtxMock = jest.fn();
const getPortfolioSummaryMock = jest.fn();
const getPortfolioTenantHealthMock = jest.fn();
const getPortfolioTrendsMock = jest.fn();
const getNonPerformingControlsMock = jest.fn();
const getOverdueEvidenceAcrossOrgMock = jest.fn();
// Paginated counterparts — the drill-down API now uses these.
const listNonPerformingControlsMock = jest.fn();
const listOverdueEvidenceAcrossOrgMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getOrgCtx: (...a: unknown[]) => getOrgCtxMock(...a),
}));

jest.mock('@/app-layer/usecases/portfolio', () => ({
    __esModule: true,
    getPortfolioSummary: (...a: unknown[]) => getPortfolioSummaryMock(...a),
    getPortfolioTenantHealth: (...a: unknown[]) => getPortfolioTenantHealthMock(...a),
    getPortfolioTrends: (...a: unknown[]) => getPortfolioTrendsMock(...a),
    getNonPerformingControls: (...a: unknown[]) => getNonPerformingControlsMock(...a),
    getOverdueEvidenceAcrossOrg: (...a: unknown[]) => getOverdueEvidenceAcrossOrgMock(...a),
    listNonPerformingControls: (...a: unknown[]) => listNonPerformingControlsMock(...a),
    listOverdueEvidenceAcrossOrg: (...a: unknown[]) => listOverdueEvidenceAcrossOrgMock(...a),
}));

import { GET as viewGET } from '@/app/api/org/[orgSlug]/portfolio/route';
import { GET as exportGET } from '@/app/api/org/[orgSlug]/portfolio/export/route';

function makeRequest(url: string): NextRequest {
    return new NextRequest(new URL(url, 'http://localhost:3000'));
}

const adminCtx = {
    requestId: 'req-1',
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
const readerCtx = {
    ...adminCtx,
    orgRole: 'ORG_READER' as const,
    permissions: {
        canViewPortfolio: true,
        canDrillDown: false, // ← readers don't get auto-provisioned AUDITOR
        canExportReports: true,
        canManageTenants: false,
        canManageMembers: false,
            canConfigureDashboard: false,
    },
};

beforeEach(() => {
    getOrgCtxMock.mockReset();
    getPortfolioSummaryMock.mockReset();
    getPortfolioTenantHealthMock.mockReset();
    getPortfolioTrendsMock.mockReset();
    getNonPerformingControlsMock.mockReset();
    getOverdueEvidenceAcrossOrgMock.mockReset();
    listNonPerformingControlsMock.mockReset();
    listOverdueEvidenceAcrossOrgMock.mockReset();
});

// ── View dispatch ─────────────────────────────────────────────────────

describe('GET /api/org/[orgSlug]/portfolio', () => {
    it('rejects request with missing view query param', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);

        const res = await viewGET(
            makeRequest('/api/org/acme-org/portfolio'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(400);
    });

    it('rejects an unsupported view value', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);

        const res = await viewGET(
            makeRequest('/api/org/acme-org/portfolio?view=anything-else'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(400);
    });

    it('view=summary calls getPortfolioSummary and returns 200 JSON', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        getPortfolioSummaryMock.mockResolvedValue({ organizationId: 'org-1' });

        const res = await viewGET(
            makeRequest('/api/org/acme-org/portfolio?view=summary'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.organizationId).toBe('org-1');
        expect(getPortfolioSummaryMock).toHaveBeenCalledWith(adminCtx);
    });

    it('view=health wraps the array in a { rows } object', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        getPortfolioTenantHealthMock.mockResolvedValue([{ tenantId: 't-1' }]);

        const res = await viewGET(
            makeRequest('/api/org/acme-org/portfolio?view=health'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        const body = await res.json();
        expect(body.rows).toEqual([{ tenantId: 't-1' }]);
    });

    it('view=trends parses days param and forwards to usecase', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        getPortfolioTrendsMock.mockResolvedValue({ daysRequested: 30 });

        await viewGET(
            makeRequest('/api/org/acme-org/portfolio?view=trends&days=30'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(getPortfolioTrendsMock).toHaveBeenCalledWith(adminCtx, 30);
    });

    it('view=trends defaults to 90 days when days is omitted', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        getPortfolioTrendsMock.mockResolvedValue({ daysRequested: 90 });

        await viewGET(
            makeRequest('/api/org/acme-org/portfolio?view=trends'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(getPortfolioTrendsMock).toHaveBeenCalledWith(adminCtx, 90);
    });

    it('view=trends rejects non-numeric days', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);

        const res = await viewGET(
            makeRequest('/api/org/acme-org/portfolio?view=trends&days=abc'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(400);
    });

    it('drill-down view "controls" is allowed for ORG_ADMIN (canDrillDown=true)', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        listNonPerformingControlsMock.mockResolvedValue({
            rows: [{ controlId: 'c-1' }],
            nextCursor: null,
        });

        const res = await viewGET(
            makeRequest('/api/org/acme-org/portfolio?view=controls'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        const body = await res.json();
        expect(body.rows).toEqual([{ controlId: 'c-1' }]);
        expect(body.nextCursor).toBeNull();
    });

    it('drill-down view "controls" forwards cursor + limit query params to the usecase', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        listNonPerformingControlsMock.mockResolvedValue({
            rows: [],
            nextCursor: 'cursor-page-3',
        });

        const res = await viewGET(
            makeRequest(
                '/api/org/acme-org/portfolio?view=controls&cursor=opaque-cursor&limit=25',
            ),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(200);
        expect(listNonPerformingControlsMock).toHaveBeenCalledTimes(1);
        const args = listNonPerformingControlsMock.mock.calls[0];
        expect(args[1]).toEqual({ cursor: 'opaque-cursor', limit: 25 });

        const body = await res.json();
        expect(body.nextCursor).toBe('cursor-page-3');
    });

    it('drill-down views are blocked for ORG_READER with 403 — usecase NOT called', async () => {
        getOrgCtxMock.mockResolvedValue(readerCtx);

        for (const v of ['controls', 'evidence']) {
            const res = await viewGET(
                makeRequest(`/api/org/acme-org/portfolio?view=${v}`),
                { params: Promise.resolve({ orgSlug: 'acme-org' }) },
            );
            expect(res.status).toBe(403);
        }
        expect(listNonPerformingControlsMock).not.toHaveBeenCalled();
        expect(listOverdueEvidenceAcrossOrgMock).not.toHaveBeenCalled();
    });

    it('non-drill-down views are allowed for ORG_READER', async () => {
        getOrgCtxMock.mockResolvedValue(readerCtx);
        getPortfolioSummaryMock.mockResolvedValue({});
        getPortfolioTenantHealthMock.mockResolvedValue([]);
        getPortfolioTrendsMock.mockResolvedValue({ dataPoints: [] });

        for (const v of ['summary', 'health', 'trends']) {
            const res = await viewGET(
                makeRequest(`/api/org/acme-org/portfolio?view=${v}`),
                { params: Promise.resolve({ orgSlug: 'acme-org' }) },
            );
            expect(res.status).toBe(200);
        }
    });


    it('view=evidence routes to listOverdueEvidenceAcrossOrg with cursor', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        listOverdueEvidenceAcrossOrgMock.mockResolvedValue({
            rows: [{ evidenceId: 'e-1' }],
            nextCursor: null,
        });

        const res = await viewGET(
            makeRequest('/api/org/acme-org/portfolio?view=evidence'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        const body = await res.json();
        expect(body.rows).toEqual([{ evidenceId: 'e-1' }]);
        expect(body.nextCursor).toBeNull();
    });

    it('drill-down ignores invalid limit parameter (lenient on read)', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        listNonPerformingControlsMock.mockResolvedValue({ rows: [], nextCursor: null });

        const res = await viewGET(
            makeRequest('/api/org/acme-org/portfolio?view=controls&limit=not-a-number'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(200);
        // No `limit` key in the call args → usecase falls back to default.
        const args = listNonPerformingControlsMock.mock.calls[0];
        expect(args[1].limit).toBeUndefined();
    });
});

// ── CSV export ────────────────────────────────────────────────────────

describe('GET /api/org/[orgSlug]/portfolio/export', () => {
    function summaryFixture() {
        return {
            organizationId: 'org-1',
            organizationSlug: 'acme-org',
            generatedAt: '2026-04-26T00:00:00Z',
            tenants: { total: 2, snapshotted: 1, pending: 1 },
            controls: { applicable: 100, implemented: 75, coveragePercent: 75 },
            evidence: { total: 50, overdue: 3, dueSoon7d: 4 },
            policies: { total: 5, overdueReview: 1 },
            tasks: { open: 12, overdue: 2 },
            findings: { open: 1 },
            rag: { green: 0, amber: 1, red: 0, pending: 1 },
        };
    }
    function healthFixture() {
        return [
            {
                tenantId: 't-1',
                slug: 'alpha',
                name: 'Alpha Co',
                drillDownUrl: '/t/alpha/dashboard',
                hasSnapshot: true,
                snapshotDate: '2026-04-25',
                coveragePercent: 75,
                overdueEvidence: 3,
                rag: 'AMBER',
            },
        ];
    }

    it('returns text/csv with the expected filename', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        getPortfolioSummaryMock.mockResolvedValue(summaryFixture());
        getPortfolioTenantHealthMock.mockResolvedValue(healthFixture());
        getNonPerformingControlsMock.mockResolvedValue([]);
        getOverdueEvidenceAcrossOrgMock.mockResolvedValue([]);

        const res = await exportGET(
            makeRequest('/api/org/acme-org/portfolio/export'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/text\/csv/);
        expect(res.headers.get('content-disposition')).toMatch(
            /attachment; filename="acme-org_portfolio_\d{4}-\d{2}-\d{2}\.csv"/,
        );
    });

    it('CSV body contains all 4 expected sections for an ORG_ADMIN', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        getPortfolioSummaryMock.mockResolvedValue(summaryFixture());
        getPortfolioTenantHealthMock.mockResolvedValue(healthFixture());
        getNonPerformingControlsMock.mockResolvedValue([
            {
                controlId: 'c-1',
                tenantName: 'Alpha Co',
                tenantSlug: 'alpha',
                name: 'AC-1',
                code: 'AC-1',
                status: 'NOT_STARTED',
                updatedAt: '2026-04-25T00:00:00Z',
            },
        ]);
        getOverdueEvidenceAcrossOrgMock.mockResolvedValue([]);

        const res = await exportGET(
            makeRequest('/api/org/acme-org/portfolio/export'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        const body = await res.text();
        // Section banners present
        expect(body).toContain('# Portfolio Summary');
        expect(body).toContain('# Tenant Health');
        expect(body).toContain('# Non-Performing Controls');
        expect(body).toContain('# Overdue Evidence');
        // Summary values present
        expect(body).toContain('Coverage %,75.0');
        // Tenant health row present
        expect(body).toContain('Alpha Co,alpha,2026-04-25,75.0,3,AMBER');
        // Drill-down row present
        expect(body).toContain('Alpha Co,alpha,AC-1,AC-1,NOT_STARTED,2026-04-25T00:00:00Z');
    });

    it('ORG_READER export includes summary + health, OMITS drill-down sections', async () => {
        getOrgCtxMock.mockResolvedValue(readerCtx);
        getPortfolioSummaryMock.mockResolvedValue(summaryFixture());
        getPortfolioTenantHealthMock.mockResolvedValue(healthFixture());

        const res = await exportGET(
            makeRequest('/api/org/acme-org/portfolio/export'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('# Portfolio Summary');
        expect(body).toContain('# Tenant Health');
        expect(body).not.toContain('# Non-Performing Controls');
        expect(body).not.toContain('# Overdue Evidence');

        // The drill-down usecases must NOT have been called for the
        // partial-export branch — saves DB round-trips when canDrillDown
        // is false.
        expect(getNonPerformingControlsMock).not.toHaveBeenCalled();
        expect(getOverdueEvidenceAcrossOrgMock).not.toHaveBeenCalled();
    });

    it('refuses export when canExportReports is false', async () => {
        getOrgCtxMock.mockResolvedValue({
            ...adminCtx,
            permissions: { ...adminCtx.permissions, canExportReports: false },
        });

        const res = await exportGET(
            makeRequest('/api/org/acme-org/portfolio/export'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(403);

        // Zero data-plane calls when refused.
        expect(getPortfolioSummaryMock).not.toHaveBeenCalled();
        expect(getPortfolioTenantHealthMock).not.toHaveBeenCalled();
    });

    it('escapes commas + quotes + newlines in CSV cells', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        getPortfolioSummaryMock.mockResolvedValue({
            ...summaryFixture(),
            organizationSlug: 'acme-org',
        });
        getPortfolioTenantHealthMock.mockResolvedValue([
            {
                ...healthFixture()[0],
                name: 'Alpha, Inc. "Special"',
            },
        ]);
        getNonPerformingControlsMock.mockResolvedValue([]);
        getOverdueEvidenceAcrossOrgMock.mockResolvedValue([]);

        const res = await exportGET(
            makeRequest('/api/org/acme-org/portfolio/export'),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        const body = await res.text();
        // Quoted + escaped value should appear
        expect(body).toContain('"Alpha, Inc. ""Special"""');
    });
});
