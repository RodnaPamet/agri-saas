/**
 * POST /api/auth/verify-email/resend   body: { email: string }
 *
 * Re-issue an email verification link. Always returns 200 + an
 * empty-ish success payload regardless of whether:
 *   - the email is actually registered
 *   - the account is already verified
 *   - the rate limit is tripped
 *   - the mailer itself errored
 *
 * That uniform response is deliberate: any variation in status code,
 * body, or latency would leak whether a given address is registered.
 *
 * Per-identifier rate limiting still runs (via the same Upstash/
 * memory bucket the login chokepoint uses) so an attacker can't
 * flood verification emails to arbitrary third-party addresses.
 */

import { NextResponse, type NextRequest } from 'next/server';

import prisma from '@/lib/prisma';
import { checkCredentialsAttempt } from '@/lib/auth/credential-rate-limit';
import { issueEmailVerification } from '@/lib/auth/email-verification';
import { hashForLookup, hashForLookupCandidates } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';

interface ResendBody {
    email?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    const body: ResendBody = await req.json().catch(() => ({}));
    const email = (body.email ?? '').trim().toLowerCase();

    // Uniform no-op response shape — this is what the client always sees.
    const uniformOk = NextResponse.json(
        { ok: true, message: 'If that account exists, a verification email has been sent.' },
        { status: 200 },
    );

    if (!email) return uniformOk;

    // Rate limit gate — intentionally shares the per-email bucket with
    // the login chokepoint. A user who hit the lockout by fat-fingering
    // their password already can't spam themselves with resend emails.
    const rl = await checkCredentialsAttempt(email);
    if (!rl.ok) {
        logger.warn('verification resend rate-limited', {
            component: 'auth',
            event: 'verification_resend_rate_limited',
            retryAfterSeconds: rl.retryAfterSeconds,
        });
        return uniformOk;
    }

    try {
        const user = await prisma.user.findFirst({
            where: { emailHash: { in: hashForLookupCandidates(email) } },
            select: { id: true, emailVerified: true },
        });
        if (!user) return uniformOk;            // Unknown email — uniform response
        if (user.emailVerified) return uniformOk; // Already verified — no need to re-issue

        // `flow: 'resend'` threads through to the OTel metric so
        // operators can pivot the verification-mail failure-rate
        // dashboard between first-signup and resend traffic.
        await issueEmailVerification(email, {
            userId: user.id,
            flow: 'resend',
        });
    } catch (err) {
        // Internal failure — still uniform to the caller.
        logger.warn('verification resend issue failed', {
            component: 'auth',
            event: 'verification_resend_failure',
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return uniformOk;
}
