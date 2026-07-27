/**
 * Integration — member Deactivate / Reactivate / Remove lifecycle.
 *
 * Repairs the "stale Remove button": a DEACTIVATED member could not be
 * removed (the bulk action filtered `status: 'ACTIVE'`, so it silently
 * no-op'd) and there was no per-row action to reactivate or remove them.
 *
 * These tests lock the new usecases against a real DB:
 *   - reactivateTenantMember: DEACTIVATED → ACTIVE, deactivatedAt cleared.
 *   - removeTenantMember: → REMOVED (leaves the members list), with
 *     self + last-active-OWNER protection.
 *   - bulkRemoveTenantMember: removes active AND already-deactivated rows,
 *     skipping self + the last active OWNER.
 *   - bulkDeactivateTenantMember: unchanged — still ACTIVE → DEACTIVATED.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { PrismaClient, Role, MembershipStatus } from '@prisma/client';

import {
    reactivateTenantMember,
    removeTenantMember,
    bulkRemoveTenantMember,
    bulkDeactivateTenantMember,
    listTenantMembers,
} from '@/app-layer/usecases/tenant-admin';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('member remove / reactivate lifecycle', () => {
    let prisma: PrismaClient;
    const tenantSlugs: string[] = [];
    const userEmails: string[] = [];

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        try {
            const tenants = await prisma.tenant.findMany({
                where: { slug: { in: tenantSlugs } },
                select: { id: true },
            });
            const ids = tenants.map((t) => t.id);
            if (ids.length) {
                await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
                await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: ids } } });
                await prisma.tenantOnboarding.deleteMany({ where: { tenantId: { in: ids } } });
            }
        } catch { /* best effort */ }
        try { await prisma.tenant.deleteMany({ where: { slug: { in: tenantSlugs } } }); } catch { /* noop */ }
        try { await prisma.user.deleteMany({ where: { email: { in: userEmails } } }); } catch { /* noop */ }
        await prisma.$disconnect();
    });

    let seq = 0;
    function uniq(p: string): string { return `${p}-${Date.now()}-${seq++}`; }

    async function setupTenant() {
        const slug = uniq('mrr'); tenantSlugs.push(slug);
        const ownerEmail = `${uniq('owner')}@example.com`; userEmails.push(ownerEmail);
        const result = await createTenantWithOwner({
            name: `MRR ${slug}`, slug, ownerEmail, requestId: `req-${slug}`,
        });
        const adminCtx = makeRequestContext('OWNER', {
            userId: result.ownerUserId,
            tenantId: result.tenant.id,
            tenantSlug: slug,
            appPermissions: getPermissionsForRole('OWNER'),
        });
        return { tenantId: result.tenant.id, adminCtx, ownerUserId: result.ownerUserId };
    }

    async function addMember(
        tenantId: string,
        opts: { role?: Role; status?: MembershipStatus } = {},
    ) {
        const email = `${uniq('m')}@example.com`; userEmails.push(email);
        const user = await prisma.user.create({ data: { email, name: email.split('@')[0] } });
        const membership = await prisma.tenantMembership.create({
            data: {
                tenantId,
                userId: user.id,
                role: opts.role ?? 'READER',
                status: opts.status ?? 'ACTIVE',
                deactivatedAt: opts.status === 'DEACTIVATED' ? new Date() : null,
            },
        });
        return { user, membership };
    }

    it('reactivates a DEACTIVATED member → ACTIVE, deactivatedAt cleared', async () => {
        const { tenantId, adminCtx } = await setupTenant();
        const { membership } = await addMember(tenantId, { status: 'DEACTIVATED' });

        const res = await reactivateTenantMember(adminCtx, { membershipId: membership.id });
        expect(res.status).toBe('ACTIVE');
        expect(res.deactivatedAt).toBeNull();
    });

    it('reactivate rejects an already-ACTIVE member', async () => {
        const { tenantId, adminCtx } = await setupTenant();
        const { membership } = await addMember(tenantId, { status: 'ACTIVE' });
        await expect(
            reactivateTenantMember(adminCtx, { membershipId: membership.id }),
        ).rejects.toThrow(/not found or already active/i);
    });

    it('removes a DEACTIVATED member → REMOVED, leaving the members list', async () => {
        const { tenantId, adminCtx } = await setupTenant();
        const { membership, user } = await addMember(tenantId, { status: 'DEACTIVATED' });

        const res = await removeTenantMember(adminCtx, { membershipId: membership.id });
        expect(res.status).toBe('REMOVED');

        // listTenantMembers returns ACTIVE / INVITED / DEACTIVATED only.
        const listed = await listTenantMembers(adminCtx);
        expect(listed.some((m) => m.userId === user.id)).toBe(false);
    });

    it('remove refuses self-removal', async () => {
        const { tenantId, adminCtx, ownerUserId } = await setupTenant();
        const ownMembership = await prisma.tenantMembership.findFirst({
            where: { tenantId, userId: ownerUserId },
        });
        await expect(
            removeTenantMember(adminCtx, { membershipId: ownMembership!.id }),
        ).rejects.toThrow();
    });

    it('remove protects the last active OWNER', async () => {
        const { tenantId, ownerUserId } = await setupTenant();
        // A second admin acting, so the guard (not self-removal) is what bites.
        const admin2 = await addMember(tenantId, { role: 'ADMIN', status: 'ACTIVE' });
        const actingCtx = makeRequestContext('ADMIN', {
            userId: admin2.user.id,
            tenantId,
            tenantSlug: (await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }))!.slug,
            appPermissions: getPermissionsForRole('ADMIN'),
        });
        const ownerMembership = await prisma.tenantMembership.findFirst({
            where: { tenantId, userId: ownerUserId },
        });
        await expect(
            removeTenantMember(actingCtx, { membershipId: ownerMembership!.id }),
        ).rejects.toThrow(/last OWNER/i);
    });

    it('bulk-remove removes active AND deactivated rows (the stale-button fix)', async () => {
        const { tenantId, adminCtx } = await setupTenant();
        const active = await addMember(tenantId, { status: 'ACTIVE' });
        const deactivated = await addMember(tenantId, { status: 'DEACTIVATED' });

        const res = await bulkRemoveTenantMember(adminCtx, {
            membershipIds: [active.membership.id, deactivated.membership.id],
        });
        expect(res.removed).toBe(2);

        const [a, d] = await Promise.all([
            prisma.tenantMembership.findUnique({ where: { id: active.membership.id }, select: { status: true } }),
            prisma.tenantMembership.findUnique({ where: { id: deactivated.membership.id }, select: { status: true } }),
        ]);
        expect(a?.status).toBe('REMOVED');
        expect(d?.status).toBe('REMOVED');
    });

    it('bulk-deactivate still soft-deactivates ACTIVE rows (unchanged)', async () => {
        const { tenantId, adminCtx } = await setupTenant();
        const m = await addMember(tenantId, { status: 'ACTIVE' });
        const res = await bulkDeactivateTenantMember(adminCtx, {
            membershipIds: [m.membership.id],
        });
        expect(res.deactivated).toBe(1);
        const after = await prisma.tenantMembership.findUnique({
            where: { id: m.membership.id }, select: { status: true },
        });
        expect(after?.status).toBe('DEACTIVATED');
    });
});
