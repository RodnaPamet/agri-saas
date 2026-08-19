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
import { issueAuthCode, isAllowedRedirect } from '@/lib/auth/native/auth-codes';

export const runtime = 'nodejs';

const HANDOFF_COOKIE = 'agrent-native-handoff';

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
    if (!isAllowedRedirect(redirectUri, allowlist())) {
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
