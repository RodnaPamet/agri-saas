/**
 * Post-sign-in invite redemption.
 *
 * Redeems a pending tenant / org invite for a user who has JUST signed in,
 * resolving the PERSISTED `User.id` by email rather than trusting a
 * caller-supplied id.
 *
 * Why resolve by email:
 *
 *   In the NextAuth `signIn` callback a FIRST-TIME OAuth user's `user.id`
 *   is the identity-provider subject (Google `sub`, …), NOT our `User.id`
 *   — the Prisma adapter creates the row only AFTER `signIn` returns. The
 *   previous code redeemed there with that subject, so the membership
 *   upsert wrote against a non-existent `User` FK: the write threw, the
 *   error was swallowed (sign-in must not fail on a redemption problem),
 *   the invite was already burnt (`acceptedAt` committed in step 1 of
 *   `redeemInvite`), and the brand-new invitee landed on `/no-tenant` with
 *   a dead link. Returning invitees dodged it only because the signIn
 *   account-linking branch happened to resolve their real id.
 *
 *   Running from the `jwt` callback (which fires AFTER the adapter has
 *   created the row) and resolving the id by email fixes it uniformly for
 *   OAuth and credentials sign-ins alike.
 *
 * Best-effort: never throws. A failure logs and leaves the user
 * authenticated — they can be re-invited. This preserves the swallow
 * semantics the redemption has always had at the sign-in boundary.
 */
import prisma from '@/lib/prisma';
import { hashForLookup } from '@/lib/security/encryption';
import { edgeLogger } from '@/lib/observability/edge-logger';

export interface RedeemPendingInvitesInput {
    /** The signed-in user's email — the binding key for the invite. */
    userEmail: string;
    /** Raw tenant-invite token from the `inflect_invite_token` cookie, or null. */
    tenantToken: string | null;
    /** Raw org-invite token from the `inflect_org_invite_token` cookie, or null. */
    orgToken: string | null;
    /**
     * True when the sign-in came from an OAuth IdP, so `userEmail` is
     * PROVIDER-VERIFIED. Gates the token-free, email-matched provisioning
     * below.
     *
     * MUST be false for the credentials provider. Self-service
     * registration lets anyone submit any address, and email
     * verification is OPTIONAL there — `AUTH_REQUIRE_EMAIL_VERIFICATION`
     * defaults to "0" (see src/lib/auth/credentials.ts), so a credentials
     * sign-in proves possession of a password, not of an address.
     * Honouring an invite on that basis would hand a tenant to whoever
     * guessed an invited email.
     *
     * `src/auth.ts` gives the other half of the guarantee: its signIn
     * callback rejects `email_verified === false`, so an OAuth provider
     * that reports the address as unverified never reaches here either.
     *
     * If credentials sign-ins ever need this, the condition is a VERIFIED
     * email — not merely the credentials provider — so the caller would
     * pass `AUTH_REQUIRE_EMAIL_VERIFICATION === '1' && user.emailVerified`,
     * never a bare `true`.
     */
    emailVerifiedByIdp: boolean;
}

/**
 * Redeem whichever invite tokens are present, against the persisted user
 * resolved by `userEmail`. No-op when neither token is present or no user
 * row exists yet. Each redemption is independently best-effort.
 */
export async function redeemPendingInvites(
    input: RedeemPendingInvitesInput,
): Promise<void> {
    const { userEmail, tenantToken, orgToken, emailVerifiedByIdp } = input;
    // Nothing to do only when there is no token AND no verified email to
    // match pending invites against.
    if (!tenantToken && !orgToken && !emailVerifiedByIdp) return;

    // Resolve the PERSISTED user id by email. From the jwt callback this
    // row always exists (created by the adapter before jwt runs), even for
    // a first-time OAuth user whose signIn-callback `user.id` was the
    // provider subject.
    const dbUser = await prisma.user.findUnique({
        where: { emailHash: hashForLookup(userEmail) },
        select: { id: true },
    });
    if (!dbUser) return;

    if (tenantToken) {
        try {
            const { redeemInvite } = await import('@/app-layer/usecases/tenant-invites');
            await redeemInvite({ token: tenantToken, userId: dbUser.id, userEmail });
        } catch (err) {
            edgeLogger.warn('signIn: tenant invite redemption failed', {
                component: 'auth',
                userId: dbUser.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Token-free provisioning: redeem any pending invite addressed to this
    // verified email. This is what makes the emailed link OPTIONAL — an
    // admin adds the member, the member signs in, they are in. It is not
    // auto-join: with no pending invite for the address it is a no-op.
    if (emailVerifiedByIdp) {
        try {
            const { redeemPendingInvitesByEmail } = await import(
                '@/app-layer/usecases/tenant-invites'
            );
            const redeemed = await redeemPendingInvitesByEmail({
                userId: dbUser.id,
                userEmail,
            });
            if (redeemed.length > 0) {
                edgeLogger.info('signIn: provisioned membership from pending invite', {
                    component: 'auth',
                    userId: dbUser.id,
                    tenantCount: redeemed.length,
                });
            }
        } catch (err) {
            edgeLogger.warn('signIn: verified-email invite provisioning failed', {
                component: 'auth',
                userId: dbUser.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (orgToken) {
        try {
            const { redeemOrgInvite } = await import('@/app-layer/usecases/org-invites');
            await redeemOrgInvite({ token: orgToken, userId: dbUser.id, userEmail });
        } catch (err) {
            edgeLogger.warn('signIn: org invite redemption failed', {
                component: 'auth',
                userId: dbUser.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}
