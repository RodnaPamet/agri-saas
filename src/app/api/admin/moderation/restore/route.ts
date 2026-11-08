/**
 * `POST /api/admin/moderation/restore` — reverse a content removal (#2867).
 *
 * ## Why this is its own route and not a kind on `/notices`
 *
 * A restore is not a decision ON a notice, it is the reversal of one. Putting
 * it on `POST /notices` would mean `CONTENT_RESTORED` joining
 * `MODERATION_ACTION_KINDS`, and then a caller could record a restore against
 * a notice that asked for a removal — an action attributed to a case it is not
 * about, which is the thing P5.4a refuses by denormalising the subject from
 * the notice rather than accepting it from the body.
 *
 * It also takes a different key. A notice decision is addressed by `reportId`;
 * a restore is addressed by the `actionId` of the removal it reverses, because
 * `removedByModerationAt` carries no record of WHICH decision set it, so a
 * restore addressed by subject could un-hide a listing no appeal concerned.
 *
 * ## Platform-admin key, same as its neighbours
 *
 * `ModerationAction` denies `app_user` for every command, so there is no
 * tenant session that could reach this. `/api/admin/moderation/` is already in
 * `PUBLIC_PATH_PREFIXES` (P5.4a) — the Edge calls `getToken()`, which
 * understands only a NextAuth cookie, so an `x-platform-admin-key` request is
 * 401'd before the handler runs unless the prefix is open. No Edge change was
 * needed here, and that is worth stating: the seventh instance of that class
 * in this repo was a route added under an unopened prefix.
 *
 * ## The response says whether anything CHANGED
 *
 * `restored: false` with a null action id means the content was already
 * visible — an appeal upheld twice. The call succeeds, because a moderator
 * closing a second appeal has done nothing wrong, and it writes no second
 * action and queues no second statement: one removal keyed on one action is
 * one appeal, unlike two notices about one listing, which are two decisions
 * and both get their row (#2865).
 */
import { NextResponse, type NextRequest } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import type { PlatformKeyGeneration } from '@/lib/auth/platform-admin';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { RestoreContentSchema } from '@/lib/schemas';
import { restoreRemovedContent } from '@/app-layer/usecases/moderation';

export const runtime = 'nodejs';

/** The gate, in the shape the other `admin/*` routes use. */
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
        const parsed = RestoreContentSchema.safeParse(raw);
        if (!parsed.success) {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        const result = await restoreRemovedContent({
            actionId: parsed.data.actionId,
            rationale: parsed.data.rationale,
            generation: gate.generation,
        });
        return jsonResponse(result, { status: 200 });
    },
    {
        // Same pre-auth tier as its neighbours: the header IS the credential,
        // so this sits in the same abuse position as sign-in.
        rateLimit: { config: LOGIN_LIMIT, scope: 'platform-moderation-restore' },
    },
);
