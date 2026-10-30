/**
 * 2026-05-27 — Notification streaming/alerts roadmap PR-A.
 *
 * In-app notifications for task + practice assignment. Today the
 * task-assignment path enqueues only an EMAIL via the
 * NotificationOutbox; nothing reaches the bell. The practice-owner
 * path doesn't emit any notification at all. This module unifies
 * both: a single `createAssignmentNotification` function that the
 * caller drives with a typed payload.
 *
 * Mirrors the shape of `createTaskDueNotification` (task-due.ts):
 *   - `db.notification.createMany({ skipDuplicates: true })` so
 *     a duplicate dedupeKey returns count=0 with NO exception
 *     (raw `create` throws P2002 which poisons interactive PG
 *     transactions).
 *   - dedupeKey shape `{tenantId}:{TYPE}:{entityId}:{userId}:{date}`
 *     so the same user being assigned the same entity twice in
 *     one day collapses to a single bell notification — matching
 *     the existing TASK_ASSIGNED email idempotency.
 *
 * Fire-and-forget — callers must isolate the write in its own
 * transaction (see `assignTask` and `setPracticeOwner` paths) so a
 * notification failure never rolls back the parent operation.
 */

import type { PrismaClient } from '@prisma/client';

import { translateFor } from '@/lib/i18n/server-messages';
import type { Locale } from '@/lib/i18n/locales';

import { publishFreshNotifications } from './publish-fresh';

export interface AssignmentTarget {
    /** Tenant the entity belongs to. */
    tenantId: string;
    /** Recipient — the new assignee/owner. */
    assigneeUserId: string;
    /** Entity being assigned. */
    entityId: string;
    /** Display label for the notification body. */
    entityLabel: string;
    /** Optional key for the body (e.g. `T-123` for tasks, `A-7` for assets). */
    entityKey?: string | null;
    /** Tenant slug for the deep link. */
    tenantSlug: string;
    /**
     * The RECIPIENT's language, resolved by the caller.
     *
     * Required rather than defaulted, which is `EnqueueEmailInput.locale`'s
     * rule and for its reason: the row stores RENDERED text, so a forgotten
     * locale is indistinguishable from a chosen one and would silently ship
     * the assigner's language to the assignee. A caller that genuinely cannot
     * read the recipient writes `RECIPIENT_FALLBACK_LOCALE`, so the decision
     * shows in the diff.
     */
    locale: Locale;
}

export type AssignmentNotificationKind =
    | 'TASK_ASSIGNED'
    | 'ASSET_ASSIGNED';

interface AssignmentCopy {
    titleKey: string;
    bodyKey: string;
    linkPath: (tenantSlug: string, entityId: string) => string;
}

/**
 * Copy KEYS, resolved against the recipient's locale at creation time.
 *
 * These were English literals until #2490's sibling fix. The bell row and the
 * push are rendered once, here, so this is the only place the recipient's
 * language can be honoured — and the product is Bulgarian.
 *
 * A key PER KIND rather than one shared "is now yours" body, because Bulgarian
 * agrees the possessive with the noun's gender: задача is feminine («вече е
 * Ваша») and актив is masculine («вече е Ваш»). English collapses both to
 * "yours", which is exactly how one shared string would have hidden the
 * problem.
 */
const COPY: Record<AssignmentNotificationKind, AssignmentCopy> = {
    TASK_ASSIGNED: {
        titleKey: 'notifications.assignment.task.title',
        bodyKey: 'notifications.assignment.task.body',
        linkPath: (slug, id) => `/t/${slug}/farm-tasks/${id}`,
    },
    ASSET_ASSIGNED: {
        titleKey: 'notifications.assignment.asset.title',
        bodyKey: 'notifications.assignment.asset.body',
        linkPath: (slug, id) => `/t/${slug}/assets/${id}`,
    },
};

/**
 * Build the idempotency key. Pure helper so tests can assert the
 * format directly.
 */
export function buildAssignmentDedupeKey(
    tenantId: string,
    kind: AssignmentNotificationKind,
    entityId: string,
    userId: string,
    now: Date = new Date(),
): string {
    // Day granularity in UTC — re-assigning the same user to the
    // same entity within one day shouldn't double-notify the bell.
    const ymd = now.toISOString().slice(0, 10);
    return `${tenantId}:${kind}:${entityId}:${userId}:${ymd}`;
}

export interface AssignmentNotificationOutcome {
    status: 'created' | 'duplicate';
    /**
     * The notification copy, present only when `status === 'created'`. Lets
     * the caller fan the same alert out to other channels (Web Push) without
     * rebuilding the title/body/link.
     */
    notification?: { title: string; message: string; linkUrl: string };
}

export async function createAssignmentNotification(
    db: Pick<PrismaClient, 'notification'>,
    kind: AssignmentNotificationKind,
    target: AssignmentTarget,
    now: Date = new Date(),
): Promise<AssignmentNotificationOutcome> {
    const copy = COPY[kind];
    const label = target.entityKey
        ? `${target.entityKey} "${target.entityLabel}"`
        : `"${target.entityLabel}"`;

    const row = {
        tenantId: target.tenantId,
        userId: target.assigneeUserId,
        type: kind,
        title: await translateFor(target.locale, copy.titleKey),
        message: await translateFor(target.locale, copy.bodyKey, { label }),
        linkUrl: copy.linkPath(target.tenantSlug, target.entityId),
        dedupeKey: buildAssignmentDedupeKey(
            target.tenantId,
            kind,
            target.entityId,
            target.assigneeUserId,
            now,
        ),
    };

    const result = await db.notification.createMany({
        data: [row],
        skipDuplicates: true,
    });

    // 2026-05-28 — fan the fresh insert out to the SSE bus (set up
    // by PR-C #761) so subscribed bell clients see the assignment
    // alert the moment it lands, not on the next 60s poll. Skip
    // when result.count === 0 — that means the dedupeKey collapsed
    // a duplicate, and we already pushed the original.
    if (result.count > 0) {
        // The ROW id, not the dedupeKey — see `publish-fresh.ts`. A dedupeKey
        // on the frame becomes a `Last-Event-ID` that can never resolve, so
        // the client's next reconnect replays nothing (#2142).
        await publishFreshNotifications(db, 'notify.assignment', [
            { tenantId: target.tenantId, userId: target.assigneeUserId, dedupeKey: row.dedupeKey },
        ]);
    }

    return result.count > 0
        ? { status: 'created', notification: { title: row.title, message: row.message, linkUrl: row.linkUrl } }
        : { status: 'duplicate' };
}
