import { NextRequest } from 'next/server';

import { z } from 'zod';

import { listNotices, actOnNotice } from '@/app-layer/usecases/moderation';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { withApiErrorHandling } from '@/lib/errors/api';
import { ActOnNoticeSchema } from '@/lib/schemas';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseLimitParam } from '@/lib/validation/query-params';

/**
 * The Art 16 triage queue and the Art 17 decision, for a PERSON — #2735.
 *
 * ## What this fixes, and it is a compliance claim rather than convenience
 *
 * P5.4a shipped the whole mechanism behind `verifyPlatformApiKey`, and
 * `moderatorRefFor` could therefore record no more than which KEY GENERATION
 * authorised a decision. The repo states the consequence plainly: there is one
 * `PLATFORM_ADMIN_API_KEY` for every operator, so *"a regulator asking 'who
 * decided this' gets 'somebody holding the key'"*. `PlatformAuditLog` wrote
 * `actorUserId: null` for the same reason.
 *
 * #2735 was filed because the pointer to the fix named P5.8, which closed
 * without it. This is the fix: a session-gated door whose caller IS a person,
 * so `ModerationActor` carries `{ kind: 'user', userId }` and both
 * `moderatorRef` and `actorUserId` name them.
 *
 * ## Why NOT per-person API keys, which was the first answer
 *
 * Owner ruling 2026-11-12, after the trade-off was measured rather than
 * argued. Per-person keys need a credential lookup, so `verifyPlatformApiKey`
 * would have to become async — and it asserts by THROWING, synchronously, at
 * 20 bare call sites. An un-awaited async assertion returns a Promise nobody
 * reads, the throw never reaches the handler, and the gate **fails OPEN**:
 *
 *     tsc --strict on an un-awaited async assertion  ->  exit 0
 *     runtime, bare    (refusing input)              ->  PROCEEDED
 *     runtime, awaited (refusing input)              ->  REFUSED
 *
 * `eslint.config.mjs` configures no type-aware rules — no
 * `no-floating-promises`, no `projectService` — so nothing lints it either.
 * Twenty gates would stop gating with `tsc` and `lint` both green. The session
 * door creates no such hazard, so **`verifyPlatformApiKey` stays
 * SYNCHRONOUS** and the keyed routes are untouched.
 *
 * ## The two gates, and why `admin.manage` alone is not one
 *
 * `requirePermission('admin.manage')` is necessary and NOT sufficient:
 * permissions resolve from Role, so every tenant's admin holds it — and
 * `ContentReport` / `ModerationAction` / `StatementOfReasons` are TENANTLESS,
 * denying `app_user` outright. Without the second gate an ADMIN of any one
 * farm could triage every other farm's notices, which is the flag console's
 * problem with a worse subject.
 *
 * `assertPlatformSupport(ctx)` restricts this to the designated platform
 * tenant and 404s everywhere else, so an unrelated tenant's owner is not even
 * told the console exists.
 *
 * ## It is NOT under `/api/admin/moderation/`, and that is load-bearing
 *
 * That prefix is in `PUBLIC_PATH_PREFIXES` so the Edge admits an
 * `x-platform-admin-key` request — `getToken()` understands only a NextAuth
 * cookie, so without the entry the keyed routes would 401 before their handler
 * ran. A session sibling placed under the same prefix would inherit that
 * exemption and so be exempt from the very Edge check it depends on. Living
 * under `/api/t/{tenantSlug}/` means the cookie is read by the Edge exactly as
 * for every other tenant route. The farm-claims siblings (#2963) are placed
 * this way for the same reason.
 *
 * The path carries a tenant slug while the DATA is tenantless — the same shape
 * P8.4 chose for direct messages on an explicit owner ruling. The slug selects
 * the door, not the rows; `assertPlatformSupport` is what makes only one slug
 * work.
 *
 * ## The usecases are REUSED, never forked
 *
 * `actOnNotice` is deliberately ONE transaction (P5.4a) and takes the caller's
 * `tx` through to `suspendAccountOnTx`, because a second pool connection
 * inside an open one is #1191's P0.8 deadlock. A second door that reimplemented
 * the act would be a second spelling of the same policy — the #1664 class,
 * where two spellings made a divergence a disclosure rather than a wrong
 * sentence. The ONLY difference between the doors is the `ModerationActor`.
 *
 * ## The queue still does not say WHO reported anything
 *
 * `listNotices` returns `anonymous: boolean` and never `reporterUserId`, and
 * that is unchanged by having a person at the other end. A moderator decides on
 * the CONTENT; knowing who reported it invites deciding on the reporter, and it
 * is why an Art 16 notice is answerable without the notifier being
 * identifiable at all.
 */

const Query = z.object({
    status: z.enum(['RECEIVED', 'TRIAGED', 'ACTIONED', 'REJECTED']).optional(),
});

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req: NextRequest, _routeArgs, ctx) => {
            assertPlatformSupport(ctx);

            const url = new URL(req.url);
            const parsed = Query.safeParse({
                status: url.searchParams.get('status') ?? undefined,
            });
            if (!parsed.success) {
                return jsonResponse({ error: 'invalid_request' }, { status: 400 });
            }

            // The shared parser, not a local zod coercion: `??` does not catch
            // NaN and `take: NaN` reaches Prisma as a 500 on `?limit=abc`.
            const limit = parseLimitParam(url.searchParams.get('limit'), { max: 200 });

            return jsonResponse({ notices: await listNotices({ ...parsed.data, limit }) });
        },
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req: NextRequest, _routeArgs, ctx) => {
            assertPlatformSupport(ctx);

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
                // THE WHOLE POINT OF THIS ROUTE. `ctx.userId` comes from the
                // verified session; `ActOnNoticeSchema` has no field a caller
                // could use to attribute a decision to somebody else, and
                // `.strip()` drops one silently rather than erroring, so a
                // caller cannot learn from the response that it exists.
                actor: { kind: 'user', userId: ctx.userId },
            });

            if (!result.actionId) {
                // The notice does not exist. A 404 rather than a 400: the body
                // was well-formed, and a platform moderator is entitled to the
                // difference — unlike the public notice route, where
                // distinguishing them would be an enumeration oracle.
                return jsonResponse({ error: 'not_found' }, { status: 404 });
            }

            return jsonResponse(result, { status: 201 });
        },
    ),
);
