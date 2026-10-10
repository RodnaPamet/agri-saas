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
            + '\n\nStored **rendered** rather than as a template reference, following the `NotificationOutbox` precedent: what was sent is a fact, and re-rendering later from a since-changed template would answer a different question.'
            + '\n\n`recipientUserId` IS supplied, unlike the moderator. The subject of an action is content — a removed listing names a farm — so who is entitled to the statement is a judgement the moderator makes, and guessing who receives a legal notice is worse than being told.'
            + '\n\n`locale` defaults to `bg` when unpinned. P5.4b replaces that with the recipient’s own locale resolved at SEND time and records which was used, because Art 17 says "in the recipient’s language" and a default is not that.'
            + KEY_GATE,
        tags: ['Moderation'],
        body: QueueStatementSchema,
        success: {
            status: 201,
            description: 'The statement is queued for delivery.',
            schema: z.object({ statementId: z.string() }),
        },
    });
}
