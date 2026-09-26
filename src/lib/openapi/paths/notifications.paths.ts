/**
 * The notification bell — the list, the mark-read, and the live stream.
 *
 * Five routes, and the shape of the surface is the first thing a client needs
 * to know, because it is not obvious from any one of them.
 *
 * ── the same list exists at TWO paths, and the same mutation at TWO verbs ──
 *
 *   GET   /api/notifications                       \  same usecase,
 *   GET   /api/t/{tenantSlug}/notifications        /  same 50 rows
 *
 *   PATCH /api/notifications/{id}                  \  same usecase,
 *   PUT   /api/t/{tenantSlug}/notifications/{id}   /  different VERB
 *
 * The unprefixed pair resolves its context legacy-style; the tenant-scoped pair
 * takes the tenant from the path. A native client should prefer the
 * tenant-scoped pair — it is explicit about which tenant it is asking about,
 * which the unprefixed one leaves to the session. The verb difference is
 * historical, not semantic; both mark exactly one notification read and both
 * answer `{ success: true }`.
 *
 * Documented as they are rather than reconciled: the web bell calls the
 * unprefixed pair today, so removing either is a change to a live client.
 *
 * ── the list is CAPPED at 50 and says nothing about it ──
 *
 * `NotificationRepository.listMine` is `take: 50` with no count and no
 * truncation marker. A user with 200 unread notifications receives the 50
 * newest and is told they are all of them. That is worth knowing before
 * building an unread BADGE off the array length: the badge saturates silently
 * at 50. This module documents the cap rather than changing the query, because
 * adding a count is a real decision about a hot read, not a doc fix.
 *
 * ── `title` and `message` are SERVER-AUTHORED PROSE ──
 *
 * Not keys. They are composed where the notification is created, which means
 * the language is decided by the producer rather than the reader. The
 * calculator's refusals carry a machine code with English as a fallback for
 * exactly this reason (`docs/i18n-airtight-roadmap.md` class B); notifications
 * do not yet. A client cannot translate these, and should render them as given.
 *
 * ── the stream is SSE, and deliberately has no `event:` field ──
 *
 * `GET /api/notifications/stream` is `text/event-stream`, one `data:` line per
 * notification carrying the same JSON as a list row minus `tenantId`, `userId`
 * and `dedupeKey`. There is no `event:` name, so a client uses the DEFAULT
 * message handler — `EventSource.onmessage`, not `addEventListener('...')`.
 * A heartbeat keeps the connection alive through proxies.
 *
 * It replaced a 60s poll. Mark-read does NOT travel on it: the stream is
 * one-way, and the REST routes above are how a client acknowledges.
 */
import { z } from '@/lib/openapi/zod';
import { NotificationType } from '@prisma/client';
import { EmptyBodySchema } from '@/lib/schemas';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const IdParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const TenantIdParams = TenantParams.extend({
    id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
});

const NotificationSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        userId: z.string(),
        type: z.nativeEnum(NotificationType),
        /** SERVER-AUTHORED prose, not an i18n key. Render as given. */
        title: z.string(),
        message: z.string(),
        read: z.boolean(),
        /** Where the bell should navigate. Null for a notification with no target. */
        linkUrl: z.string().nullable(),
        /**
         * The producer's idempotency key — one notification per
         * (entity, recipient, day) for the assignment and due-date types.
         * Exposed because it is on the model; a client has no use for it.
         */
        dedupeKey: z.string().nullable(),
        createdAt: z.string().datetime(),
    })
    .openapi('Notification', {
        description:
            'One bell notification. title and message are server-authored prose in the producer’s language, NOT translatable keys — a client renders them as given. linkUrl is where the bell navigates and is null when there is no target.',
    });

const MarkReadAckSchema = z
    .object({ success: z.boolean() })
    .openapi('NotificationMarkReadAck', {
        description:
            'Acknowledgement only. The notification itself is not returned — the caller already has it and `read` is the only field that changed.',
    });

const LIST_DESCRIPTION =
    'The 50 NEWEST notifications for the calling user, newest first. ' +
    '\n\n**The cap is silent.** There is no total and no truncation marker, so a user with more than 50 receives 50 and cannot tell. An unread badge computed from this array saturates at 50 without saying so.';

export function registerNotificationPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/notifications',
        operationId: 'listTenantNotifications',
        summary: 'The calling user’s notifications',
        description:
            LIST_DESCRIPTION +
            '\n\nPREFER this over the unprefixed `/api/notifications`: it is explicit about which tenant is being asked about, rather than leaving it to the session.',
        tags: ['Notifications'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The notifications. A BARE ARRAY, capped at 50.',
            schema: z.array(NotificationSchema),
        },
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/notifications/{id}',
        operationId: 'markTenantNotificationRead',
        summary: 'Mark one notification read',
        description:
            'Marks exactly one notification read. The body is EMPTY — read is the only transition, so there is nothing to send. ' +
            '\n\nNote the verb: this is PUT, while the unprefixed equivalent is PATCH. Historical, not semantic.',
        tags: ['Notifications'],
        params: TenantIdParams,
        body: EmptyBodySchema,
        success: { status: 200, description: 'Acknowledged.', schema: MarkReadAckSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/notifications',
        operationId: 'listMyNotifications',
        summary: 'The calling user’s notifications (unprefixed)',
        description:
            LIST_DESCRIPTION +
            '\n\nThe tenant comes from the SESSION rather than the path. Identical rows to `/api/t/{tenantSlug}/notifications`; that one is preferable for a native client.',
        tags: ['Notifications'],
        success: {
            status: 200,
            description: 'The notifications. A BARE ARRAY, capped at 50.',
            schema: z.array(NotificationSchema),
        },
    });

    op(registry, {
        method: 'patch',
        path: '/api/notifications/{id}',
        operationId: 'markNotificationRead',
        summary: 'Mark one notification read (unprefixed)',
        description:
            'Marks exactly one notification read. Same effect as the tenant-scoped PUT; the verb differs for historical reasons.',
        tags: ['Notifications'],
        params: IdParam,
        success: { status: 200, description: 'Acknowledged.', schema: MarkReadAckSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/notifications/stream',
        operationId: 'streamNotifications',
        summary: 'Live notification stream (Server-Sent Events)',
        description:
            'A long-lived `text/event-stream`. One `data:` line per new notification, carrying the same fields as a list row MINUS `tenantId`, `userId` and `dedupeKey`. ' +
            '\n\n**There is no `event:` name**, so consume it with the default message handler (`EventSource.onmessage`), not a named listener. A periodic heartbeat keeps the connection open through proxies and CDNs. ' +
            '\n\nThe stream is ONE-WAY. Mark-read does not travel on it — use `PUT /api/t/{tenantSlug}/notifications/{id}`. ' +
            '\n\nIt replaced a 60s poll, so a client should not also poll the list on a timer; fetch the list once for backfill, then follow the stream.',
        tags: ['Notifications'],
        success: {
            status: 200,
            description:
                'An open event stream. Each event’s `data` is one notification as JSON.',
            content: {
                'text/event-stream': z
                    .object({
                        id: z.string(),
                        type: z.string(),
                        title: z.string(),
                        message: z.string(),
                        read: z.boolean(),
                        linkUrl: z.string().nullable(),
                        createdAt: z.string().datetime(),
                    })
                    .openapi('NotificationStreamEvent', {
                        description:
                            'The JSON carried by one `data:` line. Narrower than the list row: no tenantId, userId or dedupeKey.',
                    }),
            },
        },
    });
}
