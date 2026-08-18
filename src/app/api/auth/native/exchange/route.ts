/**
 * POST /api/auth/native/exchange — code + PKCE verifier → token pair.
 *
 * The last step of the handoff, and the only one the app performs itself. It
 * reuses P1's issuance primitives, so the resulting credential is a child of
 * the SAME `UserSession` the browser sign-in created — every revocation lever
 * reaches it with no separate bookkeeping.
 *
 * Unauthenticated by construction: the code plus the verifier ARE the
 * credential. Rate-limited at the pre-auth tier accordingly.
 *
 * Every failure returns the same shape, for the same reason the refresh
 * endpoint does: distinguishing "unknown code" from "expired" from "PKCE
 * mismatch" is an oracle, and telling an interceptor precisely which check
 * defeated them is free help.
 */
import { NextRequest, NextResponse } from 'next/server';
import { encode } from 'next-auth/jwt';
import { env } from '@/env';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { withApiErrorHandling } from '@/lib/errors/api';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { exchangeAuthCode } from '@/lib/auth/native/auth-codes';
import {
    ACCESS_TOKEN_TTL_SECONDS,
    issueRefreshToken,
} from '@/lib/auth/native/refresh-tokens';

export const runtime = 'nodejs';

function refused(): NextResponse {
    return NextResponse.json({ error: 'invalid_grant' }, { status: 400 });
}

async function handleExchange(req: NextRequest): Promise<NextResponse> {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return refused();
    }

    const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const code = obj.code;
    const verifier = obj.code_verifier ?? obj.codeVerifier;
    if (typeof code !== 'string' || typeof verifier !== 'string' || !code || !verifier) {
        return refused();
    }

    const claimed = await exchangeAuthCode({ rawCode: code, codeVerifier: verifier });
    if (!claimed.ok) {
        if (claimed.reason === 'pkce_mismatch') {
            logger.warn('native-auth.exchange_pkce_refused', { component: 'native-auth' });
        }
        return refused();
    }

    const sessionRow = await prisma.userSession.findUnique({
        where: { id: claimed.userSessionRowId },
        select: { id: true, sessionId: true, userId: true, tenantId: true, expiresAt: true },
    });
    if (!sessionRow) return refused();

    // Claims come from the single producer (`applyMembershipClaims`), never
    // from anything the client sent — the same rule the refresh endpoint keeps.
    const { buildNativeAccessClaims } = await import('@/auth');
    const claims = await buildNativeAccessClaims({
        userId: sessionRow.userId,
        tenantId: sessionRow.tenantId,
        userSessionId: sessionRow.sessionId,
    });
    if (!claims) return refused();

    const [accessToken, refresh] = await Promise.all([
        encode({ token: claims, secret: env.AUTH_SECRET, maxAge: ACCESS_TOKEN_TTL_SECONDS }),
        issueRefreshToken({
            userSessionRowId: sessionRow.id,
            userId: sessionRow.userId,
            tenantId: sessionRow.tenantId,
            sessionExpiresAt: sessionRow.expiresAt,
        }),
    ]);

    logger.info('native-auth.exchange_completed', {
        component: 'native-auth',
        userId: sessionRow.userId,
        tenantId: sessionRow.tenantId ?? undefined,
    });

    return NextResponse.json({
        accessToken,
        refreshToken: refresh.raw,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshExpiresAt: refresh.expiresAt.toISOString(),
    });
}

export const POST = withApiErrorHandling(handleExchange, {
    rateLimit: { config: LOGIN_LIMIT, scope: 'native-auth-exchange' },
});
