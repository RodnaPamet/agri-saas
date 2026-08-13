/**
 * Epic 41 — OrgDashboardWidget DB-backed integration test.
 *
 * Seeds two orgs (acme + globex) and exercises the usecase against
 * a real DB so we cover:
 *
 *   - List returns only the caller's org widgets
 *   - Create persists the row
 *   - Update mutates layout fields
 *   - Update revalidates (chartType, config) against the row's type
 *   - Update / delete with another org's widget id returns 404
 *     (no information disclosure across orgs)
 *   - ORG_READER write attempts are blocked at the usecase layer
 *
 * Gated by DB_AVAILABLE — skips locally without Postgres + migrations
 * applied; runs in CI.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

import {
    listOrgDashboardWidgets,
    createOrgDashboardWidget,
    updateOrgDashboardWidget,
    deleteOrgDashboardWidget,
} from '@/app-layer/usecases/org-dashboard-widgets';
import type { OrgContext } from '@/app-layer/types';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Epic 41 — OrgDashboardWidget CRUD (DB-backed)', () => {
    let prisma: PrismaClient;
    const uniq = `widgets-${Date.now()}`;
    let acmeOrgId = '';
    let globexOrgId = '';
    let acmeUserId = '';
    let acmeReaderUserId = '';

    function adminCtxFor(orgId: string, slug: string, userId: string): OrgContext {
        return {
            requestId: `req-test-${userId}`,
            userId,
            organizationId: orgId,
            orgSlug: slug,
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

    function readerCtxFor(orgId: string, slug: string, userId: string): OrgContext {
        return {
            requestId: `req-test-${userId}`,
            userId,
            organizationId: orgId,
            orgSlug: slug,
            orgRole: 'ORG_READER',
            permissions: {
                canViewPortfolio: true,
                canDrillDown: false,
                canExportReports: true,
                canManageTenants: false,
                canManageMembers: false,
                canConfigureDashboard: false,
            },
        };
    }

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        const acme = await prisma.organization.create({
            data: { name: `${uniq} acme`, slug: `${uniq}-acme` },
        });
        acmeOrgId = acme.id;
        const globex = await prisma.organization.create({
            data: { name: `${uniq} globex`, slug: `${uniq}-globex` },
        });
        globexOrgId = globex.id;

        const adminUser = await prisma.user.create({
            data: { email: `${uniq}-admin@example.com`, name: 'Admin' },
        });
        acmeUserId = adminUser.id;
        const readerUser = await prisma.user.create({
            data: { email: `${uniq}-reader@example.com`, name: 'Reader' },
        });
        acmeReaderUserId = readerUser.id;

        // (memberships not load-bearing for these tests since the
        //  usecase trusts the OrgContext — but include for realism)
        await prisma.orgMembership.create({
            data: { organizationId: acmeOrgId, userId: acmeUserId, role: 'ORG_ADMIN' },
        });
        await prisma.orgMembership.create({
            data: { organizationId: acmeOrgId, userId: acmeReaderUserId, role: 'ORG_READER' },
        });
    });

    afterAll(async () => {
        // Best-effort cleanup; cascade on Organization handles widgets.
        await prisma.orgDashboardWidget.deleteMany({
            where: { organizationId: { in: [acmeOrgId, globexOrgId] } },
        }).catch(() => {});
        await prisma.orgMembership.deleteMany({
            where: { organizationId: { in: [acmeOrgId, globexOrgId] } },
        }).catch(() => {});
        await prisma.organization.deleteMany({
            where: { id: { in: [acmeOrgId, globexOrgId] } },
        }).catch(() => {});
        await prisma.user.deleteMany({
            where: { id: { in: [acmeUserId, acmeReaderUserId] } },
        }).catch(() => {});
        await prisma.$disconnect();
    });

    it('create persists a widget for the caller org', async () => {
        const ctx = adminCtxFor(acmeOrgId, `${uniq}-acme`, acmeUserId);
        const widget = await createOrgDashboardWidget(ctx, {
            type: 'KPI',
            chartType: 'coverage',
            config: { format: 'percent' },
            title: 'Coverage',
            position: { x: 0, y: 0 },
            size: { w: 3, h: 2 },
        });
        expect(widget.id).toBeDefined();
        expect(widget.organizationId).toBe(acmeOrgId);
        expect(widget.type).toBe('KPI');
        expect(widget.chartType).toBe('coverage');
        expect(widget.position).toEqual({ x: 0, y: 0 });
    });

    it('list returns only widgets for the caller org', async () => {
        // Seed one widget on each org.
        const acmeAdmin = adminCtxFor(acmeOrgId, `${uniq}-acme`, acmeUserId);
        const globexAdmin = adminCtxFor(globexOrgId, `${uniq}-globex`, acmeUserId);

        await createOrgDashboardWidget(acmeAdmin, {
            type: 'TREND',
            chartType: 'evidence-overdue',
            config: { days: 30 },
            position: { x: 0, y: 1 },
            size: { w: 6, h: 3 },
        });
        await createOrgDashboardWidget(globexAdmin, {
            type: 'DONUT',
            chartType: 'rag-distribution',
            config: { showLegend: true },
            position: { x: 0, y: 0 },
            size: { w: 3, h: 3 },
        });

        const acmeList = await listOrgDashboardWidgets(acmeAdmin);
        const globexList = await listOrgDashboardWidgets(globexAdmin);

        // Cross-org isolation — every row belongs to its caller org.
        for (const row of acmeList) expect(row.organizationId).toBe(acmeOrgId);
        for (const row of globexList) expect(row.organizationId).toBe(globexOrgId);

        // The TREND widget seeded above is in acme, not globex.
        expect(acmeList.some((w) => w.type === 'TREND')).toBe(true);
        expect(globexList.some((w) => w.type === 'TREND')).toBe(false);
    });

    it('update mutates layout-only fields', async () => {
        const ctx = adminCtxFor(acmeOrgId, `${uniq}-acme`, acmeUserId);
        const created = await createOrgDashboardWidget(ctx, {
            type: 'KPI',
            chartType: 'tenants',
            config: { format: 'number' },
            position: { x: 1, y: 1 },
            size: { w: 3, h: 2 },
        });
        const updated = await updateOrgDashboardWidget(ctx, created.id, {
            position: { x: 5, y: 4 },
            enabled: false,
        });
        expect(updated.position).toEqual({ x: 5, y: 4 });
        expect(updated.enabled).toBe(false);
        expect(updated.chartType).toBe('tenants'); // untouched
    });

    it('update revalidates (chartType, config) against the row type', async () => {
        const ctx = adminCtxFor(acmeOrgId, `${uniq}-acme`, acmeUserId);
        const created = await createOrgDashboardWidget(ctx, {
            type: 'KPI',
            chartType: 'coverage',
            config: { format: 'percent' },
            position: { x: 0, y: 5 },
            size: { w: 3, h: 2 },
        });
        // valid in-type swap
        const ok = await updateOrgDashboardWidget(ctx, created.id, {
            chartType: 'critical-risks',
            config: { format: 'number' },
        });
        expect(ok.chartType).toBe('critical-risks');

        // INVALID — KPI row but a TREND chartType. The schema's
        // discriminated union rejects.
        await expect(
            updateOrgDashboardWidget(ctx, created.id, {
                chartType: 'evidence-overdue',
                config: { days: 30 },
            }),
        ).rejects.toThrow();
    });

    it('cross-org id leak returns 404 (no information disclosure)', async () => {
        const acmeAdmin = adminCtxFor(acmeOrgId, `${uniq}-acme`, acmeUserId);
        const globexAdmin = adminCtxFor(globexOrgId, `${uniq}-globex`, acmeUserId);

        const created = await createOrgDashboardWidget(acmeAdmin, {
            type: 'KPI',
            chartType: 'coverage',
            config: { format: 'percent' },
            position: { x: 0, y: 7 },
            size: { w: 3, h: 2 },
        });
        // globex caller cannot update or delete acme's widget
        await expect(
            updateOrgDashboardWidget(globexAdmin, created.id, {
                position: { x: 1, y: 1 },
            }),
        ).rejects.toThrow(/not found/i);
        await expect(
            deleteOrgDashboardWidget(globexAdmin, created.id),
        ).rejects.toThrow(/not found/i);

        // Sanity — the acme caller still sees + can manipulate it
        const fromAcme = await listOrgDashboardWidgets(acmeAdmin);
        expect(fromAcme.some((w) => w.id === created.id)).toBe(true);
    });

    it('delete removes the row + 404s on a second delete', async () => {
        const ctx = adminCtxFor(acmeOrgId, `${uniq}-acme`, acmeUserId);
        const created = await createOrgDashboardWidget(ctx, {
            type: 'KPI',
            chartType: 'overdue-evidence',
            config: { format: 'number' },
            position: { x: 0, y: 9 },
            size: { w: 3, h: 2 },
        });
        const result = await deleteOrgDashboardWidget(ctx, created.id);
        expect(result.deleted).toBe(true);
        // Second delete → 404
        await expect(
            deleteOrgDashboardWidget(ctx, created.id),
        ).rejects.toThrow(/not found/i);
    });

    it('ORG_READER cannot create / update / delete (write 403)', async () => {
        const reader = readerCtxFor(acmeOrgId, `${uniq}-acme`, acmeReaderUserId);
        const admin = adminCtxFor(acmeOrgId, `${uniq}-acme`, acmeUserId);

        await expect(
            createOrgDashboardWidget(reader, {
                type: 'KPI',
                chartType: 'coverage',
                config: { format: 'percent' },
                position: { x: 0, y: 11 },
                size: { w: 3, h: 2 },
            }),
        ).rejects.toThrow(/permission/i);

        // But a reader CAN list (canViewPortfolio is true).
        const created = await createOrgDashboardWidget(admin, {
            type: 'KPI',
            chartType: 'coverage',
            config: { format: 'percent' },
            position: { x: 0, y: 12 },
            size: { w: 3, h: 2 },
        });
        const list = await listOrgDashboardWidgets(reader);
        expect(list.some((w) => w.id === created.id)).toBe(true);

        await expect(
            updateOrgDashboardWidget(reader, created.id, {
                position: { x: 1, y: 1 },
            }),
        ).rejects.toThrow(/permission/i);
        await expect(
            deleteOrgDashboardWidget(reader, created.id),
        ).rejects.toThrow(/permission/i);
    });
});
