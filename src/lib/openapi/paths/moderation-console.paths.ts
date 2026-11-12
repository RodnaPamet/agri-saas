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
        path: '/api/t/{tenantSlug}/admin/moderation/statements',
        operationId: 'listUndeliveredStatementsFromConsole',
        summary: 'Statements of reasons that have not been delivered',
        description:
            'Oldest first — the lag is the thing being measured.'
            + '\n\n**Surfacing this is part of the Art 17 duty, not an operational '
            + 'nicety.** A statement that never went out is a compliance failure whose '
            + 'danger is that nothing else would show it: the action is recorded, the '
            + 'notice reads ACTIONED, and the recipient simply never heard.'
            + '\n\n`StatementOfReasons` IS the outbox. `NotificationOutbox` is '
            + 'tenant-scoped with a non-nullable `tenantId`, and a statement goes to a '
            + 'PERSON who may have no farm or several — resolving one would invent a tenant '
            + 'for a person-scoped obligation. `deliveredAt IS NULL` is the queue, and '
            + '`statement-dispatch` drains it every 10 minutes.'
            + '\n\n**What this does NOT answer:** which DECISIONS produced no statement. '
            + 'Nothing answers that; it is a separate gap. A view labelled "unexplained '
            + 'decisions" would be claiming it while showing this, which would read as '
            + 'coverage.'
            + TWO_DOORS,
        tags: ['Admin'],
        params: TenantParams,
        query: z.object({
            limit: z.string().optional().openapi({
                description: 'Positive integer, clamped to 200.',
            }),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_LIMIT — a non-integer `limit`.',
            404: 'Not the platform-support tenant.',
        }),
        success: {
            status: 200,
            description: 'The undelivered queue, oldest first.',
            schema: z.object({
                statements: z.array(z.object({
                    id: z.string(),
                    actionId: z.string(),
                    recipientUserId: z.string(),
                    locale: z.string(),
                    createdAt: z.string().datetime({ offset: true }),
                })),
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/moderation/statements',
        operationId: 'queueStatementFromConsole',
        summary: 'Queue a statement of reasons by hand',
        description:
            '**`recipientUserId` is SUPPLIED, and that is deliberate.** An action\'s '
            + 'subject is CONTENT, not a person — a removed listing names a FARM — so who '
            + 'is entitled to the statement is a judgement the moderator makes, and there '
            + 'is no field on `ModerationAction` it could be derived from without '
            + 'guessing. Guessing who receives a legal notice is worse than being told.'
            + '\n\n**`locale` is a PLACEHOLDER, not a language choice.** '
            + '`statement-dispatch` resolves the recipient\'s own locale at SEND time and '
            + 'writes it back before stamping `deliveredAt`, because Art 17 requires the '
            + 'recipient\'s language and a console default is not that. The fallback is '
            + '`bg` rather than `DEFAULT_LOCALE` — which is `en`, documented for '
            + 'UNAUTHENTICATED surfaces — because a statement recipient is a known user '
            + 'whose `uiLanguage` column defaults to `bg`.'
            + '\n\n**The moderator is NOT a field.** It comes from the verified session, '
            + 'and the keyed sibling takes it from the verified key; neither accepts it '
            + 'from the body.'
            + TWO_DOORS,
        tags: ['Admin'],
        params: TenantParams,
        body: z.object({
            actionId: z.string().min(1).max(200),
            recipientUserId: z.string().min(1).max(200),
            locale: z.string().min(2).max(10).optional(),
            bodyRendered: z.string().min(1),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_JSON or INVALID_BODY.',
            404: 'Not the platform-support tenant.',
        }),
        success: {
            status: 201,
            description: 'The queued statement.',
            schema: z.object({ statementId: z.string() }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/admin/moderation/metrics',
        operationId: 'moderationHandlingStatsFromConsole',
        summary: 'Notice handling-time statistics',
        description:
            'P5\'s exit criterion is a MEDIAN HANDLING TIME, and this is the figure it is '
            + 'measured on. A number nobody can see without holding the platform key is a '
            + 'number nobody checks.'
            + '\n\n**The window is bounded at 365 days and defaults to 30.** An '
            + 'unbounded window is a different question: a lifetime median hides a '
            + 'regression, because a service that answered quickly for a year can be '
            + 'failing this month and the all-time figure will not move for a long while. '
            + 'An out-of-range or non-integer `windowDays` falls back to the default '
            + 'rather than erroring — preserved from the keyed route, and the weaker '
            + 'choice of the two, since a caller who asks for 90 days and silently '
            + 'receives 30 reads the figure as a 90-day one.'
            + '\n\n**It reads nothing per-person** — no reporter, no subject, no '
            + 'moderator — so unlike the triage queue there is nothing here to withhold.'
            + TWO_DOORS,
        tags: ['Admin'],
        params: TenantParams,
        query: z.object({
            windowDays: z.string().optional().openapi({
                description: 'Integer 1-365. Anything else falls back to 30.',
            }),
        }),
        extraResponses: codedErrorResponses({
            404: 'Not the platform-support tenant.',
        }),
        success: {
            status: 200,
            description: 'Counts by status and elapsed-time statistics for the window.',
            schema: z.object({}).passthrough(),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/moderation/restore',
        operationId: 'restoreRemovedContentFromConsole',
        summary: 'Reverse a content removal',
        description:
            'Writes a SECOND `ModerationAction` (`CONTENT_RESTORED`) rather than editing '
            + 'the first, and leaves `ContentReport.status` at ACTIONED: the notice WAS '
            + 'acted on and the action was later reversed, which is what the second row '
            + 'records. Moving the notice back to RECEIVED would put a decided notice into '
            + 'the triage queue and ask a moderator to decide it again.'
            + '\n\n**`restored: false` is a SUCCESS.** The usecase is idempotent, so '
            + 'restoring something already visible reports `false` with a real '
            + '`restoreActionId` — a client treating that as an error would make a double '
            + 'submit read as a failure. A NULL `restoreActionId` is the error, and it is a '
            + '404.'
            + TWO_DOORS,
        tags: ['Admin'],
        params: TenantParams,
        body: z.object({
            actionId: z.string().min(1).max(200),
            rationale: z.string().min(1).openapi({
                description:
                    'REQUIRED. A reversal is a decision too, and this is the text its own '
                    + 'statement of reasons is composed from.',
            }),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_JSON or INVALID_BODY.',
            404: 'MODERATION_ACTION_NOT_FOUND, or not the platform-support tenant.',
        }),
        success: {
            status: 200,
            description: 'The reversal, with the id of the second action row.',
            schema: z.object({
                restoreActionId: z.string().nullable(),
                restored: z.boolean(),
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/moderation/suspensions',
        operationId: 'suspendAccountFromConsole',
        summary: 'Suspend an account',
        description:
            '**The account is SUPPLIED as a `userId`, and there is deliberately no people '
            + 'lookup** (owner ruling 2026-11-12). Three reasons, and none of them is '
            + 'convenience: a platform-wide search by name or email would be the first '
            + 'surface in this product where one person can enumerate every account; the '
            + 'common case already has the id, because the triage queue returns '
            + '`subjectId`; and deriving "the responsible account" from a notice is the '
            + 'judgement P5.1 left to a human, since a notice names CONTENT and a reported '
            + 'listing belongs to a farm whose members are several.'
            + '\n\n**`reason` is REQUIRED** (#1667): it is the `rationale` of the '
            + '`ModerationAction` this records, encrypted at rest, and the text the Art 17 '
            + 'statement is composed from. A decision that withholds a farm from a person '
            + 'is not recordable without one.'
            + '\n\n**Idempotent.** A repeat returns `applied: true` with '
            + '`alreadySuspended: true` and does NOT re-stamp `suspendedAt` — the date an '
            + 'appeal and a regulator both work from. So `applied: false` means no such '
            + 'account and nothing else, which is the 404.'
            + TWO_DOORS,
        tags: ['Admin'],
        params: TenantParams,
        body: z.object({
            userId: z.string().min(1).max(200),
            reason: z.string().min(1),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_JSON or INVALID_BODY.',
            404: 'ACCOUNT_NOT_FOUND, or not the platform-support tenant.',
        }),
        success: {
            status: 200,
            description: 'The outcome, including whether it was already suspended.',
            schema: z.object({
                applied: z.boolean(),
                sessionsRevoked: z.number().int(),
                alreadySuspended: z.boolean(),
            }),
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/admin/moderation/suspensions',
        operationId: 'liftSuspensionFromConsole',
        summary: 'Lift a suspension',
        description:
            '**Takes a BODY rather than a path or query parameter**, matching the keyed '
            + 'sibling and P5.2b\'s rule: iOS logs the full URL unsuppressably, and a '
            + 'third party\'s user id in a device log is a disclosure.'
            + '\n\n**No `reason` field, and that is the signature rather than an '
            + 'omission.** Restoring the ability to sign in is not a decision the Art 17 '
            + 'machinery composes a statement from.'
            + '\n\n**What it does NOT do:** decrement `sessionVersion`, un-revoke '
            + 'sessions, or cancel an erasure the person requested themselves. '
            + 'Reinstatement restores the ability to sign in, not credentials that may '
            + 'since have been shared — and a self-requested deletion is the person\'s own '
            + 'decision, which a moderator must not quietly reverse.'
            + '\n\n`wasSuspended: false` is a SUCCESS (lifting a suspension that was not '
            + 'there is idempotent); `applied: false` means no such account, and is a 404.'
            + TWO_DOORS,
        tags: ['Admin'],
        params: TenantParams,
        body: z.object({ userId: z.string().min(1).max(200) }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_JSON or INVALID_BODY.',
            404: 'ACCOUNT_NOT_FOUND, or not the platform-support tenant.',
        }),
        success: {
            status: 200,
            description: 'The outcome, including whether it had been suspended.',
            schema: z.object({ applied: z.boolean(), wasSuspended: z.boolean() }),
        },
    });

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
