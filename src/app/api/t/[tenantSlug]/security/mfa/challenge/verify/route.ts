import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { VerifyMfaInput } from '@/app-layer/schemas/mfa.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { MFA_VERIFY_LIMIT } from '@/lib/security/rate-limit';
import {
    checkRateLimitDistributed,
    resetRateLimitDistributed,
} from '@/lib/security/rate-limit-middleware';
import { verifyMfaChallenge } from '@/app-layer/usecases/mfa-challenge';
import { env } from '@/env';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/security/mfa/challenge/verify
 *
 * Verifies a TOTP code during the MFA challenge (login flow).
 * On success, clears the mfaPending flag by updating lastChallengeAt.
 *
 * Rate limited: 5 attempts per 15 min, 5 min lockout.
 *
 * Body: { code: "123456" }
 */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
) => {
    // Get current session
    // DELIBERATELY the raw `auth()`, and the one route under `src/app/api`
    // that still is. Owner ruling on #1652: this is part of SIGN-IN, so
    // refusing a suspended account here surfaces as a failure at the MFA step
    // and reads as "your code is wrong" rather than "your account is
    // suspended". Better to let the challenge succeed and refuse at the first
    // real request, which carries the sentence that explains it.
    //
    // `tests/guards/api-routes-resolve-sessions-through-the-gate.test.ts` holds
    // the direct-`auth()` count at zero and carries this file as its single
    // allowlist entry with that reason. Migrating it to
    // `authRefusingSuspended` is a product change, not a cleanup.
    const session = await auth();
    if (!session?.user?.id) {
        return jsonResponse({ error: 'Not authenticated' }, { status: 401 });
    }

    const userId = session.user.id;
    const tenantId = session.user.tenantId;

    if (!tenantId) {
        return jsonResponse({ error: 'No tenant context' }, { status: 400 });
    }

    // ── Rate Limit Check ────────────────────────────────────────────
    const rateLimitKey = `mfa-challenge:${userId}`;
    const rateCheck = await checkRateLimitDistributed(rateLimitKey, MFA_VERIFY_LIMIT);

    if (!rateCheck.allowed) {
        const retrySeconds = Math.ceil(rateCheck.retryAfterMs / 1000);
        return jsonResponse(
            {
                success: false,
                error: `Too many verification attempts. Please try again in ${retrySeconds} seconds.`,
                retryAfterMs: rateCheck.retryAfterMs,
            },
            { status: 429 },
        );
    }

    // Parse body
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid request' }, { status: 400 });
    }

    const parsed = VerifyMfaInput.safeParse(body);
    if (!parsed.success) {
        return jsonResponse(
            { error: 'Invalid code format' },
            { status: 400 },
        );
    }

    // Delegate to usecase
    const result = await verifyMfaChallenge(userId, tenantId, parsed.data.code, rateCheck.remaining);

    if (!result.success) {
        return jsonResponse({
            success: false,
            error: result.message,
            remaining: result.remaining,
        });
    }

    // Reset rate limit on success
    await resetRateLimitDistributed(rateLimitKey);

    const response = jsonResponse({
        success: true,
        message: result.message,
    });

    // Set mfa-cleared cookie for JWT callback to detect
    response.cookies.set('mfa-cleared', userId, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 300,
        secure: env.NODE_ENV === 'production',
    });

    return response;
});
