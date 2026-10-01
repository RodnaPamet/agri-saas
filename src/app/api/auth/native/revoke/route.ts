/**
 * POST /api/auth/native/revoke — sign THIS DEVICE out.
 *
 * Unauthenticated BY CONSTRUCTION, like `/token/refresh`: the refresh token IS
 * the credential. Same abuse position, so the same pre-auth rate-limit tier.
 *
 * ── it answers 200 even for a token it has never seen ──
 *
 * RFC 7009: a revocation endpoint responds 200 both when it revoked something
 * and when the token was invalid. Two reasons that is right here rather than
 * merely permissive:
 *
 *   · an oracle — 404 for unknown and 200 for known would let anyone holding a
 *     candidate token ask whether it exists;
 *   · idempotency — sign-out is retried on a flaky network, and a second attempt
 *     must not surface an error for work that already succeeded.
 *
 * So the client cannot learn whether anything happened, and does not need to:
 * it drops its tokens regardless. A malformed body is the one exception, because
 * that is the caller's own bug rather than a statement about any token.
 *
 * ── why this exists at all ──
 *
 * `/api/auth/logout` clears a cookie and nothing else, and the three real revoke
 * routes are tenant-scoped (`/api/t/{slug}/security/sessions/...`). A native
 * sign-out is not tenant-scoped — the user is leaving the app, and may hold
 * several farms. Without this, clearing local state leaves the refresh token
 * valid, so anything holding it can mint a fresh access token after "sign-out".
 * See #1204.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { logger } from '@/lib/observability/logger';
import { revokeSessionByRefreshToken } from '@/lib/auth/native/refresh-tokens';

export const runtime = 'nodejs';

/** One answer for every outcome — see the docblock. */
const ACKNOWLEDGED = () => NextResponse.json({ revoked: true }, { status: 200 });

async function handleRevoke(req: NextRequest): Promise<NextResponse> {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }

    const refreshToken =
        typeof body === 'object' && body !== null && 'refreshToken' in body
            ? (body as { refreshToken: unknown }).refreshToken
            : undefined;
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }

    const { matched } = await revokeSessionByRefreshToken(refreshToken, 'native_sign_out');

    // Logged at INFO with no token material. The `matched` flag stays server-side
    // precisely because the response must not carry it.
    logger.info('native-auth.session_revoked', {
        component: 'native-auth',
        matched,
    });

    return ACKNOWLEDGED();
}

export const POST = withApiErrorHandling(handleRevoke, {
    rateLimit: { config: LOGIN_LIMIT, scope: 'native-session-revoke' },
});
