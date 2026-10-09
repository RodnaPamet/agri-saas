/**
 * Integration tests for the `tenant_membership_last_owner_guard` DB trigger.
 *
 * Exercises the Postgres-level backstop that prevents a tenant from being
 * left with zero ACTIVE OWNERs via UPDATE or DELETE on TenantMembership.
 *
 * Requires a real PostgreSQL instance with the migration
 * `20260424220000_epic1_last_owner_trigger` applied.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, hardDeleteTenants } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('last-OWNER DB trigger', () => {
    let prisma: PrismaClient;
    const tenantSlugs: string[] = [];
    const userIds: string[] = [];

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        // NOT best-effort, and no `catch`. This suite creates tenants with
        // active OWNERs on purpose — it exists to assert that the last-OWNER
        // guard refuses to remove them — so its own teardown hit that same
        // trigger on every run and every failure was swallowed (#1432). The
        // suite reported green while leaking every fixture it made.
        //
        // `hardDeleteTenants` disables the trigger for the delete inside one
        // transaction and then COUNTS what is left, so a teardown that cannot
        // clean up says so.
        const created = await prisma.tenant.findMany({
            where: { slug: { in: tenantSlugs } },
            select: { id: true },
        });
        await hardDeleteTenants(prisma, created.map((t) => t.id));
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.$disconnect();
    });

    /** Create a test tenant + OWNER membership, return IDs. */
    async function createTenantWithOwner(suffix: string): Promise<{
        tenantId: string;
        ownerMembershipId: string;
        ownerUserId: string;
    }> {
        const slug = `last-owner-guard-${suffix}-${Date.now()}`;
        tenantSlugs.push(slug);

        const tenant = await prisma.tenant.create({
            data: { name: `Last Owner Guard ${suffix}`, slug, encryptedDek: 'v1:dGVzdA==' },
            select: { id: true },
        });

        const user = await prisma.user.create({
            data: { email: `owner-guard-${suffix}-${Date.now()}@example.com` },
            select: { id: true },
        });
        userIds.push(user.id);

        const membership = await prisma.tenantMembership.create({
            data: {
                tenantId: tenant.id,
                userId: user.id,
                role: 'OWNER',
                status: 'ACTIVE',
            },
            select: { id: true },
        });

        return {
            tenantId: tenant.id,
            ownerMembershipId: membership.id,
            ownerUserId: user.id,
        };
    }

    it('rejects UPDATE that demotes the only ACTIVE OWNER', async () => {
        const { ownerMembershipId } = await createTenantWithOwner('demote');

        await expect(
            prisma.tenantMembership.update({
                where: { id: ownerMembershipId },
                data: { role: 'ADMIN' },
            }),
        ).rejects.toThrow(/LAST_OWNER_GUARD/);
    });

    it('rejects UPDATE that deactivates the only ACTIVE OWNER', async () => {
        const { ownerMembershipId } = await createTenantWithOwner('deactivate');

        await expect(
            prisma.tenantMembership.update({
                where: { id: ownerMembershipId },
                data: { status: 'DEACTIVATED' },
            }),
        ).rejects.toThrow(/LAST_OWNER_GUARD/);
    });

    it('rejects DELETE of the only ACTIVE OWNER', async () => {
        const { ownerMembershipId } = await createTenantWithOwner('delete');

        await expect(
            prisma.tenantMembership.delete({
                where: { id: ownerMembershipId },
            }),
        ).rejects.toThrow(/LAST_OWNER_GUARD/);
    });

    it('rejects deleteMany that would remove the only ACTIVE OWNER', async () => {
        const { tenantId } = await createTenantWithOwner('deletemany');

        await expect(
            prisma.tenantMembership.deleteMany({
                where: { tenantId, role: 'OWNER' },
            }),
        ).rejects.toThrow(/LAST_OWNER_GUARD/);
    });

    it('allows demoting the first OWNER when a second OWNER already exists', async () => {
        const { tenantId, ownerMembershipId, ownerUserId } =
            await createTenantWithOwner('two-owners');

        // Create a second OWNER.
        const user2 = await prisma.user.create({
            data: { email: `owner2-${Date.now()}@example.com` },
            select: { id: true },
        });
        userIds.push(user2.id);

        const membership2 = await prisma.tenantMembership.create({
            data: {
                tenantId,
                userId: user2.id,
                role: 'OWNER',
                status: 'ACTIVE',
            },
            select: { id: true },
        });

        // Demote the first OWNER — should succeed because the second still exists.
        await expect(
            prisma.tenantMembership.update({
                where: { id: ownerMembershipId },
                data: { role: 'ADMIN' },
            }),
        ).resolves.toMatchObject({ role: 'ADMIN' });

        void ownerUserId; // referenced for lint

        // Cleanup second membership (tenant cleanup in afterAll handles the rest).
        await prisma.tenantMembership.delete({ where: { id: membership2.id } }).catch(() => {});
    });
});
