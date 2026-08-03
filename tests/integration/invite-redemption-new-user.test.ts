/**
 * Regression — a FIRST-TIME invitee gains their membership on sign-in.
 *
 * The bug (fixed by moving redemption to the jwt callback): the NextAuth
 * `signIn` callback redeemed invites with `user.id`, which for a brand-new
 * OAuth user is the identity-provider subject, NOT our `User.id` (the
 * Prisma adapter creates the row only after `signIn` returns). The
 * membership upsert therefore wrote against a non-existent `User` FK — the
 * write threw, the error was swallowed, the invite was already burnt, and
 * the invitee landed on `/no-tenant` with a dead link.
 *
 * `redeemPendingInvites` fixes it by resolving the PERSISTED id by email,
 * from the jwt callback (which fires after the row exists). These tests
 * assert the fix directly:
 *   - the membership is attached to the real, email-resolved user id;
 *   - passing the provider-subject id to the raw usecase (the old path)
 *     does NOT create a membership — the failure mode we escaped.
 *
 * Runs against a real PostgreSQL instance; skipped when the DB is absent.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { PrismaClient } from '@prisma/client';

import { createInviteToken } from '@/app-layer/usecases/tenant-invites';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { redeemPendingInvites } from '@/lib/auth/invite-redemption';
import { hashForLookup } from '@/lib/security/encryption';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('invite redemption — first-time (new) user', () => {
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

    function slugFor(suffix: string): string {
        const slug = `ir-newuser-${suffix}-${Date.now()}`;
        tenantSlugs.push(slug);
        return slug;
    }
    function emailFor(suffix: string): string {
        const email = `ir-newuser-${suffix}-${Date.now()}@example.com`;
        userEmails.push(email);
        return email;
    }

    async function setupTenant(suffix: string) {
        const slug = slugFor(suffix);
        const ownerEmail = emailFor(`owner-${suffix}`);
        const result = await createTenantWithOwner({
            name: `NewUser Tenant ${suffix}`,
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

    /**
     * Simulate the NextAuth Prisma adapter creating the User row on a
     * first OAuth sign-in — i.e. AFTER the invite already exists. This is
     * the ordering the production callback sees.
     */
    async function adapterCreatesUser(email: string) {
        return prisma.user.upsert({
            where: { emailHash: hashForLookup(email) },
            create: { email, name: email.split('@')[0] },
            update: {},
        });
    }

    it('attaches the membership to the email-resolved user (not a passed id)', async () => {
        const { tenantId, ownerCtx } = await setupTenant('happy');
        const inviteeEmail = emailFor('invitee');

        // 1. Invite is created BEFORE the user has ever signed in.
        const { invite } = await createInviteToken(ownerCtx, {
            email: inviteeEmail,
            role: 'EDITOR',
        });
        expect(invite.acceptedAt).toBeNull();

        // 2. The invitee signs in for the first time — the adapter now
        //    persists their User row. `redeemPendingInvites` is what the
        //    jwt callback calls, with ONLY the email + cookie token (no id).
        const inviteeUser = await adapterCreatesUser(inviteeEmail);
        // emailVerifiedByIdp:false throughout this suite so these tests
        // keep proving what they claim — that the TOKEN path redeemed the
        // invite. With it true, the verified-email path could redeem the
        // same invite and the assertions would no longer distinguish the
        // two. That path has its own suite (invite-redemption-by-email).
        await redeemPendingInvites({
            userEmail: inviteeEmail,
            tenantToken: invite.token,
            orgToken: null,
            emailVerifiedByIdp: false,
        });

        // 3. Membership must exist for the real, persisted user id.
        const membership = await prisma.tenantMembership.findUnique({
            where: { tenantId_userId: { tenantId, userId: inviteeUser.id } },
            select: { status: true, role: true },
        });
        expect(membership?.status).toBe('ACTIVE');
        expect(membership?.role).toBe('EDITOR');

        // 4. Invite is consumed.
        const consumed = await prisma.tenantInvite.findUnique({
            where: { token: invite.token },
            select: { acceptedAt: true },
        });
        expect(consumed?.acceptedAt).not.toBeNull();
    });

    it('is a no-op when no invite token is present', async () => {
        const { tenantId } = await setupTenant('noop');
        const email = emailFor('noop-user');
        const user = await adapterCreatesUser(email);

        await redeemPendingInvites({
            userEmail: email,
            tenantToken: null,
            orgToken: null,
            emailVerifiedByIdp: false,
        });

        const membership = await prisma.tenantMembership.findUnique({
            where: { tenantId_userId: { tenantId, userId: user.id } },
        });
        expect(membership).toBeNull();
    });

    it('never throws when the invite email does not match (leaves user authenticated)', async () => {
        const { ownerCtx } = await setupTenant('mismatch');
        const invitedEmail = emailFor('invited');
        const { invite } = await createInviteToken(ownerCtx, {
            email: invitedEmail,
            role: 'READER',
        });

        // A DIFFERENT person signs in and somehow carries this token.
        const otherEmail = emailFor('other');
        await adapterCreatesUser(otherEmail);

        // Must swallow the email-binding rejection — sign-in must not fail.
        await expect(
            redeemPendingInvites({
                userEmail: otherEmail,
                tenantToken: invite.token,
                orgToken: null,
                emailVerifiedByIdp: false,
            }),
        ).resolves.toBeUndefined();
    });

    it('proves the OLD path failed: redeeming with a non-persisted id creates no membership', async () => {
        // This is the exact shape of the bug — the signIn callback passed
        // the OAuth subject (a value that is NOT a User.id) to redeemInvite.
        const { tenantId, ownerCtx } = await setupTenant('oldbug');
        const inviteeEmail = emailFor('oldbug-invitee');
        const { invite } = await createInviteToken(ownerCtx, {
            email: inviteeEmail,
            role: 'EDITOR',
        });
        // The invitee exists (created on first sign-in) but we redeem with
        // a bogus provider-subject id instead of resolving by email.
        const inviteeUser = await adapterCreatesUser(inviteeEmail);
        const { redeemInvite } = await import('@/app-layer/usecases/tenant-invites');

        await expect(
            redeemInvite({
                token: invite.token,
                userId: 'oauth-subject-1234567890', // not a real User.id
                userEmail: inviteeEmail,
            }),
        ).rejects.toBeDefined();

        // No membership landed for the actual user — the stranded-invitee bug.
        const membership = await prisma.tenantMembership.findUnique({
            where: { tenantId_userId: { tenantId, userId: inviteeUser.id } },
        });
        expect(membership).toBeNull();
    });
});
