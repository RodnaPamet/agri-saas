/**
 * Task-due notification job (the steady-state cron).
 *
 * Once a day at 08:00 in the configured local zone (`NOTIFICATIONS_TZ`,
 * default Europe/London), scan every active task whose `dueAt` lands
 * on one of three reminder windows — one week out, one day out, or
 * the due day itself — and write an in-app `Notification` (type
 * `TASK_DUE`) to the task's assignee so the deadline surfaces in the
 * notification bell.
 *
 * The window math + the per-task notification writer live in
 * `@/app-layer/notifications/task-due` — shared with the event-driven
 * usecase path. This file owns only the scan loop. See that module
 * for the reminder-window spec and the dedupeKey idempotency
 * contract.
 *
 * Two scope modes (mirrors `access-review-reminder` / `policyReviewReminder`):
 *   - tenantId provided → scan that single tenant.
 *   - tenantId omitted  → scan every tenant (system-wide nightly cron).
 *
 * In-app only. The email deadline digest (`notification-dispatch`)
 * already covers these deadlines over email; this job fills the gap
 * that nothing was writing to the notification bell.
 *
 * Bypassed when:
 *   - Task is RESOLVED / CLOSED / CANCELED or soft-deleted (query filter).
 *   - Task has no assignee — no recipient (query filter).
 *   - `dueAt` is not on a {7,1,0}-day window (skipped silently).
 */
import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/observability/logger';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';
import {
    MS_PER_DAY,
    startOfUtcDay,
    createTaskDueNotification,
    type TaskDueWindow,
} from '../notifications/task-due';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { EXCLUDE_DIARY_CONTAINERS } from '@/lib/operations/diary-container';

// Re-export the shared surface so existing importers (tests, the
// executor registry) keep resolving it from this module.
export {
    MS_PER_DAY,
    daysUntilDue,
    classifyDueWindow,
    buildTaskDueDedupeKey,
    createTaskDueNotification,
    TASK_DUE_WINDOWS,
} from '../notifications/task-due';
export type {
    TaskDueWindow,
    TaskDueTarget,
    TaskDueNotificationOutcome,
} from '../notifications/task-due';

export interface TaskDueNotificationOptions {
    /** When provided, scope ALL queries to this single tenant. */
    tenantId?: string;
    /** Override the "now" anchor — test-only seam. */
    now?: Date;
    /**
     * IANA timezone for calendar-day classification + the dedupeKey
     * date segment. Defaults to `'UTC'` so callers that omit it keep
     * UTC semantics; the real cron passes `NOTIFICATIONS_TZ`.
     */
    tz?: string;
}

export interface TaskDueNotificationResult {
    /** Active, assigned tasks pulled inside the 0-7 day horizon. */
    scanned: number;
    /** Notifications successfully inserted. */
    created: number;
    /** Inserts whose dedupeKey already existed (same local-tz day). */
    skippedDuplicate: number;
    /** Created notifications, broken down by reminder window. */
    byWindow: Record<TaskDueWindow, number>;
}

/**
 * Scan + notify. Public seam — `executor-registry` calls this with
 * the global Prisma client; tests construct their own and call directly.
 */
export async function processTaskDueNotifications(
    db: PrismaClient,
    options: TaskDueNotificationOptions = {},
): Promise<TaskDueNotificationResult> {
    const now = options.now ?? new Date();
    const { tenantId } = options;
    const tz = options.tz ?? 'UTC';
    const scope = tenantId ? 'tenant-scoped' : 'system-wide';

    logger.info('task-due notification scan starting', {
        component: 'task-due-notification',
        scope,
        ...(tenantId ? { tenantId } : {}),
    });

    // Horizon: a deliberately wide UTC range — from one day before
    // UTC-midnight today to nine days after. Days 2-6 (and the ±1-day
    // slop rows) are pulled too but classify to `null` and are
    // ignored; one bounded range query is cheaper than three OR'd
    // ranges. The ±1-day slop guarantees no edge task is missed at a
    // tz/UTC day boundary — `classifyDueWindow` runs the precise
    // tz-aware filter to exactly {7,1,0}, but a task due near local
    // midnight can sit on the UTC day either side of its local one,
    // and a tz offset can be up to ~14h either way.
    const utcMidnight = startOfUtcDay(now);
    const horizonStart = new Date(utcMidnight.getTime() - MS_PER_DAY);
    const horizonEnd = new Date(utcMidnight.getTime() + 9 * MS_PER_DAY);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
        deletedAt: null,
        assigneeUserId: { not: null },
        status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] },
        dueAt: { gte: horizonStart, lt: horizonEnd },
        // A recorded activity must never produce a due-date email. It cannot
        // today — a container carries no `dueAt` and this read requires one —
        // but that makes the property depend on an absence three files away,
        // and the recipient of the mistake would be a farmer told that work
        // they finished last week is due tomorrow.
        ...EXCLUDE_DIARY_CONTAINERS,
    };
    if (tenantId) where.tenantId = tenantId;

    const tasks = await db.task.findMany({
        where,
        select: {
            id: true,
            tenantId: true,
            title: true,
            key: true,
            dueAt: true,
            assigneeUserId: true,
            // The recipient's language, on the query that already runs.
            //
            // This was a second `user.findMany` keyed on the distinct assignee
            // ids. That was correct and still worse: `job-scope-audit` requires
            // every `findMany` in a job to carry an `if (tenantId)` gate, and a
            // read of the tenantless `User` table cannot honestly have one —
            // so satisfying it would have meant either a meaningless gate or
            // loosening an audit that exists to catch an unscoped scan. The
            // relation removes the question by removing the query.
            assignee: { select: { uiLanguage: true } },
            tenant: { select: { slug: true } },
        },
        orderBy: { dueAt: 'asc' },
    });

    const byWindow: Record<TaskDueWindow, number> = { week: 0, day: 0, today: 0 };
    let created = 0;
    let skippedDuplicate = 0;

    for (const task of tasks) {
        // The query guarantees these are non-null, but TS still sees
        // them nullable through the `select` projection.
        if (!task.dueAt || !task.assigneeUserId) continue;

        const { status, window } = await createTaskDueNotification(
            db,
            {
                id: task.id,
                tenantId: task.tenantId,
                tenantSlug: task.tenant.slug,
                title: task.title,
                key: task.key,
                dueAt: task.dueAt,
                assigneeUserId: task.assigneeUserId,
                // An assignee the relation could not load falls back rather
                // than throwing; `resolveRecipientLocale` answers `bg`, which
                // is what the column's own default would have given us.
                locale: resolveRecipientLocale(task.assignee?.uiLanguage),
            },
            now,
            tz,
        );
        if (status === 'created' && window) {
            created++;
            byWindow[window]++;
        } else if (status === 'duplicate') {
            skippedDuplicate++;
        }
    }

    const result: TaskDueNotificationResult = {
        scanned: tasks.length,
        created,
        skippedDuplicate,
        byWindow,
    };

    logger.info('task-due notification scan complete', {
        component: 'task-due-notification',
        scope,
        ...result,
        ...(tenantId ? { tenantId } : {}),
    });

    return result;
}
