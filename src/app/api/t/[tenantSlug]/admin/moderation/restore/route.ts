import { NextRequest } from 'next/server';

import { restoreRemovedContent } from '@/app-layer/usecases/moderation';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest, codedNotFound } from '@/lib/errors/types';
import { RestoreContentSchema } from '@/lib/schemas';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * Reverse a content removal, for a PERSON — #2735, PR 3.
 *
 * ## It is a DECISION, not an undo
 *
 * `restoreRemovedContent` writes a SECOND `ModerationAction`
 * (`CONTENT_RESTORED`) rather than editing the first, and leaves
 * `ContentReport.status` at ACTIONED: the notice WAS acted on and the action
 * was later reversed, which is what the second row records. Moving the notice
 * back to RECEIVED would put a decided notice into the triage queue and ask a
 * moderator to decide it again.
 *
 * So this route needs the same attribution as the decision it reverses — and
 * until #2735 the keyed route could only say `platform-key:<generation>`, which
 * means an appeal upheld by a named person was recorded as having been upheld
 * by whoever held the key.
 *
 * ## Why the session door, and why the keyed one stays
 *
 * `requirePermission('admin.manage')` is necessary and NOT sufficient:
 * permissions resolve from Role, so every tenant's admin holds it, and
 * `ModerationAction` is TENANTLESS. `assertPlatformSupport(ctx)` restricts this
 * to the designated platform tenant and 404s everywhere else.
 *
 * NOT under `/api/admin/moderation/`, deliberately: that prefix is in
 * `PUBLIC_PATH_PREFIXES` so the Edge admits an `x-platform-admin-key` request,
 * and a session sibling placed there would inherit an exemption from the very
 * Edge check it depends on.
 *
 * ## `restored: false` is a SUCCESS
 *
 * The usecase is idempotent: restoring something already visible reports
 * `restored: false` with a real `restoreActionId`. A console that treated that
 * as an error would make a double-click read as a failure. What IS an error is
 * a `restoreActionId` of null — no such action — which is a 404 here.
 */
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
            const parsed = RestoreContentSchema.safeParse(raw);
            if (!parsed.success) {
                throw codedBadRequest(
                    'INVALID_BODY',
                    'The restore is missing a required field.',
                );
            }

            const result = await restoreRemovedContent({
                actionId: parsed.data.actionId,
                rationale: parsed.data.rationale,
                // THE POINT OF THIS ROUTE. From the verified session, so an
                // appeal upheld by a person is recorded as theirs — in the
                // action row and in `PlatformAuditLog.actorUserId` alike.
                actor: { kind: 'user', userId: ctx.userId },
            });

            if (!result.restoreActionId) {
                // A 404, not a 400: the body was well-formed and the id simply
                // names nothing. `restoreRemovedContent` reports that as a NULL
                // `restoreActionId` rather than throwing, so a route returning
                // its result unexamined would answer 200 over a restore that
                // never happened.
                throw codedNotFound(
                    'MODERATION_ACTION_NOT_FOUND',
                    'That moderation action no longer exists.',
                );
            }

            return jsonResponse(result, { status: 200 });
        },
    ),
);
