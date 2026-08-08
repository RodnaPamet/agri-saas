/**
 * Cross-tenant drill-down auditor fan-out integrity check —
 * DB-backed integration test.
 *
 * Seeds an org with 3 tenants. Two scenarios:
 *
 *   1. **Healthy fan-out**: CISO has AUDITOR membership in all 3 →
 *      drill-down iterates all 3 → no warning logged.
 *   2. **Drift**: manually delete CISO's membership in tenant-2 to
 *      simulate auto-provisioning drift → drill-down iterates only
 *      the 2 remaining tenants AND a structured
 *      `portfolio.auditor_fanout_drift` warning fires naming
 *      tenant-2.
 *
 * Test seeds critical-score risks in every tenant so the silent-
 * empty failure mode (which the integrity check is designed to
 * eliminate) would have been observable as "tenant-2 had data but
 * the drill-down returned nothing for it".
 *
 * Gated by DB_AVAILABLE — skips locally without Postgres + migrations
 * applied; runs in CI.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

import { getNonPerformingControls } from '@/app-layer/usecases/portfolio';
import type { OrgContext } from '@/app-layer/types';
import { generateAndWrapDek } from '@/lib/security/tenant-keys';
import { logger } from '@/lib/observability/logger';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Portfolio drill-down — auditor fan-out integrity (DB-backed)', () => {
    let prisma: PrismaClient;
    const uniq = `fanout-${Date.now()}`;
    const orgSlug = `${uniq}-org`;
    let orgId = '';
    let cisoUserId = '';
    const tenantIds: string[] = [];

    function ctxFor(): OrgContext {
        return {
            requestId: 'req-test',
            userId: cisoUserId,
            organizationId: orgId,
            orgSlug,
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

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        // Org + CISO + 3 tenants, each with a critical risk seeded.
        const ciso = await prisma.user.create({
            data: { email: `${uniq}-ciso@example.com`, name: 'CISO Test' },
        });
        cisoUserId = ciso.id;
        const org = await prisma.organization.create({
            data: { name: `${uniq} corp`, slug: orgSlug },
        });
        orgId = org.id;
        await prisma.orgMembership.create({
            data: { organizationId: org.id, userId: ciso.id, role: 'ORG_ADMIN' },
        });

        for (let i = 1; i <= 3; i++) {
            const slug = `${uniq}-t${i}`;
            const { wrapped } = generateAndWrapDek();
            const tenant = await prisma.tenant.create({
                data: {
                    name: `${uniq} tenant ${i}`,
                    slug,
                    organizationId: org.id,
                    encryptedDek: wrapped,
                },
            });
            tenantIds.push(tenant.id);

            // CISO's auto-provisioned AUDITOR membership.
            await prisma.tenantMembership.create({
                data: {
                    tenantId: tenant.id,
                    userId: ciso.id,
                    role: 'AUDITOR',
                    provisionedByOrgId: org.id,
                },
            });

            // One non-performing control per tenant. This suite is about
            // the FAN-OUT integrity property (does the drill-down reach
            // every tenant, and does a missing AUDITOR row surface as a
            // warning), not about the entity being drilled into — it used
            // the risk register until that was removed.
            await prisma.control.create({
                data: {
                    tenantId: tenant.id,
                    name: `t${i} non-performing control`,
                    status: 'NOT_STARTED',
                    applicability: 'APPLICABLE',
                },
            });
        }
    });

    afterAll(async () => {
        await prisma.control.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
        await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => {});
        await prisma.orgMembership.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
        await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
        await prisma.user.delete({ where: { id: cisoUserId } }).catch(() => {});
        await prisma.$disconnect();
    });

    it('healthy fan-out: drill-down returns rows from ALL three tenants, no warning', async () => {
        const warnSpy = jest.spyOn(logger, 'warn');
        try {
            const rows = await getNonPerformingControls(ctxFor());
            // 3 non-performing controls visible (one per tenant).
            expect(rows).toHaveLength(3);
            // No drift warning emitted on the healthy path.
            const driftWarnings = warnSpy.mock.calls.filter(
                (c) => c[0] === 'portfolio.auditor_fanout_drift',
            );
            expect(driftWarnings).toHaveLength(0);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('simulated drift: missing AUDITOR row → warning fires + iteration skips that tenant', async () => {
        // Simulate manual deletion / provisioning drift on tenant-2.
        await prisma.tenantMembership.deleteMany({
            where: { tenantId: tenantIds[1], userId: cisoUserId },
        });

        const warnSpy = jest.spyOn(logger, 'warn');
        try {
            const rows = await getNonPerformingControls(ctxFor());

            // Drill-down still works for the 2 accessible tenants.
            // Without the integrity check, the result would still be
            // 2 rows (because RLS denies tenant-2 silently) — the
            // critical difference is the operator visibility now.
            expect(rows).toHaveLength(2);
            const tenantSlugsReturned = rows.map((r) => r.tenantSlug).sort();
            expect(tenantSlugsReturned).toEqual([`${uniq}-t1`, `${uniq}-t3`]);

            // The drift warning fires with the missing tenant id.
            const driftCall = warnSpy.mock.calls.find(
                (c) => c[0] === 'portfolio.auditor_fanout_drift',
            );
            expect(driftCall).toBeDefined();
            const payload = driftCall![1] as Record<string, unknown>;
            expect(payload.totalTenants).toBe(3);
            expect(payload.accessibleTenants).toBe(2);
            expect(payload.missingTenantIds).toEqual([tenantIds[1]]);
            expect(payload.organizationId).toBe(orgId);
            expect(payload.userId).toBe(cisoUserId);
        } finally {
            warnSpy.mockRestore();
            // Restore the deleted membership so afterAll teardown
            // works cleanly even if other suites depend on shape.
            await prisma.tenantMembership.create({
                data: {
                    tenantId: tenantIds[1],
                    userId: cisoUserId,
                    role: 'AUDITOR',
                    provisionedByOrgId: orgId,
                },
            });
        }
    });
});
