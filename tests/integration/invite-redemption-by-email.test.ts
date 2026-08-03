/**
 * Integration tests for VERIFIED-EMAIL invite provisioning.
 *
 * `redeemPendingInvitesByEmail` makes the emailed `/invite/:token` link
 * OPTIONAL: an admin adds a member, the member signs in with that same
 * address via an OAuth IdP, and the membership is created. Email
 * delivery is unreliable, and a user who just clicks "Sign in with
 * Microsoft" should not be stranded on /no-tenant.
 *
 * The tests that matter most here are the NEGATIVE ones. This path
 * writes TenantMembership rows outside the token flow, so the Epic 1 /
 * GAP-01 invariant — authentication is not membership — has to be
 * pinned down explicitly:
 *
 *   - no pending invite ⇒ NO membership (this is not auto-join);
 *   - revoked / expired / already-accepted invites are inert;
 *   - a different address does not inherit someone else's invite.
 *
 * All tests run against a real PostgreSQL instance and skip when the DB
 * is unavailable.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { PrismaClient } from '@prisma/client';

import {
    createInviteToken,
    revokeInvite,
    redeemPendingInvitesByEmail,
} from '@/app-layer/usecases/tenant-invites';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { hashForLookup } from '@/lib/security/encryption';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('redeemPendingInvitesByEmail', () => {
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
            if (ids.length > 0) {
                await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
                await prisma.tenantInvite.deleteMany({ where: { tenantId: { in: ids } } });
                await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: ids } } });
                await prisma.tenantOnboarding.deleteMany({ where: { tenantId: { in: ids } } });
            }
        } catch { /* best effort */ }
        try {
            await prisma.tenant.deleteMany({ where: { slug: { in: tenantSlugs } } });
        } catch { /* best effort */ }
        try {
            await prisma.user.deleteMany({ where: { email: { in: userEmails } } });
        } catch { /* best effort */ }
        await prisma.$disconnect();
    });

    // ── Helpers ────────────────────────────────────────────────────────

    let seq = 0;
    function uniq(suffix: string): string {
        seq += 1;
        return `${suffix}-${Date.now()}-${seq}`;
    }

    function slugFor(suffix: string): string {
        const slug = `ibe-${uniq(suffix)}`;
        tenantSlugs.push(slug);
        return slug;
    }

    function emailFor(suffix: string): string {
        const email = `ibe-${uniq(suffix)}@example.com`;
        userEmails.push(email);
        return email;
    }

    async function setupTenant(suffix: string) {
        const slug = slugFor(suffix);
        const ownerEmail = emailFor(`owner-${suffix}`);
        const result = await createTenantWithOwner({
            name: `Tenant ${suffix}`,
            slug,
            ownerEmail,
            requestId: `req-${suffix}`,
        });
        const ownerCtx = makeRequestContext('OWNER', {
            userId: result.ownerUserId,
            tenantId: result.tenant.id,
            tenantSlug: slug,
            appPermissions: getPermissionsForRole('OWNER'),
        });
        return { tenantId: result.tenant.id, slug, ownerCtx };
    }

    async function createUser(email: string) {
        return prisma.user.upsert({
            where: { emailHash: hashForLookup(email) },
            create: { email, name: email.split('@')[0] },
            update: {},
        });
    }

    function membershipFor(tenantId: string, userId: string) {
        return prisma.tenantMembership.findUnique({
            where: { tenantId_userId: { tenantId, userId } },
        });
    }

    // ── The behaviour we want ──────────────────────────────────────────

    it('creates an ACTIVE membership with the invited role, no token needed', async () => {
        const { tenantId, slug, ownerCtx } = await setupTenant('happy');
        const email = emailFor('invitee-happy');
        const user = await createUser(email);

        // Admin adds the member. The invitee never sees the link.
        await createInviteToken(ownerCtx, { email, role: 'EDITOR' });

        const redeemed = await redeemPendingInvitesByEmail({
            userId: user.id,
            userEmail: email,
        });

        expect(redeemed).toHaveLength(1);
        expect(redeemed[0]).toMatchObject({ tenantId, slug, role: 'EDITOR' });

        const membership = await membershipFor(tenantId, user.id);
        expect(membership).toMatchObject({ status: 'ACTIVE', role: 'EDITOR' });
    });

    it('matches the address case-insensitively and ignores surrounding whitespace', async () => {
        const { tenantId, ownerCtx } = await setupTenant('case');
        const email = emailFor('invitee-case');
        const user = await createUser(email);
        await createInviteToken(ownerCtx, { email, role: 'READER' });

        const redeemed = await redeemPendingInvitesByEmail({
            userId: user.id,
            userEmail: `  ${email.toUpperCase()}  `,
        });

        expect(redeemed).toHaveLength(1);
        expect(await membershipFor(tenantId, user.id)).toMatchObject({ status: 'ACTIVE' });
    });

    it('redeems invites for EVERY tenant the address was invited to', async () => {
        const a = await setupTenant('multi-a');
        const b = await setupTenant('multi-b');
        const email = emailFor('invitee-multi');
        const user = await createUser(email);

        await createInviteToken(a.ownerCtx, { email, role: 'EDITOR' });
        await createInviteToken(b.ownerCtx, { email, role: 'READER' });

        const redeemed = await redeemPendingInvitesByEmail({
            userId: user.id,
            userEmail: email,
        });

        expect(redeemed).toHaveLength(2);
        expect(await membershipFor(a.tenantId, user.id)).toMatchObject({ role: 'EDITOR' });
        expect(await membershipFor(b.tenantId, user.id)).toMatchObject({ role: 'READER' });
    });

    it('consumes the invite — a second sign-in is a no-op, not a re-grant', async () => {
        const { tenantId, ownerCtx } = await setupTenant('once');
        const email = emailFor('invitee-once');
        const user = await createUser(email);
        await createInviteToken(ownerCtx, { email, role: 'EDITOR' });

        expect(await redeemPendingInvitesByEmail({ userId: user.id, userEmail: email }))
            .toHaveLength(1);
        // Every subsequent login finds acceptedAt set and does nothing.
        expect(await redeemPendingInvitesByEmail({ userId: user.id, userEmail: email }))
            .toHaveLength(0);

        expect(await membershipFor(tenantId, user.id)).toMatchObject({ status: 'ACTIVE' });
    });

    // ── The invariants that keep this from being auto-join ─────────────

    it('SECURITY: no pending invite ⇒ NO membership (authentication is not membership)', async () => {
        const { tenantId } = await setupTenant('noinvite');
        const email = emailFor('stranger');
        const user = await createUser(email);

        // A perfectly valid sign-in by someone nobody invited.
        const redeemed = await redeemPendingInvitesByEmail({
            userId: user.id,
            userEmail: email,
        });

        expect(redeemed).toEqual([]);
        expect(await membershipFor(tenantId, user.id)).toBeNull();
    });

    it('SECURITY: another address does not inherit an invite', async () => {
        const { tenantId, ownerCtx } = await setupTenant('binding');
        const invited = emailFor('invited-binding');
        const other = emailFor('other-binding');
        const otherUser = await createUser(other);

        await createInviteToken(ownerCtx, { email: invited, role: 'ADMIN' });

        const redeemed = await redeemPendingInvitesByEmail({
            userId: otherUser.id,
            userEmail: other,
        });

        expect(redeemed).toEqual([]);
        expect(await membershipFor(tenantId, otherUser.id)).toBeNull();
    });

    it('SECURITY: a REVOKED invite grants nothing', async () => {
        const { tenantId, ownerCtx } = await setupTenant('revoked');
        const email = emailFor('invitee-revoked');
        const user = await createUser(email);

        const { invite } = await createInviteToken(ownerCtx, { email, role: 'EDITOR' });
        await revokeInvite(ownerCtx, { inviteId: invite.id });

        const redeemed = await redeemPendingInvitesByEmail({
            userId: user.id,
            userEmail: email,
        });

        expect(redeemed).toEqual([]);
        expect(await membershipFor(tenantId, user.id)).toBeNull();
    });

    it('SECURITY: an EXPIRED invite grants nothing', async () => {
        const { tenantId, ownerCtx } = await setupTenant('expired');
        const email = emailFor('invitee-expired');
        const user = await createUser(email);

        const { invite } = await createInviteToken(ownerCtx, { email, role: 'EDITOR' });
        await prisma.tenantInvite.update({
            where: { id: invite.id },
            data: { expiresAt: new Date(Date.now() - 60_000) },
        });

        const redeemed = await redeemPendingInvitesByEmail({
            userId: user.id,
            userEmail: email,
        });

        expect(redeemed).toEqual([]);
        expect(await membershipFor(tenantId, user.id)).toBeNull();
    });

    it('does not resurrect a membership an admin deactivated, absent a fresh invite', async () => {
        const { tenantId, ownerCtx } = await setupTenant('deactivated');
        const email = emailFor('invitee-deactivated');
        const user = await createUser(email);

        await createInviteToken(ownerCtx, { email, role: 'EDITOR' });
        await redeemPendingInvitesByEmail({ userId: user.id, userEmail: email });

        await prisma.tenantMembership.update({
            where: { tenantId_userId: { tenantId, userId: user.id } },
            data: { status: 'DEACTIVATED', deactivatedAt: new Date() },
        });

        // Signing in again must NOT undo the removal — the invite that
        // authorised the grant was consumed on first use.
        const redeemed = await redeemPendingInvitesByEmail({
            userId: user.id,
            userEmail: email,
        });

        expect(redeemed).toEqual([]);
        expect(await membershipFor(tenantId, user.id)).toMatchObject({ status: 'DEACTIVATED' });
    });
});
