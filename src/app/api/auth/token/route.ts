/**
 * POST /api/auth/token — mint a native token pair from the CURRENT session.
 *
 * This is the primitive. A caller that already holds a valid session cookie
 * exchanges it for an access + refresh pair bound to the SAME `UserSession`
 * row, so the native credential is a continuation of that session rather than
 * a new one. The OAuth system-browser handoff builds on this rather than
 * minting independently.
 *
 * ROUTING: `[...nextauth]` is a catch-all in this directory, but Next gives
 * static segments priority, which is why `register`, `ui-config`,
 * `change-password` and six other siblings already work here. Verified against
 * those rather than assumed.
 *
 * RATE LIMIT: `/api/auth/**` is handled by `checkAuthRateLimit` in middleware,
 * and `/api/auth/token*` is explicitly classified 'high' (10/min per IP+UA)
 * rather than inheriting the 'low' default meant for `/csrf`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getToken, encode } from 'next-auth/jwt';
import { withApiErrorHandling } from '@/lib/errors/api';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { env } from '@/env';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import {
    ACCESS_TOKEN_TTL_SECONDS,
    issueRefreshToken,
} from '@/lib/auth/native/refresh-tokens';

export const runtime = 'nodejs';

async function handleIssue(req: NextRequest): Promise<NextResponse> {
    // The SAME locator middleware uses. A cookie authenticates this call; a
    // bearer would too, which is intentional — a native client rotating to a
    // fresh device pair is the same operation.
    const token = await getToken({ req, secret: env.AUTH_SECRET });
    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (typeof token.error === 'string' && token.error.length > 0) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const externalSessionId = token.userSessionId;
    if (typeof externalSessionId !== 'string' || !externalSessionId) {
        // A token with no session lineage cannot produce a revocable
        // credential, and issuing one anyway is the exact failure this design
        // exists to prevent. Refuse rather than mint something unkillable.
        return NextResponse.json(
            { error: 'session_not_tracked' },
            { status: 409 },
        );
    }

    // `token.userSessionId` is the EXTERNAL sessionId claim; the refresh token
    // FK needs the row's primary key. Looking it up also proves the row is
    // live, which is why this is not merely a translation step.
    const session = await prisma.userSession.findUnique({
        where: { sessionId: externalSessionId },
        select: { id: true, expiresAt: true, revokedAt: true, userId: true, tenantId: true },
    });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
        return NextResponse.json({ error: 'session_invalid' }, { status: 401 });
    }

    const refresh = await issueRefreshToken({
        userSessionRowId: session.id,
        userId: session.userId,
        tenantId: session.tenantId,
        sessionExpiresAt: session.expiresAt,
    });

    // The access token is the SAME claims, re-encoded with a short lifetime.
    // Re-encoding rather than rebuilding is deliberate: `applyMembershipClaims`
    // is the only producer of `memberships` / `membershipsTruncated`, and a
    // second producer that missed its ACTIVE filter or 50-item slice would be
    // silently more permissive than the cookie.
    const { exp: _exp, iat: _iat, jti: _jti, ...claims } = token;
    const accessToken = await encode({
        token: claims,
        secret: env.AUTH_SECRET,
        maxAge: ACCESS_TOKEN_TTL_SECONDS,
    });

    logger.info('native-auth.token_issued', {
        component: 'native-auth',
        userId: session.userId,
        tenantId: session.tenantId ?? undefined,
        userSessionId: session.id,
    });

    return NextResponse.json({
        accessToken,
        refreshToken: refresh.raw,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshExpiresAt: refresh.expiresAt.toISOString(),
    });
}

/**
 * Wrapped like every sibling under `/api/auth/**`, so an unhandled throw
 * becomes a structured error with a request id rather than a stack.
 *
 * TWO rate limits apply and that is deliberate, not redundant: middleware's
 * `checkAuthRateLimit` caps this path at 10/min per (IP, ua-hash) BEFORE the
 * handler runs — the right key pre-authentication — and `LOGIN_LIMIT` here adds
 * a per-(IP, userId) cap for a caller that is already authenticated. The
 * stricter of the two governs; neither alone covers both key shapes.
 */
export const POST = withApiErrorHandling(handleIssue, {
    rateLimit: { config: LOGIN_LIMIT, scope: 'native-token-issue' },
});
