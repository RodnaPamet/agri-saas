/**
 * `POST /api/auth/register/verify` — step 2 of registration v2 (P3.5).
 *
 * Takes the email and the 6-digit code from step 1, and on success marks the
 * user's email verified. It creates no farm: that is P3.6's
 * `POST /api/me/farms`, and a verified user with no farm is a legitimate state
 * the phase introduces deliberately (P3.6 turns `/no-tenant` into a chooser).
 *
 * ── every failure gives the same answer ──
 *
 * `verifyEmailVerificationCode` distinguishes `invalid`, `expired` and
 * `too_many_attempts`, because an operator reading logs needs them apart. This
 * route collapses all three into one `400 {error: 'invalid_code'}`.
 *
 * That is not laziness, it is the same oracle as `start`'s. `expired` can only
 * be returned when a code row EXISTS for that address, so an attacker posting
 * a junk code to a list of addresses would learn which ones recently began
 * signing up — a smaller leak than "has an account", but the same kind, and
 * free to avoid. `too_many_attempts` leaks it identically.
 *
 * Nothing is lost by collapsing them: the user's next action is "request a new
 * code" in all three cases, so one message serves all three honestly. The
 * distinction survives where it is useful — in the log line below, which an
 * attacker cannot read.
 *
 * ── on success, verification is idempotent ──
 *
 * The code is consumed before the user is updated, so a replay cannot reach
 * the update at all. The update is still written as "set if not already set",
 * because an `emailVerified` timestamp that moved on a second call would
 * misreport WHEN the address was proven, and P3.5e's sweep reads exactly that
 * column.
 */
import { NextRequest } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import prisma from '@/lib/prisma';
import { hashForLookupCandidates } from '@/lib/security/encryption';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { logger } from '@/lib/observability/logger';
import {
    verifyEmailVerificationCode,
    normaliseEmail,
    CODE_LENGTH,
} from '@/lib/auth/email-verification-code';

export const runtime = 'nodejs';

/** The one failure answer. See the docblock on why there is only one. */
const SAME_FAILURE = { error: 'invalid_code' } as const;

export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        const { email: rawEmail, code } = (body ?? {}) as Record<string, unknown>;
        if (typeof rawEmail !== 'string' || typeof code !== 'string' || !rawEmail || !code) {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        const email = normaliseEmail(rawEmail);
        const supplied = code.trim();

        // Length is checked before the database is touched. A 6-digit code is
        // the only thing that can ever match, so a 400-character submission is
        // not a wrong guess — it is not a code. Refusing it here keeps junk
        // out of the attempt counter, which otherwise lets an attacker burn a
        // victim's five attempts without ever making a real guess.
        if (supplied.length !== CODE_LENGTH || !/^\d+$/.test(supplied)) {
            return jsonResponse(SAME_FAILURE, { status: 400 });
        }

        const result = await verifyEmailVerificationCode(email, supplied);
        if (!result.ok) {
            // The reason is logged, never returned. This is the line that lets
            // an operator tell a fat-fingered farmer from someone walking the
            // keyspace; see the docblock.
            logger.info('register-verify.refused', {
                component: 'auth',
                event: 'register_verify_refused',
                reason: result.reason,
            });
            return jsonResponse(SAME_FAILURE, { status: 400 });
        }

        // The code was valid, so this address is proven. `updateMany` with the
        // null guard, so a concurrent second verify cannot move the timestamp
        // and the call needs no row to exist — if the user vanished between
        // issue and verify, count is 0 and the response is still the uniform
        // failure rather than a 500.
        const { count } = await prisma.user.updateMany({
            where: {
                emailHash: { in: hashForLookupCandidates(email) },
                emailVerified: null,
            },
            data: { emailVerified: new Date() },
        });

        if (count === 0) {
            // Either already verified (a double-submit, harmless) or the user
            // is gone. Neither is distinguishable to the caller, and neither
            // should be: answering 200 for "already verified" is correct and
            // answering it for "no such user" would re-open the oracle.
            const stillThere = await prisma.user.findFirst({
                where: { emailHash: { in: hashForLookupCandidates(email) } },
                select: { id: true },
            });
            if (!stillThere) {
                logger.warn('register-verify.user_missing_after_valid_code', {
                    component: 'auth',
                    event: 'register_verify_user_missing',
                });
                return jsonResponse(SAME_FAILURE, { status: 400 });
            }
        }

        logger.info('register-verify.verified', {
            component: 'auth',
            event: 'register_verify_verified',
            firstTime: count === 1,
        });
        return jsonResponse({ ok: true, verified: true });
    },
    {
        // Login tier, not signup tier. This endpoint accepts GUESSES at a 10^6
        // credential, which is the same abuse shape as a password attempt and
        // a stricter one than creating an account. The per-code attempt cap in
        // `email-verification-code.ts` bounds one code; this bounds the rate
        // at which an attacker can cycle through fresh ones.
        rateLimit: { config: LOGIN_LIMIT, scope: 'register-verify' },
    },
);
