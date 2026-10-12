/**
 * `POST   /api/account/deletion` — ask for your account to be deleted.
 * `DELETE /api/account/deletion` — change your mind (P5.6b, #1597).
 *
 * ## Frozen but recoverable, owner ruling 2026-10-11
 *
 * `POST` revokes every live session and stamps `deletionRequestedAt`. A person
 * who asked to be deleted stops appearing to other farms immediately rather
 * than keeping on showing up in live negotiations for a month; the 30 days
 * protects THEM — from an impulse, or from a compromised account — rather than
 * protecting us.
 *
 * Revoking the sessions is also what makes recovery coherent: the person has to
 * sign in again, and signing in is where the cancellation is offered. That is
 * the reading of "recovery by signing in" this implements — signing in does not
 * silently cancel, because a background session refresh would then undo a
 * deliberate request. `DELETE` is the explicit act.
 *
 * ## In-app deletion is required, not optional
 *
 * Apple rejects a build where deletion exists on the web and not in the app
 * (#1598), which is why the iOS half lands in the same release — and because
 * the grace period is recoverable, the app needs a recovery screen too, not
 * only a delete button. This route is what both clients call.
 *
 * ## `getUserCtx`, like its `/api/account/**` siblings
 *
 * It refuses an `iflk_` API key presented as a person credential, an
 * MFA-pending session, and the operator-only persona on a social surface.
 * Deleting an account is the most consequential self-service action there is,
 * so "is this really that person, fully authenticated" is the whole question —
 * and an API key must never be able to delete the human it acts for.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { codedNotFound } from '@/lib/errors/types';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import {
    requestAccountDeletion,
    cancelAccountDeletion,
    DELETION_GRACE_DAYS,
} from '@/app-layer/usecases/account-erasure';

export const runtime = 'nodejs';

export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        const ctx = await getUserCtx(req);

        const result = await requestAccountDeletion(ctx.userId);

        if (!result.applied) {
            // Already pseudonymised, or gone. There is nothing left to request
            // and saying so is better than pretending it worked.
            throw codedNotFound('ACCOUNT_ALREADY_ERASED', 'ACCOUNT_ALREADY_ERASED');
        }

        return jsonResponse({
            requested: true,
            alreadyRequested: result.alreadyRequested,
            // Returned so the client can say the date rather than recompute it
            // — two places deriving one deadline is two places to get it wrong.
            erasesAt: result.erasesAt,
            graceDays: DELETION_GRACE_DAYS,
            sessionsRevoked: result.sessionsRevoked,
        });
    },
    {
        // The LOGIN tier: this is a credential-adjacent, never-legitimate-in-bulk
        // action, and the same tier the other irreversible account operations
        // use.
        rateLimit: { config: LOGIN_LIMIT, scope: 'account-deletion-request' },
    },
);

export const DELETE = withApiErrorHandling(
    async (req: NextRequest) => {
        // `allowSuspended` — the ONE place it is passed, and the reason is that
        // a way out must never be gated on the condition it escapes.
        //
        // The case it exists for is a person who REQUESTED deletion and was
        // later suspended: until #1667 this route answered `ACCOUNT_SUSPENDED`
        // and they could not change their mind.
        //
        // It does NOT admit a terminated account. `cancelAccountDeletion`
        // refuses a MODERATION-initiated erasure with `ACCOUNT_TERMINATED`
        // (#1671) — and that refusal lives in the usecase on purpose, because
        // the previous protection was this route refusing suspended accounts,
        // which is a side effect of a different control. #1667 removed it with
        // every required check green; nothing asserted the protection
        // directly, so nothing noticed.
        //
        // The same shape as P5.5a's slow-mode escape, where an unverified
        // account throttled on the route that verifies it cannot get out.
        //
        // Narrow by construction, not by promise: a valid session is still
        // required, and `cancelAccountDeletion` clears one column on the
        // CALLER's own row. Cancelling does NOT lift the suspension — they
        // stop the erasure and remain locked out, which is the honest outcome
        // and is why POST below keeps the refusal.
        const ctx = await getUserCtx(req, { allowSuspended: true });

        const result = await cancelAccountDeletion(ctx.userId);

        if (!result.applied) {
            // Past the point of no return.
            throw codedNotFound('ACCOUNT_ALREADY_ERASED', 'ACCOUNT_ALREADY_ERASED');
        }

        return jsonResponse({ requested: false, wasRequested: result.wasRequested });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'account-deletion-cancel' } },
);
