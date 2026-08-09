/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for `src/app-layer/usecases/org-dashboard-widgets.ts` —
 * CRUD for org-level dashboard widgets.
 *
 * Wave-9 / stage-3g branch coverage. Cross-org-id leak defence is
 * the load-bearing security invariant: a stolen widget id from
 * another org must return 404, never write into the caller's org.
 *
 * Branch matrix:
 *   list:    canViewPortfolio gate + happy path mapping
 *   create:  canConfigureDashboard gate + title default null + enabled default true
 *   update:  canConfigureDashboard gate + cross-org 404 +
 *            chartType+config revalidation when both present +
 *            partial-update branches (title / position / size /
 *            enabled / chartType / config — each independently
 *            applied)
 *   delete:  canConfigureDashboard gate + deleteMany.count===0 → 404 +
 *            happy path
 */

const mockPrisma: any = {
    orgDashboardWidget: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
    },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: mockPrisma,
}));

const mockAssertShape = jest.fn();
jest.mock('@/app-layer/schemas/org-dashboard-widget.schemas', () => ({
    assertWidgetTypedShape: (...args: any[]) => mockAssertShape(...args),
}));

import {
    listOrgDashboardWidgets,
    createOrgDashboardWidget,
    updateOrgDashboardWidget,
    deleteOrgDashboardWidget,
} from '@/app-layer/usecases/org-dashboard-widgets';
import type { OrgContext } from '@/app-layer/types';

const readCtx: OrgContext = {
    requestId: 'r-1',
    userId: 'u-1',
    organizationId: 'org-1',
    orgSlug: 'acme',
    orgRole: 'ORG_READER' as any,
    permissions: { canViewPortfolio: true, canConfigureDashboard: false } as any,
};

const writeCtx: OrgContext = {
    requestId: 'r-1',
    userId: 'u-1',
    organizationId: 'org-1',
    orgSlug: 'acme',
    orgRole: 'ORG_ADMIN' as any,
    permissions: { canViewPortfolio: true, canConfigureDashboard: true } as any,
};

const noPermsCtx: OrgContext = {
    requestId: 'r-1',
    userId: 'u-1',
    organizationId: 'org-1',
    orgSlug: 'acme',
    orgRole: 'ORG_READER' as any,
    permissions: { canViewPortfolio: false, canConfigureDashboard: false } as any,
};

const widgetRow = {
    id: 'w-1',
    organizationId: 'org-1',
    type: 'KPI_CARD',
    chartType: 'count',
    title: 'My widget',
    config: { metric: 'practices' },
    position: { x: 0, y: 0 },
    size: { w: 4, h: 2 },
    enabled: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
};

beforeEach(() => {
    [
        mockPrisma.orgDashboardWidget.findMany,
        mockPrisma.orgDashboardWidget.findFirst,
        mockPrisma.orgDashboardWidget.create,
        mockPrisma.orgDashboardWidget.update,
        mockPrisma.orgDashboardWidget.deleteMany,
        mockAssertShape,
    ].forEach((m: any) => m.mockReset && m.mockReset());
});

// ──────────────────────────────────────────────────────────────────────
// listOrgDashboardWidgets
// ──────────────────────────────────────────────────────────────────────
describe('listOrgDashboardWidgets', () => {
    it('rejects when canViewPortfolio is false', async () => {
        await expect(listOrgDashboardWidgets(noPermsCtx)).rejects.toThrow(/do not have permission to view/i);
    });

    it('returns DTOs scoped to organizationId, ordered by createdAt ASC', async () => {
        mockPrisma.orgDashboardWidget.findMany.mockResolvedValueOnce([widgetRow]);

        const result = await listOrgDashboardWidgets(readCtx);

        const args = mockPrisma.orgDashboardWidget.findMany.mock.calls[0][0];
        expect(args.where).toEqual({ organizationId: 'org-1' });
        expect(args.orderBy).toEqual({ createdAt: 'asc' });
        expect(result).toHaveLength(1);
        // Date is ISO-serialized in the DTO.
        expect(typeof result[0].createdAt).toBe('string');
    });
});

// ──────────────────────────────────────────────────────────────────────
// createOrgDashboardWidget
// ──────────────────────────────────────────────────────────────────────
describe('createOrgDashboardWidget', () => {
    it('rejects when canConfigureDashboard is false', async () => {
        await expect(
            createOrgDashboardWidget(readCtx, {
                type: 'KPI_CARD' as any,
                chartType: 'count',
                config: { metric: 'practices' },
                position: { x: 0, y: 0 } as any,
                size: { w: 4, h: 2 } as any,
            } as any),
        ).rejects.toThrow(/do not have permission to configure/i);
    });

    it('defaults title=null when omitted', async () => {
        mockPrisma.orgDashboardWidget.create.mockResolvedValueOnce(widgetRow);

        await createOrgDashboardWidget(writeCtx, {
            type: 'KPI_CARD' as any,
            chartType: 'count',
            config: { metric: 'practices' },
            position: { x: 0, y: 0 } as any,
            size: { w: 4, h: 2 } as any,
        } as any);

        const data = mockPrisma.orgDashboardWidget.create.mock.calls[0][0].data;
        expect(data.title).toBeNull();
    });

    it('defaults enabled=true when omitted', async () => {
        mockPrisma.orgDashboardWidget.create.mockResolvedValueOnce(widgetRow);

        await createOrgDashboardWidget(writeCtx, {
            type: 'KPI_CARD' as any,
            chartType: 'count',
            config: {},
            position: {} as any,
            size: {} as any,
        } as any);

        const data = mockPrisma.orgDashboardWidget.create.mock.calls[0][0].data;
        expect(data.enabled).toBe(true);
    });

    it('respects explicit enabled=false', async () => {
        mockPrisma.orgDashboardWidget.create.mockResolvedValueOnce(widgetRow);

        await createOrgDashboardWidget(writeCtx, {
            type: 'KPI_CARD' as any,
            chartType: 'count',
            config: {},
            position: {} as any,
            size: {} as any,
            enabled: false,
        } as any);

        const data = mockPrisma.orgDashboardWidget.create.mock.calls[0][0].data;
        expect(data.enabled).toBe(false);
    });

    it('scopes the create to ctx.organizationId (never caller-supplied)', async () => {
        mockPrisma.orgDashboardWidget.create.mockResolvedValueOnce(widgetRow);

        await createOrgDashboardWidget(writeCtx, {
            type: 'KPI_CARD' as any,
            chartType: 'count',
            config: {},
            position: {} as any,
            size: {} as any,
        } as any);

        const data = mockPrisma.orgDashboardWidget.create.mock.calls[0][0].data;
        expect(data.organizationId).toBe('org-1');
    });
});

// ──────────────────────────────────────────────────────────────────────
// updateOrgDashboardWidget — multi-branch
// ──────────────────────────────────────────────────────────────────────
describe('updateOrgDashboardWidget', () => {
    it('rejects when canConfigureDashboard is false', async () => {
        await expect(
            updateOrgDashboardWidget(readCtx, 'w-1', { title: 'X' } as any),
        ).rejects.toThrow(/do not have permission/i);
    });

    it('CROSS-ORG: returns notFound when the widget id belongs to another org', async () => {
        // Compliance-critical: the findFirst filter is by id AND
        // organizationId, so a stolen id from another org returns
        // null → notFound. No information disclosure.
        mockPrisma.orgDashboardWidget.findFirst.mockResolvedValueOnce(null);
        await expect(
            updateOrgDashboardWidget(writeCtx, 'w-stolen', { title: 'X' } as any),
        ).rejects.toThrow(/widget not found/i);
        expect(mockPrisma.orgDashboardWidget.update).not.toHaveBeenCalled();
    });

    it('REVALIDATES chartType + config when both are present (defence-in-depth)', async () => {
        // Route layer Zod already validates the per-type config
        // shape; the usecase repeats the check using the existing
        // widget's type — catches edge cases like a route bypass
        // or a refactored caller.
        mockPrisma.orgDashboardWidget.findFirst.mockResolvedValueOnce({ ...widgetRow, type: 'KPI_CARD' });
        mockPrisma.orgDashboardWidget.update.mockResolvedValueOnce(widgetRow);

        await updateOrgDashboardWidget(writeCtx, 'w-1', {
            chartType: 'count',
            config: { metric: 'risks' },
        } as any);

        expect(mockAssertShape).toHaveBeenCalledWith({
            type: 'KPI_CARD',
            chartType: 'count',
            config: { metric: 'risks' },
        });
    });

    it('does NOT revalidate when only one of chartType/config is present', async () => {
        // The contract: chartType + config move TOGETHER. A
        // partial update of just one signals an intentional non-
        // shape-changing edit (e.g. user toggling chartType
        // while keeping the same data structure).
        mockPrisma.orgDashboardWidget.findFirst.mockResolvedValueOnce({ ...widgetRow });
        mockPrisma.orgDashboardWidget.update.mockResolvedValueOnce(widgetRow);

        await updateOrgDashboardWidget(writeCtx, 'w-1', { chartType: 'count' } as any);

        expect(mockAssertShape).not.toHaveBeenCalled();
    });

    it('applies each partial field independently (title only)', async () => {
        mockPrisma.orgDashboardWidget.findFirst.mockResolvedValueOnce(widgetRow);
        mockPrisma.orgDashboardWidget.update.mockResolvedValueOnce(widgetRow);

        await updateOrgDashboardWidget(writeCtx, 'w-1', { title: 'New Title' } as any);

        const data = mockPrisma.orgDashboardWidget.update.mock.calls[0][0].data;
        expect(data).toEqual({ title: 'New Title' });
    });

    it('applies position only', async () => {
        mockPrisma.orgDashboardWidget.findFirst.mockResolvedValueOnce(widgetRow);
        mockPrisma.orgDashboardWidget.update.mockResolvedValueOnce(widgetRow);

        await updateOrgDashboardWidget(writeCtx, 'w-1', { position: { x: 5, y: 5 } } as any);

        const data = mockPrisma.orgDashboardWidget.update.mock.calls[0][0].data;
        expect(data).toEqual({ position: { x: 5, y: 5 } });
    });

    it('applies size + enabled together (mixed partial)', async () => {
        mockPrisma.orgDashboardWidget.findFirst.mockResolvedValueOnce(widgetRow);
        mockPrisma.orgDashboardWidget.update.mockResolvedValueOnce(widgetRow);

        await updateOrgDashboardWidget(writeCtx, 'w-1', { size: { w: 6, h: 4 }, enabled: false } as any);

        const data = mockPrisma.orgDashboardWidget.update.mock.calls[0][0].data;
        expect(data.size).toEqual({ w: 6, h: 4 });
        expect(data.enabled).toBe(false);
    });

    it('handles empty update payload (DB sees empty data)', async () => {
        mockPrisma.orgDashboardWidget.findFirst.mockResolvedValueOnce(widgetRow);
        mockPrisma.orgDashboardWidget.update.mockResolvedValueOnce(widgetRow);

        await updateOrgDashboardWidget(writeCtx, 'w-1', {} as any);

        const data = mockPrisma.orgDashboardWidget.update.mock.calls[0][0].data;
        expect(data).toEqual({});
    });
});

// ──────────────────────────────────────────────────────────────────────
// deleteOrgDashboardWidget
// ──────────────────────────────────────────────────────────────────────
describe('deleteOrgDashboardWidget', () => {
    it('rejects when canConfigureDashboard is false', async () => {
        await expect(deleteOrgDashboardWidget(readCtx, 'w-1')).rejects.toThrow(/do not have permission/i);
    });

    it('returns notFound when deleteMany matches zero rows (cross-org id)', async () => {
        // The deleteMany filter is by id AND organizationId; a
        // stolen id from another org returns count=0 → notFound.
        // Critical: this is NOT a 200 with count:0 — the cross-org
        // case is indistinguishable from a real miss.
        mockPrisma.orgDashboardWidget.deleteMany.mockResolvedValueOnce({ count: 0 });
        await expect(deleteOrgDashboardWidget(writeCtx, 'w-stolen')).rejects.toThrow(/widget not found/i);
    });

    it('returns { deleted: true, id } on happy path', async () => {
        mockPrisma.orgDashboardWidget.deleteMany.mockResolvedValueOnce({ count: 1 });

        const result = await deleteOrgDashboardWidget(writeCtx, 'w-1');

        expect(result).toEqual({ deleted: true, id: 'w-1' });
        expect(mockPrisma.orgDashboardWidget.deleteMany).toHaveBeenCalledWith({
            where: { id: 'w-1', organizationId: 'org-1' },
        });
    });
});
