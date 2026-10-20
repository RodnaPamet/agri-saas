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
import { codedForbidden } from '@/lib/errors/types';
import { resolveMfaRequirement } from '@/lib/auth/mfa-requirement';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { hashForLookup, hashForLookupCandidates } from '@/lib/security/encryption';
import { verifyAppleIdentityToken, type AppleIdentity } from '@/lib/auth/apple';
import { redeemPendingInvites } from '@/lib/auth/invite-redemption';
import { recordNewSession } from '@/lib/security/session-tracker';
import { issueAuthCode } from '@/lib/auth/native/auth-codes';
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
                // Apple's `is_private_email` claim, kept rather than
                // discarded (#1675).
                //
                // The signal is otherwise unrecoverable: `email` is stored
                // encrypted, so no later query can ask which recipients are
                // behind the relay, and the claim arrives only here. That is
                // why it is captured on the way past even though nothing reads
                // it yet — a window that closes, not a feature waiting for a
                // caller.
                //
                // On CREATE only. A relay address is unique per app and never
                // matches an existing row (see this file's docblock), so a
                // relay user always lands here; the account-LINK path above
                // keeps a user whose stored address is their real one, and
                // relabelling it would be a lie about which address we hold.
                isPrivateRelay: identity.isPrivateRelay,

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
    // OPTIONAL, and its presence is the client declaring it understands a 202.
    //
    // The installed app does `guard status == 200`, so a 202 lands in its
    // error branch with no code and shows a meaningless status message, while
    // the 403 gets a real Bulgarian sentence. Making the ticket the new
    // DEFAULT would therefore break every phone already in a pocket. So the
    // request opts in, and a client that sends no challenge keeps the refusal
    // it already handles. Raised by agrent-ios, who would have shipped into it.
    //
    // It doubles as the ticket's PKCE binding, which is the better reason to
    // put it here rather than inventing a version flag: a ticket leaked
    // through a log or a crash report is useless without the verifier, which
    // never leaves the phone's memory.
    const codeChallenge = obj.code_challenge ?? obj.codeChallenge;
    const wantsTicket = typeof codeChallenge === 'string' && codeChallenge.length > 0;
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

    // Refuse BEFORE the session row is written, and the order is the point.
    //
    // The first version of this change put the refusal inside `buildClaims`,
    // which the probe above calls with a null tenant (so the check cannot
    // fire) and which runs again only AFTER `recordNewSession`. Every refused
    // Apple sign-in at a two-factor farm therefore left a `UserSession` row
    // for a session that was never issued — and `recordNewSession` enforces
    // `maxConcurrentSessions`, so on a farm with that limit set, repeated
    // refused attempts would evict the person's real sessions. A refusal that
    // costs the user their other sessions is worse than the gate it enforces.
    //
    // Found because agrent-ios asked whether an abandoned MFA ticket would
    // leave a visible session. It would — and the same flaw was already one
    // step earlier, in the plain refusal.
    const mfa = await resolveMfaRequirement({ userId, tenantId });

    // ── A ticket, and NO session row ───────────────────────────────────
    //
    // Before `recordNewSession`, deliberately. That function enforces
    // `maxConcurrentSessions`, so issuing the ticket after it would let
    // somebody holding only a stolen Apple ID — the first factor alone,
    // precisely who the second factor exists to stop — start sign-in
    // repeatedly and evict the real person's live sessions without ever
    // knowing a code. The session is recorded by `POST /api/auth/native/mfa`
    // once the code passes.
    //
    // The ticket needs no row to be safe: five-minute expiry, no claims, and
    // `/exchange` filters on `purpose = 'SESSION'` so it cannot be found
    // there. Raised by agrent-ios reviewing #1649.
    if (mfa.required && wantsTicket && mfa.enrolled) {
        const ticket = await issueAuthCode({
            userSessionRowId: null,
            userId,
            tenantId,
            codeChallenge: codeChallenge as string,
            // No redirect is involved — the app posts the ticket back itself.
            // A sentinel that is not a URL is the honest value for a NOT NULL
            // column nothing will ever redirect to.
            redirectUri: 'native:mfa',
            purpose: 'PENDING_MFA',
        });

        logger.info('apple-native.mfa_ticket_issued', {
            component: 'apple-native',
            userId,
            tenantId: tenantId ?? undefined,
        });

        return NextResponse.json(
            {
                // A DISCRIMINANT, so a ticket can never decode as a grant or
                // the reverse — agrent-ios's decoder picks a type from the
                // payload, and two shapes differing only by which optional
                // keys are present is how one gets read as the other.
                status: 'mfa_required',
                ticket: ticket.raw,
                expiresIn: Math.max(
                    0,
                    Math.floor((ticket.expiresAt.getTime() - Date.now()) / 1000),
                ),
            },
            { status: 202 },
        );
    }

    if (mfa.required || mfa.dependencyFailure) {
        // Either the client cannot collect a code (no `code_challenge`, so an
        // older build) or there is no authenticator to collect one with.
        // Both are refusals: nothing is minted and no session row is written.
        await assertMfaNotOwed(userId, tenantId, mfa, wantsTicket);
    }

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

/**
 * Claims come from the single producer, never from anything the client sent.
 *
 * Returns `null` when the membership owes a second factor. Apple sign-in
 * happens natively, with no browser sheet to type a code into and no code
 * screen in the app yet — so there is nowhere to satisfy the requirement and
 * the only sound answers are "refuse" or "let them in without it". Refusing
 * is the one that is not a bypass. The other native providers do not need
 * this because their code is typed in the sign-in sheet and the gate sits at
 * auth-code issuance; this route has no such point.
 *
 * `resolveMfaRequirement` is read-only and shares its rule with the sign-in
 * path, so a tenant that has not enabled MFA is unaffected — measured when
 * this landed: zero farms had a policy set and nobody was enrolled, so no
 * live Apple user was refused by it.
 */
async function buildClaims(userId: string, tenantId: string | null, userSessionId: string) {
    const { buildSessionClaims } = await import('@/auth');
    // 'inherit-satisfied': the MFA gate is in the HANDLER, ahead of
    // `recordNewSession` — see `assertMfaNotOwed`'s call site for why that
    // order matters. Deliberately ONE refusal point rather than a second
    // check here that could drift out of agreement with it.
    return buildSessionClaims({ userId, tenantId, userSessionId, mfa: 'inherit-satisfied' });
}

/**
 * Refuse an Apple sign-in that owes a second factor.
 *
 * Apple sign-in happens natively, with no browser sheet to type a code into
 * and no code screen in the app yet — so there is nowhere to satisfy the
 * requirement and the only sound answers are "refuse" or "let them in
 * without it". Refusing is the one that is not a bypass. The other native
 * providers need nothing here: their code is typed in the sign-in sheet and
 * the gate sits at auth-code issuance, which this route has no equivalent of.
 *
 * MUST be called before `recordNewSession`. See the call site.
 *
 * `resolveMfaRequirement` is read-only and shares its rule with the sign-in
 * path, so a farm that has not enabled MFA is unaffected — measured when this
 * landed: zero farms had a policy set and nobody was enrolled, so no live
 * Apple user is refused by it today.
 */
async function assertMfaNotOwed(
    userId: string,
    tenantId: string | null,
    mfa: Awaited<ReturnType<typeof resolveMfaRequirement>>,
    /**
     * Whether the client sent a `code_challenge` — i.e. whether it has opted
     * into this change at all.
     */
    clientOptedIn: boolean,
): Promise<void> {
    // A check that could not complete refuses too: "we could not find out"
    // has to fall the same way as "yes", or a session that may owe a factor
    // gets minted.
    if (!mfa.required && !mfa.dependencyFailure) return;

    if (mfa.required && !mfa.enrolled && !mfa.dependencyFailure && clientOptedIn) {
        // A THIRD state, and its own code. This farm requires a factor the
        // person cannot produce: there is no verified authenticator, so there
        // is no shared secret to check a code against. A challenge screen here
        // would ask for a code from an app they never set up.
        //
        // The remedy is enrolment on the web, which is a different sentence
        // from "use another provider" — so it must not share `MFA_REQUIRED`.
        // agrent-ios asked for the split precisely because they would
        // otherwise show the wrong one. Google and Microsoft hit the same wall
        // in the sign-in sheet, where the enrolment page's `otpauth://` link
        // (#1646) is what gets a phone out of it.
        logger.warn('apple-native.mfa_enrolment_required', {
            component: 'apple-native',
            userId,
        });
        throw codedForbidden(
            'MFA_ENROLLMENT_REQUIRED',
            'This farm requires a second factor and this account has none set up yet. Set up an authenticator from the web, then sign in again.',
        );
    }

    logger.warn('apple-native.mfa_required_refused', {
        component: 'apple-native',
        dependencyFailure: mfa.dependencyFailure,
    });
    // A CODE and not `refused()`. That helper answers `invalid_grant`/400 and
    // is deliberately opaque, which is right for a bad Apple token — telling a
    // caller why its token failed helps nobody but an attacker. This is the
    // opposite case: the farm's own policy requiring a second factor is no
    // secret from the person signing in, and the app has to be able to SAY so.
    // `MFA_REQUIRED` already exists in the middleware and the tenant context
    // and is documented in the error helpers, so this adds no vocabulary.
    throw codedForbidden(
        'MFA_REQUIRED',
        'This farm requires a second factor, which Apple sign-in cannot yet collect. Sign in with Google or Microsoft, or from the web.',
    );
}

export const POST = withApiErrorHandling(handleAppleSignIn, {
    rateLimit: { config: LOGIN_LIMIT, scope: 'native-auth-apple' },
});
