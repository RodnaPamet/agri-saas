import { NextRequest } from 'next/server';

import { z } from 'zod';

import { suspendAccount, liftSuspension } from '@/app-layer/usecases/account-suspension';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest, codedNotFound } from '@/lib/errors/types';
import { MODERATION_RATIONALE_MAX } from '@/lib/schemas';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * Suspend an account, and lift a suspension, for a PERSON — #2735, PR 3.
 *
 * ## The account is PASTED, and that is an owner ruling rather than laziness
 *
 * Owner ruling 2026-11-12: the console takes a `userId` the moderator supplies,
 * and there is deliberately NO people lookup. Three things make that the right
 * answer rather than a gap:
 *
 *   1. it adds no new read surface, so the disclosure boundary does not move. A
 *      platform-wide search by name or email would be the first surface in this
 *      product where one person can enumerate every account, and that is its
 *      own decision with its own review — not something a console PR should
 *      introduce as a convenience.
 *   2. the common case already has the id. A moderator suspending the author of
 *      reported content reads it off the notice they are acting on; the triage
 *      queue returns `subjectId`.
 *   3. deriving "the responsible account" from a notice is precisely the
 *      judgement P5.1 left to a human — a notice names CONTENT, and a reported
 *      listing belongs to a farm whose members are several. A console that
 *      resolved it automatically would be re-deciding that.
 *
 * ## Suspending and lifting are NOT symmetric, and the schemas say so
 *
 * A suspension REQUIRES a reason: it is the `rationale` of the
 * `ModerationAction` this path records, encrypted at rest, and the text an Art
 * 17 statement is composed from. A decision that withholds a farm from a person
 * is not recordable without one (#1667).
 *
 * Lifting requires none, and that is the signature rather than an omission:
 * restoring the ability to sign in is not a decision the Art 17 machinery
 * composes a statement from. `liftSuspension` takes no `reason` field at all.
 *
 * ## What lifting does NOT do
 *
 * It does not decrement `sessionVersion`, un-revoke sessions, or cancel an
 * erasure the person asked for themselves. Reinstatement restores the ability
 * to sign in, not credentials that may since have been shared — and a
 * self-requested deletion is the person's own decision, which a moderator
 * lifting a suspension must not quietly reverse.
 *
 * ## Both gates, for the usual reason
 *
 * `admin.manage` is the audited role floor and is NOT the isolation practice:
 * `User.suspendedAt` is not tenant-scoped, so without `assertPlatformSupport`
 * an ADMIN of any one farm could suspend anybody on the platform.
 */

const SuspendBody = z.object({
    userId: z.string().min(1).max(200),
    reason: z.string().min(1).max(MODERATION_RATIONALE_MAX),
}).strip();

const LiftBody = z.object({
    userId: z.string().min(1).max(200),
}).strip();

/** Shared by both methods: parse, or refuse with a code the console can read. */
async function body<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T> {
    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        throw codedBadRequest('INVALID_JSON', 'The request body is not valid JSON.');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        throw codedBadRequest('INVALID_BODY', 'The request is missing a required field.');
    }
    return parsed.data;
}

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req: NextRequest, _routeArgs, ctx) => {
            assertPlatformSupport(ctx);
            const input = await body(req, SuspendBody);

            const result = await suspendAccount({
                userId: input.userId,
                reason: input.reason,
                // From the verified session. The keyed sibling can say no more
                // than which key generation authorised it (#2735).
                actor: { kind: 'user', userId: ctx.userId },
            });

            // `applied: false` means NO SUCH USER, and nothing else. Measured
            // in the usecase: the idempotent repeat returns `applied: true`
            // WITH `alreadySuspended: true`, because re-suspending must not
            // re-stamp `suspendedAt` — the date an appeal and a regulator both
            // work from.
            //
            // So a second clause on `alreadySuspended` would be VACUOUS: it can
            // never be the thing that decides this branch. My first draft had
            // one, which reads as a control and is none.
            //
            // A 404, matching the keyed sibling exactly. Two doors answering
            // different statuses for one outcome is how a client comes to
            // believe two things about one account.
            if (!result.applied) {
                throw codedNotFound('ACCOUNT_NOT_FOUND', 'That account was not found.');
            }

            return jsonResponse(result, { status: 200 });
        },
    ),
);

export const DELETE = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req: NextRequest, _routeArgs, ctx) => {
            assertPlatformSupport(ctx);
            // A BODY rather than a path or query parameter, matching the keyed
            // sibling and P5.2b's rule: iOS logs the full URL unsuppressably,
            // and a third party's user id in a device log is a disclosure.
            const input = await body(req, LiftBody);

            const result = await liftSuspension({
                userId: input.userId,
                actor: { kind: 'user', userId: ctx.userId },
            });

            // The same check as POST, and it was missing from my first draft:
            // lifting a suspension on an account that does not exist reported
            // `applied: false` and this route answered 200 over a reinstatement
            // of nobody. `wasSuspended: false` is a different thing and stays a
            // success — lifting a suspension that was not there is idempotent.
            if (!result.applied) {
                throw codedNotFound('ACCOUNT_NOT_FOUND', 'That account was not found.');
            }

            return jsonResponse(result, { status: 200 });
        },
    ),
);
