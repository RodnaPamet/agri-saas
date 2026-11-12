/**
 * «Сигнали» — the session-authenticated Art 16 triage queue and Art 17
 * decision (#2735).
 *
 * Documented rather than baselined, because `openapi-paths-complete`'s
 * baseline only SHRINKS and because the thing a reader most needs here is
 * invisible from the shapes: there are TWO doors onto this queue, and which one
 * a request came through decides WHO the decision is attributed to — which is
 * the whole subject of #2735 and a compliance property rather than a detail.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '@/lib/openapi/zod';

import { codedErrorResponses, op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' } }),
});

const QueuedNotice = z
    .object({
        id: z.string(),
        createdAt: z.string().datetime({ offset: true }),
        subjectKind: z.string().openapi({
            description:
                'LISTING, MESSAGE, PROFILE or THREAD from the anonymous Art 16 route; '
                + 'DIRECT_MESSAGE and CHANNEL_POST additionally from the signed-in one. '
                + 'ACCOUNT is NOT reportable — it is the subject of an ACTION only.',
        }),
        subjectId: z.string(),
        reasonCode: z.string(),
        status: z.enum(['RECEIVED', 'TRIAGED', 'ACTIONED', 'REJECTED']),
        anonymous: z.boolean().openapi({
            description:
                'Whether the notifier gave an id — never WHICH. A moderator decides on the '
                + 'CONTENT, and knowing who reported it invites deciding on the reporter. It '
                + 'is returned because it changes whether there is anybody to answer to under '
                + 'Art 17.',
        }),
        detail: z.string().nullable(),
        snapshot: z
            .object({
                capturedAt: z.string().datetime({ offset: true }),
                captureError: z.string().nullable(),
            })
            .nullable()
            .openapi({
                description:
                    'The evidence capture. NULL and a non-null `captureError` mean different '
                    + 'things — nothing was attempted, versus an attempt that failed — and a '
                    + 'console that rendered both as "no evidence" would hide a broken capture.',
            }),
        subjectNoticeCount: z.number().int().openapi({
            description:
                'How many notices name this subject, this one included. DISPLAY ONLY: nothing '
                + 'may order the queue by it. `notice-score-is-shadow-only` covers this field '
                + 'for the reason it covers the AI score — "order the triage queue by report '
                + 'count" looks like an improvement and is a number a brigade can drive.',
        }),
    })
    .openapi('QueuedModerationNotice');

const TWO_DOORS =
    '\n\n**Two doors, and the door decides the ATTRIBUTION.** '
    + '`/api/admin/moderation/notices` is gated by the one shared '
    + '`PLATFORM_ADMIN_API_KEY` and sits in `PUBLIC_PATH_PREFIXES`, because the Edge calls '
    + '`getToken()` and understands only a session cookie. A decision made through it can be '
    + 'attributed no further than `platform-key:<generation>` — so a regulator asking "who '
    + 'decided this" gets "somebody holding the key", and `PlatformAuditLog.actorUserId` is '
    + 'NULL. THIS route is session-gated — `admin.manage` AND the platform-support tenant, so '
    + 'it 404s everywhere else — and records `user:<userId>` from the verified session in '
    + 'both `moderatorRef` and `actorUserId`. The keyed route stays for scripts, and for an '
    + 'incident in which the session path is the broken thing.';

const NO_REPORTER =
    '\n\n**No endpoint here returns a reporter id.** Not withheld for tidiness: DSA Art 16 '
    + 'notices are answerable without the notifier being identifiable at all, and a queue that '
    + 'named them would invite a decision about the reporter rather than about the content.';

export function registerModerationConsolePaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/admin/moderation/notices',
        operationId: 'listModerationNoticesForReview',
        summary: 'The Art 16 triage queue',
        description:
            'Oldest first, so a backlog drains instead of starving — and because P5\'s exit '
            + 'criterion measures handling time from `createdAt`.\n\nAn unrecognised `status` '
            + 'is a 400 rather than being ignored: answering with the default queue under a '
            + 'filter the caller asked for and did not get would make a moderator looking for '
            + 'ACTIONED notices read a list of RECEIVED ones as "there are none".'
            + TWO_DOORS + NO_REPORTER,
        tags: ['Admin'],
        params: TenantParams,
        query: z.object({
            status: z.string().optional().openapi({
                description:
                    'RECEIVED, TRIAGED, ACTIONED or REJECTED. Absent means every status.',
            }),
            limit: z.string().optional().openapi({
                description: 'Positive integer, clamped to 200.',
            }),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_STATUS_FILTER — an unrecognised `status`.',
            404: 'Not the platform-support tenant — `assertPlatformSupport` 404s rather than '
                + 'forbidding, so another tenant is not told this console exists.',
        }),
        success: {
            status: 200,
            description: 'One page of the queue.',
            schema: z.object({ notices: z.array(QueuedNotice) }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/moderation/notices',
        operationId: 'actOnModerationNoticeFromConsole',
        summary: 'Record the Art 17 decision on a notice',
        description:
            'One transaction: the notice\'s status and the `ModerationAction` row move '
            + 'together, because a notice marked ACTIONED with no action row — or an action '
            + 'beside a notice still RECEIVED — are states a queue cannot tell from a crash. '
            + 'The statement of reasons is queued AFTER the commit, so a rolled-back decision '
            + 'cannot leave one announced.'
            + '\n\n**The moderator is NOT a field.** The keyed sibling reads `moderatorRef` '
            + 'from the verified KEY; this route reads it from the verified SESSION. Neither '
            + 'accepts it from the body — `ActOnNoticeSchema.strip()` drops a supplied value '
            + 'silently rather than erroring, so a caller can neither attribute a decision to '
            + 'somebody else nor learn from the response that the field exists.'
            + '\n\n**`actionKind: NONE` is a DECISION**, not a no-op: it moves the notice to '
            + 'REJECTED, because "looked and did nothing" must be distinguishable from "never '
            + 'looked" and an absent row cannot express the first.'
            + '\n\n**`suspendUserId` is REQUIRED for an outcome that withholds access**, and '
            + 'supplied rather than derived: a notice names CONTENT, and a reported listing '
            + 'belongs to a farm whose members are several, so which account to lock out is a '
            + 'judgement. That requirement is what makes the outcome impossible to record '
            + 'without being performed — for a month the console accepted it, the statement '
            + 'told the recipient they could not post, and nothing withheld anything.'
            + TWO_DOORS,
        tags: ['Admin'],
        params: TenantParams,
        body: z.object({
            reportId: z.string().min(1).max(200),
            actionKind: z
                .enum(['NONE', 'CONTENT_REMOVED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_TERMINATED'])
                .openapi({
                    description:
                        'A kind the platform cannot carry out for this subject is refused with '
                        + '`MODERATION_ACTION_NOT_PERFORMABLE` BEFORE anything is written — a '
                        + 'direct message is reportable and not removable (owner ruling), and '
                        + 'recording an outcome we cannot perform would deliver a statement of '
                        + 'reasons asserting something untrue.',
                }),
            rationale: z.string().min(1).openapi({
                description:
                    'REQUIRED, unlike a notice\'s own `detail`. A notice may be filed without '
                    + 'prose because Art 16 does not let us refuse one for want of it; a '
                    + 'DECISION without a reason is what Art 17 exists to prevent, and this is '
                    + 'the text the statement is built from.',
            }),
            suspendUserId: z.string().optional().openapi({
                description:
                    'Required when `actionKind` withholds access. Refused with '
                    + '`SUSPEND_TARGET_REQUIRED` when absent.',
            }),
        }),
        extraResponses: codedErrorResponses({
            400: 'SUSPEND_TARGET_REQUIRED, MODERATION_ACTION_NOT_PERFORMABLE, INVALID_JSON '
                + '(unparseable body) or INVALID_BODY (a required field missing). The last two '
                + 'are separate codes because a malformed body and a well-formed one missing '
                + 'its rationale are different faults with different fixes.',
            404: 'MODERATION_NOTICE_NOT_FOUND, or not the platform-support tenant.',
        }),
        success: {
            status: 201,
            description: 'The decision, with the id of the action row it created.',
            schema: z.object({
                actionId: z.string(),
                status: z.string(),
                suspended: z.boolean().optional(),
            }),
        },
    });
}
