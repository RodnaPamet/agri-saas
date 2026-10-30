/**
 * ONE notification for a bulk task action — #2103.
 *
 * ## Why a summary and not N notifications
 *
 * Five usecases in `task.ts` can change `assigneeUserId` or `dueAt`. Three
 * notified the assignee and the two BULK ones did not, so being assigned
 * twenty tasks at once was completely silent while being assigned one was not.
 *
 * The owner's ruling was one summary per bulk action rather than one per task.
 * The reason is the shape of the alternative: twenty bell rows and twenty
 * pushes for a single click is what a digest exists to prevent, and this repo
 * has the measurement to prove it is not hypothetical — 99.6% of production
 * notification rows share a `(userId, createdAt)` millisecond, in groups up to
 * 22, produced by one sweep writing a batch. That tie pattern is what P7.2's
 * replay cursor had to be built around.
 *
 * ## The count comes from the UPDATE, not from the request
 *
 * `WorkItemRepository.bulkAssign` is an `updateMany` filtered on
 * `{ id: { in: taskIds }, tenantId }`, so it can match FEWER rows than the
 * caller asked for — an id that does not exist, or belongs to another tenant,
 * silently drops out. Saying "20 tasks" when three were written would be a
 * notification that misreports what happened, so the count is `result.count`.
 *
 * ## The dedupe key is the batch, not the entity
 *
 * `createAssignmentNotification` keys on `(tenantId, TYPE, entityId, userId,
 * date)`, which a bulk action has no single value for. Keying on a hash of the
 * sorted task ids instead gives the property that matters: a RETRY of the same
 * batch collapses, while a genuinely different batch on the same day does not.
 * Sorted, so the same set in a different order is the same key.
 *
 * ## The bus frame carries the ROW id, and that is deliberate
 *
 * `createAssignmentNotification` publishes `{ id: row.dedupeKey }`, because
 * `createMany` does not return ids. That is a hint the client cannot resolve:
 * `serialiseFrame` puts a notification frame's id on the SSE `id:` line, so it
 * becomes the client's `Last-Event-ID`, and `replayNotificationIdsAfter` looks
 * that up as a `Notification.id` — finds nothing, and replays nothing. Filed
 * separately rather than changed there.
 *
 * Here the row is read back by its dedupeKey after the insert, so the frame
 * carries an id a reconnect can actually resolve. One indexed read on a unique
 * column, on a path that already runs after the transaction committed.
 *
 * ## Localised, unlike its siblings
 *
 * This follows `jobs/push-summary.ts` and goes through `translateFor`, because
 * the product is Bulgarian and new prose should not add to that debt.
 *
 * `assignment.ts` and `task-due.ts` held English literals when this was
 * written and no longer do — they were brought through `translateFor` by the
 * fix for the owner's "notifications are in English" report. `agro.ts` is
 * still English and is tracked on #2490, where the blocker is that its body
 * interpolates a pre-rendered English sentence (`spray.reasons[0]`) rather
 * than a descriptor, so translating it at this layer alone would ship a
 * Bulgarian sentence with an English clause inside it.
 *
 * Two copy keys per kind rather than one ICU plural: `translateFor`'s
 * interpolation is a plain `{name}` replacement and does not evaluate
 * `{count, plural, …}`, so an ICU key reached from here renders its raw
 * syntax.
 */
import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { publishNotificationEvent } from '@/lib/notifications/notification-bus';
import { afterCommit } from '@/lib/db/after-commit';
import { translateFor } from '@/lib/i18n/server-messages';
import type { Locale } from '@/lib/i18n/locales';

/** Which bulk action happened. Drives the copy and the notification type. */
export type BulkTaskSummaryKind = 'assigned' | 'rescheduled';

interface SummaryCopy {
    /** `Notification.type`, reusing the existing enum values. */
    type: 'TASK_ASSIGNED' | 'TASK_DUE';
    titleKey: string;
    bodyOneKey: string;
    bodyManyKey: string;
}

const COPY: Record<BulkTaskSummaryKind, SummaryCopy> = {
    assigned: {
        type: 'TASK_ASSIGNED',
        titleKey: 'notifications.bulkTask.assigned.title',
        bodyOneKey: 'notifications.bulkTask.assigned.bodyOne',
        bodyManyKey: 'notifications.bulkTask.assigned.bodyMany',
    },
    rescheduled: {
        type: 'TASK_DUE',
        titleKey: 'notifications.bulkTask.rescheduled.title',
        bodyOneKey: 'notifications.bulkTask.rescheduled.bodyOne',
        bodyManyKey: 'notifications.bulkTask.rescheduled.bodyMany',
    },
};

export interface BulkTaskSummaryTarget {
    tenantId: string;
    tenantSlug: string;
    /** Who sees the bell row. Never the person who performed the action. */
    recipientUserId: string;
    /** The ids actually written, which is what `count` is derived from. */
    taskIds: string[];
    locale: Locale;
}

export interface BulkTaskSummaryOutcome {
    status: 'created' | 'duplicate' | 'empty';
    notification?: { id: string; title: string; message: string; linkUrl: string };
}

/**
 * The batch's identity: a hash of its sorted ids.
 *
 * Truncated to 16 hex characters — 64 bits, against a population of one
 * person's bulk actions in one day. Collision would mean a second batch
 * silently not notifying; the alternative of putting every id in the key makes
 * it unbounded, and `dedupeKey` is an indexed column.
 */
export function buildBulkDedupeKey(
    tenantId: string,
    kind: BulkTaskSummaryKind,
    taskIds: string[],
    recipientUserId: string,
    now: Date,
): string {
    const digest = createHash('sha256')
        .update([...taskIds].sort().join(','))
        .digest('hex')
        .slice(0, 16);
    const day = now.toISOString().slice(0, 10);
    return `${tenantId}:BULK_${kind.toUpperCase()}:${digest}:${recipientUserId}:${day}`;
}

/** Where the bell row goes. The filter key is the one `farm-tasks` parses. */
function linkFor(kind: BulkTaskSummaryKind, tenantSlug: string, recipientUserId: string): string {
    // `?assigneeUserId=` is read back by `parseUrlToFilterState` in
    // `filter-context.tsx`, and `farm-tasks` registers that filter key with no
    // url prefix — so this lands on the task list already narrowed to the
    // person reading it. Root-relative, like every other notification link.
    const base = `/t/${tenantSlug}/farm-tasks`;
    return kind === 'assigned' ? `${base}?assigneeUserId=${recipientUserId}` : base;
}

export async function createBulkTaskSummaryNotification(
    db: Pick<PrismaClient, 'notification'>,
    kind: BulkTaskSummaryKind,
    target: BulkTaskSummaryTarget,
    now: Date = new Date(),
): Promise<BulkTaskSummaryOutcome> {
    const count = target.taskIds.length;
    // Nothing was written, so there is nothing to say. Distinct from
    // `duplicate` on purpose: the caller logs them differently, and "the
    // update matched no rows" is a different fact from "we already told them".
    if (count === 0) return { status: 'empty' };

    const copy = COPY[kind];
    const dedupeKey = buildBulkDedupeKey(
        target.tenantId,
        kind,
        target.taskIds,
        target.recipientUserId,
        now,
    );

    const title = await translateFor(target.locale, copy.titleKey);
    const message = await translateFor(
        target.locale,
        count === 1 ? copy.bodyOneKey : copy.bodyManyKey,
        { count },
    );
    const linkUrl = linkFor(kind, target.tenantSlug, target.recipientUserId);

    const result = await db.notification.createMany({
        data: [
            {
                tenantId: target.tenantId,
                userId: target.recipientUserId,
                type: copy.type,
                title,
                message,
                linkUrl,
                dedupeKey,
            },
        ],
        // Never a bare `create`: a duplicate dedupeKey raises P2002, which
        // poisons an interactive Postgres transaction for every statement
        // after it. `skipDuplicates` returns count=0 instead.
        skipDuplicates: true,
    });

    if (result.count === 0) return { status: 'duplicate' };

    // Read the id back so the bus frame is resolvable — see the docblock.
    const row = await db.notification.findFirst({
        where: { dedupeKey },
        select: { id: true },
    });
    if (!row) {
        // Written and immediately unreadable. Possible only if something
        // deleted it between the two statements; reported as created without a
        // payload rather than inventing an id for the frame.
        return { status: 'created' };
    }

    afterCommit('notify.bulk_task_summary', () =>
        publishNotificationEvent(target.tenantId, target.recipientUserId, { id: row.id }),
    );

    return { status: 'created', notification: { id: row.id, title, message, linkUrl } };
}
