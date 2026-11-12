import { NextRequest } from 'next/server';

import { listUndeliveredStatements, queueStatement } from '@/app-layer/usecases/moderation';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { QueueStatementSchema } from '@/lib/schemas';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseLimitParam } from '@/lib/validation/query-params';

/**
 * The undelivered-statement queue, and queueing one by hand — #2735, PR 4.
 *
 * ## The GET is the compliance-visible half
 *
 * P5.4a's own note says why: a statement that never went out *"is a compliance
 * failure, and the thing that makes it dangerous is that nothing else would
 * show it: the action is recorded, the notice reads ACTIONED, and the recipient
 * simply never heard."* So the queue is SURFACED rather than inferred — and a
 * moderator who has just decided a notice is exactly the person who should see
 * whether its statement left.
 *
 * `StatementOfReasons` IS the outbox: `NotificationOutbox` is tenant-scoped
 * with a non-nullable `tenantId`, and an Art 17 statement goes to a PERSON who
 * may have no farm or several, so resolving one would invent a tenant for a
 * person-scoped obligation. P5.1 shaped `deliveredAt` as NULL-until-sent, so
 * `deliveredAt IS NULL` is the queue and this read is its drain view.
 * `statement-dispatch` drains it every 10 minutes.
 *
 * ## What this view does NOT answer, and must not claim to
 *
 * `listUndeliveredStatements` answers *"which statements exist and have not
 * been sent"* — deliberately NOT *"which decisions produced no statement"*.
 * Nothing answers the second; it is #2996. A section labelled anything like
 * "unexplained decisions" would be claiming the second while showing the
 * first, which is worse than not having it at all, because it would read as
 * coverage.
 *
 * ## `locale` is a PLACEHOLDER on the POST, not a language choice
 *
 * `statement-dispatch` resolves the recipient's own locale at SEND time and
 * writes it back before stamping `deliveredAt`, because Art 17 requires the
 * recipient's language and a console default is not that. The fallback is `bg`
 * rather than `DEFAULT_LOCALE` — which is `en`, documented for
 * UNAUTHENTICATED surfaces — because a statement recipient is a known user
 * whose `uiLanguage` column defaults to `bg`.
 *
 * ## The attribution already works; only the door was missing
 *
 * #2997 made `queueStatement` take a `ModerationActor`, so
 * `MODERATION_STATEMENT_QUEUED` names its author instead of recording
 * `actorUserId: null`. This route supplies the `{ kind: 'user' }` arm.
 */

/**
 * Mirrors the keyed route's placeholder exactly. Spelled here rather than
 * imported from it because a route importing another route's local constant is
 * worse than two spellings of a three-letter string — and the SHARED half, the
 * reason it is a placeholder at all, lives in `statement-dispatch`.
 */
const FALLBACK_LOCALE = 'bg';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req: NextRequest, _routeArgs, ctx) => {
            assertPlatformSupport(ctx);
            const url = new URL(req.url);
            // The shared parser: `??` does not catch NaN and `take: NaN`
            // reaches Prisma as a 500 on `?limit=abc`.
            const limit = parseLimitParam(url.searchParams.get('limit'), { max: 200 });
            return jsonResponse({ statements: await listUndeliveredStatements(limit) });
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
                throw codedBadRequest('INVALID_JSON', 'The request body is not valid JSON.');
            }
            const parsed = QueueStatementSchema.safeParse(raw);
            if (!parsed.success) {
                throw codedBadRequest('INVALID_BODY', 'The statement is missing a required field.');
            }

            const result = await queueStatement({
                actionId: parsed.data.actionId,
                // SUPPLIED, like the keyed sibling. An action's subject is
                // CONTENT, not a person — a removed listing names a farm — so
                // who is entitled to the statement is a judgement the moderator
                // makes, and there is no field on `ModerationAction` this could
                // be derived from without guessing.
                recipientUserId: parsed.data.recipientUserId,
                // From the verified session (#2997 made this parameter exist).
                actor: { kind: 'user', userId: ctx.userId },
                locale: parsed.data.locale ?? FALLBACK_LOCALE,
                bodyRendered: parsed.data.bodyRendered,
            });

            return jsonResponse(result, { status: 201 });
        },
    ),
);
