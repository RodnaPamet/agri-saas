/**
 * GET /api/auth/native/complete — mint the code and hand it to the app.
 *
 * Reached by the SYSTEM browser after NextAuth's Google flow has set a session
 * cookie. Reads the handoff cookie, mints a short-lived PKCE-bound code against
 * the session that now exists, and redirects to the app's URI with the CODE and
 * nothing else.
 *
 * THE EPIC 1 TRAP, and why this route is safe from it.
 *
 * Invite redemption originally ran in the `signIn` callback and wrote
 * memberships against a non-existent `User` FK, because a first-time OAuth
 * user's `user.id` is the IDENTITY-PROVIDER SUBJECT until the Prisma adapter
 * creates the row — which happens after `signIn` returns. It was moved to the
 * `jwt` callback for exactly that reason (`src/lib/auth/invite-redemption.ts`).
 *
 * This route runs later still: it is a normal request carrying a session
 * cookie, so the adapter has already committed the `User` row AND the `jwt`
 * callback has already run `recordNewSession`. Both `userId` and
 * `userSessionId` therefore resolve to real rows for a first-time user.
 *
 * That is a claim worth enforcing rather than trusting, so the absence of a
 * session row is refused explicitly below instead of being papered over — a
 * code minted against a session that does not exist would exchange into tokens
 * hanging off nothing, i.e. an unrevocable credential.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { env } from '@/env';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { withApiErrorHandling } from '@/lib/errors/api';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import {
    issueAuthCode,
    classifyRedirect,
    HANDOFF_COOKIE,
} from '@/lib/auth/native/auth-codes';

export const runtime = 'nodejs';


function allowlist(): string[] {
    return env.NATIVE_AUTH_REDIRECT_ALLOWLIST.split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

async function handleComplete(req: NextRequest): Promise<NextResponse> {
    const raw = req.cookies.get(HANDOFF_COOKIE)?.value;
    if (!raw) return NextResponse.json({ error: 'no_handoff' }, { status: 400 });

    let handoff: { redirectUri?: unknown; codeChallenge?: unknown };
    try {
        handoff = JSON.parse(raw);
    } catch {
        return NextResponse.json({ error: 'invalid_handoff' }, { status: 400 });
    }

    const redirectUri = typeof handoff.redirectUri === 'string' ? handoff.redirectUri : null;
    const codeChallenge = typeof handoff.codeChallenge === 'string' ? handoff.codeChallenge : null;
    if (!redirectUri || !codeChallenge) {
        return NextResponse.json({ error: 'invalid_handoff' }, { status: 400 });
    }

    // Re-validate on the way OUT as well as on the way in. The cookie is
    // HttpOnly, but a check that only runs at /start would be one tampering
    // primitive away from an open redirect carrying a live code.
    const verdict = classifyRedirect(redirectUri, allowlist());
    if (verdict !== 'allowed') {
        // The response is identical either way, deliberately — this route is
        // unauthenticated and must not tell an anonymous caller whether our
        // allowlist is empty. The LOG carries the distinction, because
        // "misconfigured server" and "misbehaving client" need different fixes
        // and answering `redirect_uri_not_allowed` to both is what made the
        // 2026-08-21 production outage of this flow undiagnosable.
        if (verdict === 'allowlist_unconfigured') {
            logger.error('native-auth.redirect_allowlist_unconfigured', {
                component: 'native-auth',
                msg: 'NATIVE_AUTH_REDIRECT_ALLOWLIST is empty, so native sign-in refuses EVERY redirect. This is configuration, not a bad client.',
            });
        } else {
            logger.warn('native-auth.redirect_not_on_allowlist', { component: 'native-auth' });
        }
        return NextResponse.json({ error: 'redirect_uri_not_allowed' }, { status: 400 });
    }

    const token = await getToken({ req, secret: env.AUTH_SECRET });
    if (!token) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });

    // The IdP-verified-email property, preserved. `src/auth.ts` sets
    // `emailVerifiedByIdp: account.provider !== 'credentials'` because the
    // credentials provider's email is SELF-ASSERTED. Nothing here lets a native
    // client assert an identity: every claim below is read from the
    // server-minted session token, and the client contributes only its PKCE
    // challenge and redirect URI.
    const externalSessionId = token.userSessionId;
    if (typeof externalSessionId !== 'string' || !externalSessionId) {
        return NextResponse.json({ error: 'session_not_tracked' }, { status: 409 });
    }

    const sessionRow = await prisma.userSession.findUnique({
        where: { sessionId: externalSessionId },
        select: { id: true, userId: true, tenantId: true, revokedAt: true, expiresAt: true },
    });
    if (!sessionRow || sessionRow.revokedAt || sessionRow.expiresAt.getTime() <= Date.now()) {
        return NextResponse.json({ error: 'session_invalid' }, { status: 401 });
    }

    // ── The second factor is owed here, or nowhere ─────────────────────
    //
    // This is the ONLY point in the native flow where the browser cookie is
    // still authoritative, which makes it the only point where the gate can
    // both be enforced and be CLEARED. Everything downstream — the code, the
    // exchange, every refresh — inherits from the decision made here, so a
    // code must not exist until the factor is satisfied.
    //
    // Why not gate further down instead: `buildSessionClaims` mints a fresh
    // token with a new `iat`, and the cookie's clearing rule compares the
    // enrollment's `lastChallengeAt` against `iat`. A requirement applied to
    // a freshly-minted token is therefore one that can never clear — every
    // refresh would re-challenge, which is a lockout rather than a gate.
    //
    // Why not rely on the middleware: `/api/auth/*` is a public path and
    // returns before §4, and §4 only covers tenant and person paths anyway.
    // It cannot see this route.
    if (token.mfaPending === true) {
        // Send them to the challenge, carrying this path as `next` so the
        // flow resumes here afterwards. The PKCE challenge and redirect_uri
        // do NOT need to ride along: they live in the HttpOnly handoff cookie
        // that `/start` set, which survives the round trip on its own. (An
        // earlier version of this comment said they were in the query string.
        // They are not, and a test asserting it is what caught that.)
        //
        // The user is in the sign-in browser sheet, so a page is the right
        // answer here and the phone needs no new screen.
        const slug = typeof token.tenantSlug === 'string' ? token.tenantSlug : null;
        if (slug) {
            const next = req.nextUrl.pathname;
            const mfa = new URL(`/t/${slug}/auth/mfa`, req.nextUrl.origin);
            mfa.searchParams.set('next', next);
            logger.info('native-auth.mfa_required', {
                component: 'native-auth',
                userId: typeof token.userId === 'string' ? token.userId : undefined,
            });
            return NextResponse.redirect(mfa);
        }
        // No slug to send them to. Refuse rather than fall through: falling
        // through is the one outcome that makes this gate a no-op for the case
        // it cannot classify.
        logger.warn('native-auth.mfa_required_without_slug', { component: 'native-auth' });
        return NextResponse.json({ error: 'mfa_required' }, { status: 403 });
    }

    const code = await issueAuthCode({
        userSessionRowId: sessionRow.id,
        userId: sessionRow.userId,
        tenantId: sessionRow.tenantId,
        codeChallenge,
        redirectUri,
    });

    logger.info('native-auth.code_issued', {
        component: 'native-auth',
        userId: sessionRow.userId,
        tenantId: sessionRow.tenantId ?? undefined,
    });

    // ONLY the code travels. A token here would be written to browser history
    // and handed to whatever app claims the scheme.
    const target = new URL(redirectUri);
    target.searchParams.set('code', code.raw);

    const res = NextResponse.redirect(target.toString());
    res.cookies.set(HANDOFF_COOKIE, '', { maxAge: 0, path: '/' });
    return res;
}

export const GET = withApiErrorHandling(handleComplete, {
    rateLimit: { config: LOGIN_LIMIT, scope: 'native-auth-complete' },
});
