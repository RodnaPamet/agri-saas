/**
 * POST /api/auth/native/apple — an Apple identity token → a token pair (P4.2).
 *
 * The one native sign-in that does NOT go through the system browser. Apple's
 * `ASAuthorizationController` hands the app an identity token directly, so
 * there is no PKCE code to exchange and no browser session to adopt: this
 * route IS the sign-in.
 *
 * Unauthenticated by construction — the identity token is the credential —
 * and rate-limited at the pre-auth tier accordingly.
 *
 * ## It is DORMANT until `APPLE_BUNDLE_ID` is set
 *
 * With no audience configured `verifyAppleIdentityToken` refuses before
 * touching the network, and this route answers 503 `apple_sign_in_disabled`.
 * That status is deliberately NOT folded into the uniform 400 below: it is
 * decided before any token is examined, so it reveals nothing about the token,
 * and an operator who has just pasted three of the four values needs to be
 * able to tell "not configured" from "your token is bad".
 *
 * ## Why the failures are otherwise uniform
 *
 * A bad signature, a wrong audience, an expired token, a mismatched nonce and
 * a REPLAYED nonce are all `invalid_grant`. Separating them tells somebody
 * probing which of five checks defeated them, which is free help; it is the
 * same reasoning `native/exchange` and `token/refresh` keep.
 *
 * `email_required` is the one exception, and it is not an oracle either —
 * it is reached only AFTER the token verified, so it tells a caller holding a
 * valid Apple token something it already knows about its own token.
 *
 * ## First authorisation is the only one that carries an email
 *
 * Apple omits `email` on every sign-in after the first. So the lookup order
 * is: the `Account` row by Apple's stable `sub` FIRST, and the email only
 * when no account exists. Reading the email first would create a second user
 * on every subsequent sign-in — and reading `sub` first means a returning
 * user needs no email at all.
 *
 * ## The user row is created here, WITHOUT consent
 *
 * There is no browser in this flow, so nothing shows the terms before the
 * row exists. The row is therefore created with `acceptedTermsAt` NULL and
 * the Edge consent gate (P3.1) holds the resulting session until the app
 * calls `POST /api/auth/accept-terms` — which is on that gate's allowlist and
 * resolves a bearer. Stamping consent here would file an agreement nobody
 * gave, which is the decision #1376 already made for first-time Google
 * sign-in; this route inherits it rather than re-opening it.
 *
 * So a fresh Apple sign-in returns a token pair whose every tenant and person
 * call answers 403 `terms_required` until the app presents the terms. That is
 * the designed state, not a bug.
 *
 * ## Account linking follows the same rule as the browser
 *
 * An Apple email matching an existing `User` links a new `Account` to that
 * user instead of creating a duplicate — what `authOptions.signIn` does for
 * Google. **Apple's private-relay addresses never match**, by construction:
 * the relay address is unique per app, so a user who hid their email gets a
 * NEW account rather than being linked to the row they created with Google.
 * That is Apple's design and not something this route can see through.
 */
import { NextRequest, NextResponse } from 'next/server';
import { encode } from 'next-auth/jwt';

import { env } from '@/env';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { withApiErrorHandling } from '@/lib/errors/api';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { hashForLookup, hashForLookupCandidates } from '@/lib/security/encryption';
import { verifyAppleIdentityToken, type AppleIdentity } from '@/lib/auth/apple';
import { redeemPendingInvites } from '@/lib/auth/invite-redemption';
import { recordNewSession } from '@/lib/security/session-tracker';
import { SESSION_MAX_AGE_SECONDS } from '@/lib/auth/session-lifetime';
import {
    ACCESS_TOKEN_TTL_SECONDS,
    issueRefreshToken,
} from '@/lib/auth/native/refresh-tokens';

export const runtime = 'nodejs';

/** Apple's provider key in `Account.provider`. Matches the web provider's id. */
const APPLE_PROVIDER = 'apple';

function refused(): NextResponse {
    return NextResponse.json({ error: 'invalid_grant' }, { status: 400 });
}

/**
 * Resolve Apple's `sub` to one of our users, creating the row on first
 * authorisation.
 *
 * The `Account` insert is the claim: `@@unique([provider, providerAccountId])`
 * makes a concurrent second first-sign-in a constraint violation rather than
 * something a read has to notice, so two taps on the Apple button cannot
 * produce two users. On that violation we re-read — the other request won,
 * and its user is the right answer.
 */
async function resolveAppleUser(
    identity: AppleIdentity,
): Promise<{ userId: string } | { error: 'email_required' }> {
    const existing = await prisma.account.findUnique({
        where: {
            provider_providerAccountId: {
                provider: APPLE_PROVIDER,
                providerAccountId: identity.appleUserId,
            },
        },
        select: { userId: true },
    });
    if (existing) return { userId: existing.userId };

    // No account row, so this is a first authorisation and Apple must have
    // sent the email. If it did not, the app requested no email scope — and
    // a user with neither an account nor an address cannot be created or
    // found.
    if (!identity.email) return { error: 'email_required' };
    const email = identity.email;

    const linkTo = await prisma.user.findFirst({
        where: { emailHash: { in: hashForLookupCandidates(email) } },
        select: { id: true },
    });

    try {
        if (linkTo) {
            await prisma.account.create({
                data: {
                    userId: linkTo.id,
                    type: 'oauth',
                    provider: APPLE_PROVIDER,
                    providerAccountId: identity.appleUserId,
                },
            });
            logger.info('apple-signin.account_linked', {
                component: 'apple-signin',
                userId: linkTo.id,
            });
            return { userId: linkTo.id };
        }

        const created = await prisma.user.create({
            data: {
                email,
                emailHash: hashForLookup(email),
                // Apple asserts this, and `verifyAppleIdentityToken` has
                // already proved the assertion came from Apple.
                emailVerified: identity.emailVerified ? new Date() : null,
                // Explicitly null: the consent gate is what asks, and the
                // file docblock says why this route must not stamp it.
                acceptedTermsAt: null,
                accounts: {
                    create: {
                        type: 'oauth',
                        provider: APPLE_PROVIDER,
                        providerAccountId: identity.appleUserId,
                    },
                },
            },
            select: { id: true },
        });
        logger.info('apple-signin.user_created', {
            component: 'apple-signin',
            userId: created.id,
        });
        return { userId: created.id };
    } catch (err) {
        // P2002 on either unique index — `Account(provider, providerAccountId)`
        // or `User.emailHash` — means a concurrent request got there first.
        if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
            const won = await prisma.account.findUnique({
                where: {
                    provider_providerAccountId: {
                        provider: APPLE_PROVIDER,
                        providerAccountId: identity.appleUserId,
                    },
                },
                select: { userId: true },
            });
            if (won) return { userId: won.userId };
        }
        throw err;
    }
}

async function handleAppleSignIn(req: NextRequest): Promise<NextResponse> {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return refused();
    }

    const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const identityToken = obj.identityToken ?? obj.identity_token;
    const rawNonce = obj.nonce ?? obj.rawNonce ?? obj.raw_nonce;
    if (
        typeof identityToken !== 'string' ||
        typeof rawNonce !== 'string' ||
        !identityToken ||
        !rawNonce
    ) {
        return refused();
    }

    const verified = await verifyAppleIdentityToken({
        identityToken,
        rawNonce,
        flow: 'native',
    });
    if (!verified.ok) {
        if (verified.reason === 'not_configured') {
            return NextResponse.json({ error: 'apple_sign_in_disabled' }, { status: 503 });
        }
        return refused();
    }

    const resolved = await resolveAppleUser(verified.identity);
    if ('error' in resolved) {
        return NextResponse.json({ error: resolved.error }, { status: 400 });
    }
    const { userId } = resolved;

    // Honour an invite addressed to this address, exactly as the browser's
    // `jwt` callback does — there is no cookie here, so there is no token to
    // pass, only the verified email. `emailVerifiedByIdp` carries Apple's own
    // claim rather than a bare `true`: the gate that flag opens is "this
    // address is PROVIDER-VERIFIED", and asserting it on Apple's behalf is
    // what `invite-redemption`'s docblock warns against.
    if (verified.identity.email) {
        await redeemPendingInvites({
            userEmail: verified.identity.email,
            // No cookies in this flow, so there is no emailed link to honour —
            // only the address. Spelled out rather than omitted: the fields are
            // required precisely so a caller states that it has none.
            tenantToken: null,
            orgToken: null,
            emailVerifiedByIdp: verified.identity.emailVerified,
        });
    }

    // Two claim builds, on purpose. The browser records its session row AFTER
    // `applyMembershipClaims` has set `token.tenantId`, so the tenant's
    // `sessionMaxAgeMinutes` / `maxConcurrentSessions` policy applies. To get
    // the same here the primary tenant has to be known BEFORE the row is
    // written — and asking the single producer for it costs one read, where
    // picking the membership ourselves would be a second copy of a rule that
    // lives in `applyMembershipClaims`.
    const probe = await buildClaims(userId, null, 'pending');
    if (!probe) return refused();

    const tenantId = probe.tenantId ?? null;
    const recorded = await recordNewSession({
        userId,
        tenantId,
        expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000),
    });

    const claims = await buildClaims(userId, tenantId, recorded.sessionId);
    if (!claims) return refused();

    const [accessToken, refresh] = await Promise.all([
        encode({ token: claims, secret: env.AUTH_SECRET, maxAge: ACCESS_TOKEN_TTL_SECONDS }),
        issueRefreshToken({
            userSessionRowId: recorded.rowId,
            userId,
            tenantId,
            sessionExpiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000),
        }),
    ]);

    logger.info('apple-signin.completed', {
        component: 'apple-signin',
        userId,
        tenantId: tenantId ?? undefined,
        termsPending: claims.termsPending === true,
    });

    return NextResponse.json({
        accessToken,
        refreshToken: refresh.raw,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshExpiresAt: refresh.expiresAt.toISOString(),
        // So the app knows to present the terms rather than discovering it as
        // a 403 on its first real call.
        termsPending: claims.termsPending === true,
    });
}

/** Claims come from the single producer, never from anything the client sent. */
async function buildClaims(userId: string, tenantId: string | null, userSessionId: string) {
    const { buildSessionClaims } = await import('@/auth');
    return buildSessionClaims({ userId, tenantId, userSessionId });
}

export const POST = withApiErrorHandling(handleAppleSignIn, {
    rateLimit: { config: LOGIN_LIMIT, scope: 'native-auth-apple' },
});
