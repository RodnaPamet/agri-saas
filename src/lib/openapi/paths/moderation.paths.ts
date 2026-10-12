/**
 * The moderation console — `/api/admin/moderation/*` (P5.4a, #1595).
 *
 * Platform-admin-key gated, like every other `admin/*` surface. Documented
 * because `openapi-paths-complete` requires it and because the two things a
 * reader most needs to know are not visible from the shapes: who the moderator
 * is recorded as, and why the statements endpoint is a queue.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { ActOnNoticeSchema, QueueStatementSchema } from '@/lib/schemas';
import { op } from './helpers';

const KEY_GATE =
    '\n\n**Platform-admin key**, not a tenant permission. Every role in the enum is '
    + 'tenant-scoped, so `admin.manage` would let an ADMIN of any one farm read every '
    + 'other farm’s notices — which is also why the underlying tables deny `app_user` '
    + 'outright rather than relying on this route to filter.';

const QueuedNoticeSchema = z
    .object({
        id: z.string(),
        createdAt: z.string().datetime({ offset: true }),
        subjectKind: z.enum(['LISTING', 'MESSAGE', 'PROFILE', 'THREAD']),
        subjectId: z.string(),
        reasonCode: z.string(),
        status: z.string(),
        anonymous: z.boolean().openapi({
            description:
                'Whether the notifier gave an id. **Never which one** — `reporterUserId` is not returned. A moderator decides on the CONTENT, and knowing who reported it invites deciding on the reporter. This flag is returned because it changes whether there is anyone to answer to.',
        }),
        detail: z.string().nullable().openapi({
            description: 'The notifier’s own words, sanitised on the write path. `null` when they wrote nothing, or wrote only markup.',
        }),
        snapshot: z
            .object({
                capturedAt: z.string().datetime({ offset: true }),
                captureError: z.string().nullable(),
            })
            .nullable()
            .openapi({
                description:
                    'Whether evidence was captured and, if not, why. `SUBJECT_NOT_FOUND` means the content was gone before the capture ran — the normal case for a notice about something real — and `SUBJECT_KIND_NOT_CAPTURABLE` means that surface has no capture path yet. The two are distinct so a deleted listing is not confused with a gap in our own code.',
            }),
    })
    .openapi('QueuedNotice', { description: 'A notice as the triage queue shows it.' });

export function registerModerationPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/admin/moderation/notices',
        operationId: 'listModerationNotices',
        summary: 'Moderation — the triage queue',
        description:
            'Notices awaiting or past triage, **oldest first within a status**. That ordering is the operational one: P5’s exit criterion is a median handling time, and a newest-first queue optimises the wrong end of it.'
            + '\n\nFilter with `?status=RECEIVED|TRIAGED|ACTIONED|REJECTED`.'
            + KEY_GATE,
        tags: ['Moderation'],
        success: {
            status: 200,
            description: 'The queue.',
            schema: z.object({ notices: z.array(QueuedNoticeSchema) }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/admin/moderation/notices',
        operationId: 'actOnModerationNotice',
        summary: 'Moderation — record a decision on a notice',
        description:
            'Writes a `ModerationAction` and moves the notice’s status, in ONE transaction. A notice marked ACTIONED with no action row, or an action whose notice still reads RECEIVED, are both states a queue cannot tell from a crash — so neither is reachable.'
            + '\n\n`actionKind: "NONE"` is a real outcome, not a no-op: "looked and did nothing" must be distinguishable from "never looked", and it moves the notice to REJECTED — the judgement.'
            + '\n\n**The moderator is taken from the verified key and is never read from the body.** It records which key GENERATION authorised the action (current or previous), which narrows a compromise window to one side of a rotation. It is deliberately **not a person**: there is one platform key for every operator, so a regulator asking "who decided this" gets "somebody holding the key". Per-moderator attribution needs per-moderator credentials — tracked in P5.8.'
            + '\n\nThe subject is denormalised from the notice, so an action cannot be recorded against content it was not about. `rationale` is REQUIRED — unlike a notice’s `detail`, because a decision without a reason is what Art 17 exists to prevent, and it is the text the statement is built from.'
            + '\n\n404 when the notice does not exist. Unlike the public notice route, a platform admin is entitled to that difference — there it would be an enumeration oracle.'
            + KEY_GATE,
        tags: ['Moderation'],
        body: ActOnNoticeSchema,
        success: {
            status: 201,
            description: 'The action was recorded and the notice moved.',
            schema: z.object({
                actionId: z.string(),
                status: z.enum(['RECEIVED', 'TRIAGED', 'ACTIONED', 'REJECTED']),
            }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/admin/moderation/statements',
        operationId: 'listUndeliveredStatements',
        summary: 'Moderation — statements not yet delivered',
        description:
            'Art 17 statements written and not yet sent, oldest first.'
            + '\n\n**This is the drain queue, and surfacing it is part of the duty.** A statement that never went out is a compliance failure, and what makes it dangerous is that nothing else would show it: the action is recorded, the notice reads ACTIONED, and the recipient simply never heard. The lag from `createdAt` to `deliveredAt` is also how P5’s median-handling criterion is measured rather than asserted.'
            + '\n\n`bodyRendered` is NOT returned. It is the delivered text, encrypted at rest, and this view needs to know THAT something is stuck rather than to re-read what it says.'
            + KEY_GATE,
        tags: ['Moderation'],
        success: {
            status: 200,
            description: 'Undelivered statements.',
            schema: z.object({
                statements: z.array(
                    z.object({
                        id: z.string(),
                        actionId: z.string(),
                        recipientUserId: z.string(),
                        locale: z.string(),
                        createdAt: z.string().datetime({ offset: true }),
                    }),
                ),
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/admin/moderation/statements',
        operationId: 'queueStatementOfReasons',
        summary: 'Moderation — queue a statement of reasons',
        description:
            'Writes the Art 17 statement with `deliveredAt` NULL. **The row IS the outbox**: `NotificationOutbox` is tenant-scoped with a non-nullable `tenantId`, and a statement is addressed to a PERSON who may have no farm or several — resolving one would be inventing a tenant for a person-scoped obligation.'
            + '\n\nStored **rendered** rather than as a template reference, following the `NotificationOutbox` precedent: what was sent is a fact, and re-rendering later from a since-changed template would answer a different question. **The body supplied here is therefore a DRAFT** — dispatch replaces it with the text it actually sent, in the recipient’s language, so the stored row stays that fact rather than a guess at it.'
            + '\n\n`recipientUserId` IS supplied, unlike the moderator. The subject of an action is content — a removed listing names a farm — so who is entitled to the statement is a judgement the moderator makes, and guessing who receives a legal notice is worse than being told.'
            + '\n\n**`locale` on this body is a HINT that dispatch overwrites.** Art 17 says "in the recipient’s language", and a console default is not that — so `statement-dispatch` resolves the recipient’s own `uiLanguage` at SEND time, composes the final text then, and writes both the resolved locale and the delivered body back. It defaults to `bg` here only so the queued row is never NULL.'
            + KEY_GATE,
        tags: ['Moderation'],
        body: QueueStatementSchema,
        success: {
            status: 201,
            description: 'The statement is queued for delivery.',
            schema: z.object({ statementId: z.string() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/admin/moderation/suspensions',
        operationId: 'suspendAccount',
        summary: 'Moderation — suspend an account',
        description:
            'Withholds an account\u2019s access immediately. The suspension is read on EVERY authenticated request, so it takes effect on the next one rather than at the next token refresh.'
            + '\n\n**This exists alongside the notice route rather than instead of it.** Recording `ACCOUNT_SUSPENDED` on a notice already suspends the named account, in the same transaction \u2014 recording that outcome without performing it was a real defect (#1635), where the console reported success, the Art 17 statement told the recipient they could not post, and nothing withheld anything. What a notice cannot do is LIFT a suspension (an upheld appeal has no notice to act on) or suspend an account found abusive by a pattern across many subjects rather than by one report.'
            + '\n\n`userId` is supplied, never derived. A notice names CONTENT \u2014 a reported listing belongs to a farm whose members are several \u2014 so which account to withhold from is a judgement a moderator makes, the same reasoning that puts `recipientUserId` on a statement.'
            + '\n\nIdempotent: suspending an already-suspended account returns `alreadySuspended: true` and does NOT re-stamp the original timestamp, which is what an appeal and a regulator both date from. 404 when no such account exists \u2014 a platform admin is entitled to that difference.'
            + '\n\nAudited to the `moderation` scope of `PlatformAuditLog`. `reason` is accepted and deliberately NOT stored there: only whether there was one, because `detailsJson` is not an encrypted column and the rationale belongs on `ModerationAction.rationale`, which is.'
            + KEY_GATE,
        tags: ['Moderation'],
        body: z
            .object({
                userId: z.string(),
                reason: z.string().openapi({
                    description:
                        'Why. REQUIRED since #1667 — it becomes the `rationale` of ' +
                        'the `ModerationAction` this route records, which is encrypted ' +
                        'at rest and is what an Art 17 statement of reasons is composed ' +
                        'from. A decision that withholds a farm from a person is not ' +
                        'recordable without one.\n\n' +
                        'It was optional and the text was DISCARDED: only ' +
                        '`hasReason: true|false` reached the platform audit chain, under ' +
                        'a comment correctly saying the rationale belongs on ' +
                        '`ModerationAction.rationale` — a row this path never created.',
                }),
            })
            .openapi('SuspendAccount', {
                description:
                    'The account to withhold access from, and WHY. Both required.',
            }),
        success: {
            status: 200,
            description: 'The account is suspended.',
            schema: z.object({
                suspended: z.boolean(),
                alreadySuspended: z.boolean(),
                sessionsRevoked: z.number().int().openapi({
                    description:
                        'Live `UserSession` rows stamped revoked. Zero is normal \u2014 they may simply not be signed in.',
                }),
            }),
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/admin/moderation/suspensions',
        operationId: 'liftAccountSuspension',
        summary: 'Moderation — lift a suspension',
        description:
            'Restores access on the next request. This is the DSA redress path: a suspension with no way back is a permanent ban wearing a temporary name.'
            + '\n\nTakes a BODY rather than a path or query parameter, for the reason P5.2b\u2019s unblock route does: iOS logs the full URL including the query string, unsuppressably, so a third party\u2019s user id in a device log is the disclosure this phase exists to prevent.'
            + '\n\n`sessionVersion` is NOT decremented and revoked sessions are NOT restored. Both are one-way: reinstatement returns the ability to sign in, not the credentials that existed before \u2014 un-revoking one would resurrect a session that may since have been shared or captured.'
            + KEY_GATE,
        tags: ['Moderation'],
        body: z
            .object({ userId: z.string() })
            .openapi('LiftAccountSuspension', {
                description: 'The account to reinstate.',
            }),
        success: {
            status: 200,
            description: 'The suspension is lifted.',
            schema: z.object({
                suspended: z.boolean(),
                wasSuspended: z.boolean().openapi({
                    description:
                        'False when the account was not suspended \u2014 the call is idempotent rather than an error.',
                }),
            }),
        },
    });
}
