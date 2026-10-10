/**
 * `GET  /api/admin/moderation/notices` — the triage queue.
 * `POST /api/admin/moderation/notices` — act on a notice (P5.4a, #1595).
 *
 * ## Platform-admin key, not a tenant permission
 *
 * Every role in the enum is tenant-scoped, so `admin.manage` would let an
 * ADMIN of any one farm read every other farm's notices. That is the same
 * reasoning the feature-flag console uses, and it is why `ContentReport`,
 * `ModerationAction` and `StatementOfReasons` deny `app_user` outright: there
 * is no tenant session that may reach this data, so there is no weaker copy of
 * the gate for this route to apply.
 *
 * ## `moderatorRef` comes from the KEY, never from the body
 *
 * `verifyPlatformApiKey` now reports which generation authorised the request,
 * and that is what is recorded. The body cannot supply it —
 * `ActOnNoticeSchema.strip()` drops the field, so a caller can neither
 * attribute a decision to someone else nor learn from an error that the field
 * exists.
 *
 * It attributes to a key generation and **not to a person**: there is one
 * `PLATFORM_ADMIN_API_KEY` for every operator. #1599 (P5.8) owns the
 * credential model that would make this a person, and until then the trail is
 * honest about its limit rather than implying one.
 *
 * ## The queue does not say WHO reported anything
 *
 * `listNotices` returns `anonymous: boolean` and never `reporterUserId`. A
 * moderator decides on the CONTENT; knowing who reported it invites deciding
 * on the reporter. It is also why Art 16 notices are answerable without the
 * notifier being identifiable at all.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { parseLimitParam } from '@/lib/validation/query-params';
import { ActOnNoticeSchema } from '@/lib/schemas';
import { listNotices, actOnNotice } from '@/app-layer/usecases/moderation';
import type { PlatformKeyGeneration } from '@/lib/auth/platform-admin';

export const runtime = 'nodejs';

const Query = z.object({
    status: z.enum(['RECEIVED', 'TRIAGED', 'ACTIONED', 'REJECTED']).optional(),
});

/**
 * The gate, in the shape the other `admin/*` routes use — it returns a
 * response to send rather than throwing, so the handler stays linear.
 *
 * It now also yields the key generation, which is the attribution unit.
 */
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

export const GET = withApiErrorHandling(
    async (req: NextRequest) => {
        const gate = platformGate(req);
        if ('refused' in gate) return gate.refused;

        const parsed = Query.safeParse({
            status: req.nextUrl.searchParams.get('status') ?? undefined,
        });
        if (!parsed.success) {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        // The shared parser, not a local zod coercion:
        // `limit-param-nan-safe` requires it on every route reading the param,
        // because `??` does not catch NaN and `take: NaN` reaches Prisma as a
        // 500 on `?limit=abc`.
        const limit = parseLimitParam(req.nextUrl.searchParams.get('limit'), { max: 200 });

        return jsonResponse({ notices: await listNotices({ ...parsed.data, limit }) });
    },
    {
        // Same pre-auth tier as the other platform surfaces: the header IS the
        // credential, so this sits in the same abuse position as sign-in.
        rateLimit: { config: LOGIN_LIMIT, scope: 'platform-moderation-notices' },
    },
);

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
        const parsed = ActOnNoticeSchema.safeParse(raw);
        if (!parsed.success) {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        const result = await actOnNotice({
            ...parsed.data,
            // From the verified key. The body cannot reach this field.
            generation: gate.generation,
        });

        if (!result.actionId) {
            // The notice does not exist. A 404 rather than a 400: the body was
            // well-formed, and a platform admin is entitled to the difference
            // — unlike the public notice route, where distinguishing them
            // would be an enumeration oracle.
            return jsonResponse({ error: 'not_found' }, { status: 404 });
        }

        return jsonResponse(result, { status: 201 });
    },
    {
        rateLimit: { config: LOGIN_LIMIT, scope: 'platform-moderation-act' },
    },
);
