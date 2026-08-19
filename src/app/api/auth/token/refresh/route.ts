/**
 * POST /api/auth/token/refresh — spend a refresh token, get a new pair.
 *
 * Unauthenticated BY CONSTRUCTION: the refresh token is the credential, which
 * is why this sits in the same abuse position as `/api/auth/signin` and is
 * classified 'high' (10/min per IP+UA) rather than inheriting the 'low'
 * default.
 *
 * FAILS CLOSED, unlike per-request verification. `rotateRefreshToken` checks
 * the underlying session live and refuses if it is revoked or expired. That is
 * the moment the revocation window closes for a native client, and it is why
 * refresh can be strict without risking the fleet-wide sign-out that failing
 * closed on every request would cause during a database blip.
 *
 * Every failure returns the SAME shape. A caller must not be able to tell
 * "unknown token" from "revoked" from "replayed" — the first would be an
 * enumeration oracle and the last would tell a thief their replay was noticed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { encode } from 'next-auth/jwt';
import { withApiErrorHandling } from '@/lib/errors/api';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { env } from '@/env';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import {
    ACCESS_TOKEN_TTL_SECONDS,
    rotateRefreshToken,
} from '@/lib/auth/native/refresh-tokens';

export const runtime = 'nodejs';

/** One shape for every failure — see the docblock. */
function refused(): NextResponse {
    return NextResponse.json({ error: 'invalid_grant' }, { status: 401 });
}

async function handleRefresh(req: NextRequest): Promise<NextResponse> {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return refused();
    }

    const refreshToken =
        typeof body === 'object' && body !== null && 'refreshToken' in body
            ? (body as { refreshToken: unknown }).refreshToken
            : undefined;
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
        return refused();
    }

    const rotated = await rotateRefreshToken(refreshToken);
    if (!rotated.ok) {
        // Replay is logged at WARN because it is theft evidence, not traffic.
        // The CALLER still learns nothing — same status, same body.
        if (rotated.reason === 'replayed') {
            logger.warn('native-auth.refresh_replay_refused', {
                component: 'native-auth',
            });
        }
        return refused();
    }

    // Rebuild the access token from the session's CURRENT claims rather than
    // from anything the client sent. A refresh must not be a way to keep stale
    // authority alive: if the user's role or memberships changed, or the tenant
    // was deleted, the new access token has to reflect that.
    const sessionRow = await prisma.userSession.findUnique({
        where: { id: rotated.userSessionId },
        select: { sessionId: true, userId: true, tenantId: true },
    });
    if (!sessionRow) return refused();

    // Reuse the jwt callback's own claim builder by asking it for a fresh
    // token, so `memberships` / `membershipsTruncated` come from the single
    // producer rather than a copy.
    // Imported from `@/auth` so the claims come from the SAME producer the
    // cookie path uses (`applyMembershipClaims`), not a copy of it.
    const { buildSessionClaims } = await import('@/auth');
    const claims = await buildSessionClaims({
        userId: sessionRow.userId,
        tenantId: sessionRow.tenantId,
        userSessionId: sessionRow.sessionId,
    });
    if (!claims) return refused();

    const accessToken = await encode({
        token: claims,
        secret: env.AUTH_SECRET,
        maxAge: ACCESS_TOKEN_TTL_SECONDS,
    });

    logger.info('native-auth.token_refreshed', {
        component: 'native-auth',
        userId: sessionRow.userId,
        tenantId: sessionRow.tenantId ?? undefined,
    });

    return NextResponse.json({
        accessToken,
        refreshToken: rotated.raw,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshExpiresAt: rotated.expiresAt.toISOString(),
    });
}

/**
 * Same wrapper and the same two-layer limit as the issue route. Note the
 * middleware tier is the load-bearing one here: this endpoint is
 * unauthenticated by construction, so a per-userId cap has no user to key on
 * until AFTER the token is validated.
 */
export const POST = withApiErrorHandling(handleRefresh, {
    rateLimit: { config: LOGIN_LIMIT, scope: 'native-token-refresh' },
});
