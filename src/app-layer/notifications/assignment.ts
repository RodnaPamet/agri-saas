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
    /**
     * The PUSH body, which is NOT `bodyKey` — #1999.
     *
     * `bodyKey` interpolates `{label}`, which is the entity's KEY plus the
     * farmer's own title in quotes. That body is correct for the bell and the
     * web UI, which are inside our own boundary. A push alert is not: APNs
     * payloads are not end-to-end encrypted, so Apple reads
     * `aps.alert.body` — and a task title is farm operational prose
     * («Пръскане на блок 3 срещу мана»).
     *
     * So the push body interpolates `{key}` only. Owner ruling 2026-11-01,
     * chosen over strict ids-only (which would show «Възложена Ви е задача»
     * with no key and force the app open to learn which one) and over
     * keeping the prose. Web Push is encrypted to the subscription's own
     * `p256dh`/`auth` keys, so the push service cannot read it there — the
     * reduction is for Apple, and it is applied to BOTH transports because one
     * payload feeds both and two bodies for one notification is a drift seam.
     */
    pushBodyKey: string;
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
        pushBodyKey: 'notifications.assignment.task.pushBody',
        linkPath: (slug, id) => `/t/${slug}/farm-tasks/${id}`,
    },
    ASSET_ASSIGNED: {
        titleKey: 'notifications.assignment.asset.title',
        bodyKey: 'notifications.assignment.asset.body',
        pushBodyKey: 'notifications.assignment.asset.pushBody',
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
    notification?: {
        title: string;
        /** For the bell and the web UI — carries the farmer's own label. */
        message: string;
        /**
         * For a PUSH payload — carries the entity KEY and no free text
         * (#1999). Empty when the entity has no key, which makes the push
         * title-only rather than letting the prose back in through a
         * fallback.
         */
        pushBody: string;
        linkUrl: string;
    };
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
    // No key means no push body: the alert then carries its title only.
    // Falling back to `label` here is the whole defect #1999 is about, and a
    // fallback is exactly how it would come back.
    const pushBody = target.entityKey
        ? await translateFor(target.locale, copy.pushBodyKey, { key: target.entityKey })
        : '';

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
        ? {
              status: 'created',
              notification: {
                  title: row.title,
                  message: row.message,
                  pushBody,
                  linkUrl: row.linkUrl,
              },
          }
        : { status: 'duplicate' };
}
