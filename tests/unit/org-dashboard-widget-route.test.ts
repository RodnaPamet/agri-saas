/**
 * Epic 41 — widget API route contract.
 *
 * Mocks org-context + the usecase so the tests exercise:
 *   - GET 200 with widgets list
 *   - POST 201 with the created widget
 *   - POST 400 for malformed body
 *   - PATCH 200 for layout-only update
 *   - PATCH 400 for chartType-without-config
 *   - DELETE 200 with `{deleted: true}`
 *
 * Permission gating is handled by the usecase (`assertCanRead` /
 * `assertCanWrite`) — the route just resolves OrgContext and
 * forwards. The dedicated permission tests on the usecase live in
 * the integration suite where the real auth shape applies.
 */
import { NextRequest } from 'next/server';

const getOrgCtxMock = jest.fn();
const listOrgDashboardWidgetsMock = jest.fn();
const createOrgDashboardWidgetMock = jest.fn();
const updateOrgDashboardWidgetMock = jest.fn();
const deleteOrgDashboardWidgetMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getOrgCtx: (...a: unknown[]) => getOrgCtxMock(...a),
}));

jest.mock('@/app-layer/usecases/org-dashboard-widgets', () => ({
    __esModule: true,
    listOrgDashboardWidgets: (...a: unknown[]) =>
        listOrgDashboardWidgetsMock(...a),
    createOrgDashboardWidget: (...a: unknown[]) =>
        createOrgDashboardWidgetMock(...a),
    updateOrgDashboardWidget: (...a: unknown[]) =>
        updateOrgDashboardWidgetMock(...a),
    deleteOrgDashboardWidget: (...a: unknown[]) =>
        deleteOrgDashboardWidgetMock(...a),
}));

import {
    GET as listGet,
    POST as createPost,
} from '@/app/api/org/[orgSlug]/dashboard/widgets/route';
import {
    PATCH as updatePatch,
    DELETE as deleteDelete,
} from '@/app/api/org/[orgSlug]/dashboard/widgets/[widgetId]/route';

const adminCtx = {
    requestId: 'req-test',
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

const VALID_KPI_PAYLOAD = {
    type: 'KPI',
    chartType: 'tenants',
    config: { format: 'number' },
    title: 'Tenants',
    position: { x: 0, y: 0 },
    size: { w: 3, h: 2 },
};

function makeReq(method: string, body?: unknown): NextRequest {
    return new NextRequest('http://localhost/api/org/acme-org/dashboard/widgets', {
        method,
        headers: body
            ? { 'content-type': 'application/json' }
            : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
}

beforeEach(() => {
    getOrgCtxMock.mockReset();
    listOrgDashboardWidgetsMock.mockReset();
    createOrgDashboardWidgetMock.mockReset();
    updateOrgDashboardWidgetMock.mockReset();
    deleteOrgDashboardWidgetMock.mockReset();
});

describe('GET /api/org/[orgSlug]/dashboard/widgets', () => {
    it('returns 200 + widgets array', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        listOrgDashboardWidgetsMock.mockResolvedValue([
            { id: 'w-1', type: 'KPI', chartType: 'tenants' },
            { id: 'w-2', type: 'DONUT', chartType: 'rag-distribution' },
        ]);

        const res = await listGet(makeReq('GET'), {
            params: Promise.resolve({ orgSlug: 'acme-org' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.widgets).toHaveLength(2);
        expect(body.widgets[0].id).toBe('w-1');
    });
});

describe('POST /api/org/[orgSlug]/dashboard/widgets', () => {
    it('returns 201 + the created widget for a valid payload', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        createOrgDashboardWidgetMock.mockResolvedValue({
            id: 'w-new',
            type: 'KPI',
            chartType: 'tenants',
        });

        const res = await createPost(makeReq('POST', VALID_KPI_PAYLOAD), {
            params: Promise.resolve({ orgSlug: 'acme-org' }),
        });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.widget.id).toBe('w-new');
        expect(createOrgDashboardWidgetMock).toHaveBeenCalledTimes(1);
    });

    it('returns 400 for an unknown chartType (Zod rejects)', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);

        const res = await createPost(
            makeReq('POST', {
                ...VALID_KPI_PAYLOAD,
                chartType: 'made-up-metric',
            }),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(400);
        expect(createOrgDashboardWidgetMock).not.toHaveBeenCalled();
    });

    it('returns 400 for a position outside the bounds', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);

        const res = await createPost(
            makeReq('POST', {
                ...VALID_KPI_PAYLOAD,
                position: { x: 999, y: 0 },
            }),
            { params: Promise.resolve({ orgSlug: 'acme-org' }) },
        );
        expect(res.status).toBe(400);
        expect(createOrgDashboardWidgetMock).not.toHaveBeenCalled();
    });
});

describe('PATCH /api/org/[orgSlug]/dashboard/widgets/[widgetId]', () => {
    function makePatchReq(body: unknown): NextRequest {
        return new NextRequest(
            'http://localhost/api/org/acme-org/dashboard/widgets/w-1',
            {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            },
        );
    }

    it('returns 200 for a layout-only update', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        updateOrgDashboardWidgetMock.mockResolvedValue({
            id: 'w-1',
            position: { x: 4, y: 2 },
        });

        const res = await updatePatch(
            makePatchReq({ position: { x: 4, y: 2 } }),
            { params: Promise.resolve({ orgSlug: 'acme-org', widgetId: 'w-1' }) },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.widget.id).toBe('w-1');
    });

    it('returns 400 when chartType is sent without config (refine rule)', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);

        const res = await updatePatch(
            // Must be a VALID chartType, or this 400s because the enum
            // rejected it and the refine rule under test never runs.
            // 'critical-risks' was valid until the GRC teardown removed it.
            makePatchReq({ chartType: 'tenants' }),
            { params: Promise.resolve({ orgSlug: 'acme-org', widgetId: 'w-1' }) },
        );
        expect(res.status).toBe(400);
        expect(updateOrgDashboardWidgetMock).not.toHaveBeenCalled();
    });
});

describe('DELETE /api/org/[orgSlug]/dashboard/widgets/[widgetId]', () => {
    it('returns 200 + deleted: true', async () => {
        getOrgCtxMock.mockResolvedValue(adminCtx);
        deleteOrgDashboardWidgetMock.mockResolvedValue({
            deleted: true,
            id: 'w-1',
        });

        const res = await deleteDelete(
            new NextRequest(
                'http://localhost/api/org/acme-org/dashboard/widgets/w-1',
                { method: 'DELETE' },
            ),
            { params: Promise.resolve({ orgSlug: 'acme-org', widgetId: 'w-1' }) },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.deleted).toBe(true);
        expect(body.id).toBe('w-1');
    });
});
