/**
 * `POST   /api/admin/moderation/suspensions` — suspend an account.
 * `DELETE /api/admin/moderation/suspensions` — lift a suspension (P5.9, #1600).
 *
 * ## Why this exists alongside `actOnNotice`
 *
 * `POST /notices` already suspends when a moderator records
 * `ACCOUNT_SUSPENDED` — and must, because recording that outcome without
 * performing it is #1635. But two things it cannot do:
 *
 *   - **lift one.** An appeal upheld has no notice to act on, and the whole
 *     point of the DSA redress route is that a decision can be reversed. A
 *     suspension with no lift path is a permanent ban wearing a temporary
 *     name.
 *   - **suspend without a notice.** An account found abusive by other means —
 *     a pattern across many subjects, an operator's own observation — has no
 *     single `ContentReport` to hang the action on.
 *
 * ## Why it cannot reuse the tenant revocation route
 *
 * `revokeUserSessions` requires `ctx.tenantId` and a `TenantMembership` for the
 * target, and a platform moderator has neither — #1600 DECISION 2. The
 * suspended person may hold several farms or none, and a tenantless account is
 * exactly what an abuse suspension most often hits.
 *
 * ## DELETE takes a BODY, not a path parameter
 *
 * The same reason P5.2b's unblock route does: iOS logs the full URL including
 * the query string, unsuppressably, so a third party's user id in a device log
 * is the disclosure this phase exists to prevent.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import type { PlatformKeyGeneration } from '@/lib/auth/platform-admin';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { suspendAccount, liftSuspension } from '@/app-layer/usecases/account-suspension';
import { MODERATION_RATIONALE_MAX } from '@/lib/schemas';

export const runtime = 'nodejs';

const SuspendBody = z.object({
    userId: z.string().min(1).max(200),
    /**
     * REQUIRED since #1667 — it is the `rationale` of the `ModerationAction`
     * this route now records, which is encrypted at rest and is what an Art 17
     * statement is composed from.
     *
     * It was optional, and the text was DISCARDED: only
     * `hasReason: Boolean(...)` reached `PlatformAuditLog`, under a comment
     * correctly saying the rationale "belongs on
     * `ModerationAction.rationale`" — a row this path never created. A
     * decision that withholds a farm from a person is not recordable without
     * one.
     *
     * A contract narrowing on a platform-admin route, and deliberate: owner
     * ruling on #1667 is that a suspension carries a statement, and the
     * moderator writes the reason.
     */
    reason: z.string().min(1).max(MODERATION_RATIONALE_MAX),
}).strip();

const LiftBody = z.object({
    userId: z.string().min(1).max(200),
}).strip();

function platformGate(
    req: NextRequest,
): { refused: NextResponse } | { generation: PlatformKeyGeneration } {
    try {
        const { generation } = verifyPlatformApiKey(req);
        return { generation };
    } catch (err) {
        if (err instanceof PlatformAdminError) {
            return { refused: NextResponse.json({ error: err.message }, { status: err.status }) };
        }
        throw err;
    }
}

export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        const gate = platformGate(req);
        if ('refused' in gate) return gate.refused;

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }
        const parsed = SuspendBody.safeParse(raw);
        if (!parsed.success) {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        const result = await suspendAccount({
            userId: parsed.data.userId,
            generation: gate.generation,
            reason: parsed.data.reason,
        });

        if (!result.applied) {
            // No such account. A platform admin is entitled to the difference
            // — unlike a public surface, where it would be an enumeration
            // oracle.
            return jsonResponse({ error: 'not_found' }, { status: 404 });
        }

        // 200 rather than 201: nothing was created, and an idempotent repeat
        // is the same answer rather than a conflict.
        return jsonResponse({
            suspended: true,
            alreadySuspended: result.alreadySuspended,
            sessionsRevoked: result.sessionsRevoked,
        });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-moderation-suspend' } },
);

export const DELETE = withApiErrorHandling(
    async (req: NextRequest) => {
        const gate = platformGate(req);
        if ('refused' in gate) return gate.refused;

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }
        const parsed = LiftBody.safeParse(raw);
        if (!parsed.success) {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        const result = await liftSuspension({
            userId: parsed.data.userId,
            generation: gate.generation,
        });

        if (!result.applied) {
            return jsonResponse({ error: 'not_found' }, { status: 404 });
        }

        return jsonResponse({ suspended: false, wasSuspended: result.wasSuspended });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-moderation-lift' } },
);
