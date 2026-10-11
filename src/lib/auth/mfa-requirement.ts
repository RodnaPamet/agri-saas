/**
 * Does this membership owe a second factor — ONE producer for that answer.
 *
 * ## Why it is its own module
 *
 * The answer was computed inline in the NextAuth `jwt` callback and nowhere
 * else, which meant every other way a session can be minted silently decided
 * "no". `buildSessionClaims` — the function the native exchange, the Apple
 * route and every token refresh all go through, and whose own comment calls
 * it "the single producer" of claims — set `termsPending` and never
 * `mfaPending`. Both gates that read it (`middleware.ts` §4 and the tenant
 * context) test `=== true`, so an ABSENT claim passes. One producer for the
 * requirement, consulted by every mint path, is the shape that cannot drift
 * like that again.
 *
 * ## What it deliberately does NOT decide
 *
 * Whether a given token has SATISFIED the requirement. That is a different
 * question with a different answer per mint path, and conflating the two is
 * how a fix here turns into a lockout:
 *
 *   * The cookie session clears itself by comparing the enrollment's
 *     `lastChallengeAt` against the token's `iat` — a later challenge clears
 *     an earlier token. That works because the cookie token is MUTATED across
 *     requests, so its `iat` stays at sign-in time.
 *   * `buildSessionClaims` mints a FRESH token with a NEW `iat`. Applying the
 *     same comparison there would compare a challenge against a timestamp
 *     that is always newer, so the claim could never clear and every refresh
 *     would re-challenge — a permanent loop rather than a gate.
 *
 * So the native flow is gated where the cookie is still authoritative: at
 * auth-code issuance. See `api/auth/native/complete`.
 */
import { prisma } from '@/lib/prisma';

export interface MfaRequirement {
    /** The tenant's policy obliges this user to present a second factor. */
    required: boolean;
    /** The tenant wants an unavailable MFA check to DENY rather than allow. */
    failClosed: boolean;
    /**
     * The check could not complete. With `failClosed` the caller must treat
     * the requirement as present; without it, as absent. Surfaced rather than
     * folded into `required` so a caller can log the difference between "this
     * user owes a code" and "we could not find out".
     */
    dependencyFailure: boolean;
    /**
     * The user has a VERIFIED authenticator for this tenant.
     *
     * Separate from `required` because the two combine into three states, not
     * two, and the third needs its own answer: a tenant on REQUIRED whose
     * user has never enrolled owes a factor that CANNOT be collected — there
     * is no shared secret to verify against. A challenge screen there would
     * ask for a code from an authenticator the person has not set up.
     *
     * The remedy is enrolment on the web, which is a different sentence from
     * "use another provider", so it needs a different code
     * (`MFA_ENROLLMENT_REQUIRED` rather than `MFA_REQUIRED`). Raised by
     * agrent-ios, who would otherwise have had to show the wrong one.
     */
    enrolled: boolean;
}

/** No tenant, no membership-scoped policy — MFA is enrolled per tenant. */
const NONE: MfaRequirement = {
    required: false,
    failClosed: false,
    dependencyFailure: false,
    enrolled: false,
};

/**
 * Resolve the requirement for one user in one tenant.
 *
 * Mirrors the sign-in path's rule exactly: REQUIRED always obliges a factor;
 * OPTIONAL obliges one only once the user has a VERIFIED enrollment, so
 * turning the policy on does not lock out people who have not set up an
 * authenticator yet.
 */
export async function resolveMfaRequirement(input: {
    userId: string;
    tenantId: string | null;
}): Promise<MfaRequirement> {
    if (!input.tenantId) return NONE;

    try {
        const settings = await prisma.tenantSecuritySettings.findUnique({
            where: { tenantId: input.tenantId },
            select: { mfaPolicy: true, mfaFailClosed: true },
        });
        const failClosed = settings?.mfaFailClosed ?? false;
        const policy = settings?.mfaPolicy ?? 'DISABLED';

        if (policy === 'DISABLED') {
            // No enrolment read: nothing downstream can act on it, and this
            // is the common path for every farm that has not turned MFA on.
            return { required: false, failClosed, dependencyFailure: false, enrolled: false };
        }

        const enrollment = await prisma.userMfaEnrollment.findUnique({
            where: {
                userId_tenantId_type: {
                    userId: input.userId,
                    tenantId: input.tenantId,
                    type: 'TOTP',
                },
            },
            select: { isVerified: true },
        });
        const enrolled = enrollment?.isVerified === true;

        // REQUIRED always obliges a factor, enrolled or not — the caller
        // decides whether that means "present a code" or "go and enrol".
        // OPTIONAL obliges one only once a verified authenticator exists, so
        // turning the policy on does not lock out people who have not set one
        // up yet.
        return {
            required: policy === 'REQUIRED' || enrolled,
            failClosed,
            dependencyFailure: false,
            enrolled,
        };
    } catch {
        // The caller decides. `failClosed` is unknown here because reading it
        // is what failed, so report the failure and let the caller apply its
        // own default — the sign-in path holds the session, and a route that
        // cannot verify refuses.
        return { required: false, failClosed: false, dependencyFailure: true, enrolled: false };
    }
}
