/**
 * Shared TASK_DUE notification logic.
 *
 * The single writer for in-app `TASK_DUE` notifications, plus the
 * pure window-classification math. It has two consumers:
 *   - the daily `jobs/task-due-notification` cron — the steady-state
 *     scan that catches deadlines drifting near;
 *   - the task usecases (`createTask` / `updateTask` / `assignTask`),
 *     which fire it the instant a near-term deadline is set.
 *
 * It lives in `notifications/`, NOT `jobs/`, on purpose. A usecase
 * importing from `jobs/` couples the HTTP request path to the job
 * module graph; `notifications/` is the neutral shared layer that a
 * job and a usecase may both depend on (it sits beside
 * `notifications/enqueue`, which the task usecase already imports).
 * This module's only import is the Prisma *type* — it pulls nothing
 * into a caller's runtime graph.
 *
 * Reminder windows:
 *   A task is notified when the integer count of calendar days from
 *   "now" to `dueAt` is exactly 7, 1, or 0. Days 2-6 produce nothing.
 *   Calendar-day classification (not millisecond math) means a task
 *   due "tomorrow at 23:00" still reads as the one-day window when
 *   the cron fires at 08:00. The calendar days are counted in the
 *   caller-supplied IANA timezone `tz` (default `'UTC'`) — both the
 *   window classification and the dedupeKey date segment are local
 *   to that zone, so a task due near local midnight is bucketed by
 *   the local calendar day, not the UTC one.
 *
 * Deduplication contract:
 *   `Notification.dedupeKey` is unique. The key is
 *   `{tenantId}:TASK_DUE:{window}:{taskId}:{userId}:{YYYY-MM-DD}`,
 *   where the date is the run-day in the caller-supplied `tz`.
 *   The insert is a `createMany` with `skipDuplicates`
 *   (`INSERT ... ON CONFLICT DO NOTHING`) so a repeat — the cron and
 *   the event path overlapping, or two saves the same UTC day — is
 *   absorbed at the SQL layer with NO exception. A task matches at
 *   most one window per run, so over its life a task yields at most
 *   three notifications (7d → 1d → 0d).
 */
import type { PrismaClient } from '@prisma/client';
import { publishNotificationEvent } from '@/lib/notifications/notification-bus';

/** ms in a UTC day. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The three reminder touchpoints. */
export type TaskDueWindow = 'week' | 'day' | 'today';

interface WindowCopy {
    /** Integer calendar days (in the active tz) from now to `dueAt` that triggers it. */
    days: number;
    /** Bell title line. */
    title: string;
    /** Sentence fragment — "<task label> <phrase>." */
    phrase: string;
}

/**
 * Window definitions, ordered furthest-out → due-day. The `days`
 * value is the single source of truth for both classification and
 * the human copy.
 */
export const TASK_DUE_WINDOWS: Record<TaskDueWindow, WindowCopy> = {
    week: { days: 7, title: 'Task due in one week', phrase: 'is due in one week' },
    day: { days: 1, title: 'Task due tomorrow', phrase: 'is due tomorrow' },
    today: { days: 0, title: 'Task due today', phrase: 'is due today' },
};

/** UTC midnight of the given instant. */
export function startOfUtcDay(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The YYYY-MM-DD calendar date of `d` as seen in IANA zone `tz`. */
function dayKeyInTz(d: Date, tz: string): string {
    // en-CA renders YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
}

/**
 * Integer count of calendar days from `now` to `dueAt`, counted in
 * IANA zone `tz` (default `'UTC'`). 0 = due today, 1 = due tomorrow,
 * negative = overdue. Time-of-day is discarded on both sides — both
 * instants are reduced to their `tz`-local calendar date and the
 * difference is taken between those dates. Pure function.
 */
export function daysUntilDue(
    dueAt: Date,
    now: Date = new Date(),
    tz: string = 'UTC',
): number {
    // Both day-keys are parsed as UTC midnight; the difference is the
    // calendar-day count *in tz* (the wall-clock offset cancels out).
    return Math.round(
        (Date.parse(dayKeyInTz(dueAt, tz) + 'T00:00:00Z') -
            Date.parse(dayKeyInTz(now, tz) + 'T00:00:00Z')) / MS_PER_DAY,
    );
}

/**
 * Map a due date to its reminder window, or `null` when the date is
 * not on one of the three touchpoints. Calendar days are counted in
 * IANA zone `tz` (default `'UTC'`). Pure function.
 */
export function classifyDueWindow(
    dueAt: Date,
    now: Date = new Date(),
    tz: string = 'UTC',
): TaskDueWindow | null {
    const days = daysUntilDue(dueAt, now, tz);
    for (const key of Object.keys(TASK_DUE_WINDOWS) as TaskDueWindow[]) {
        if (TASK_DUE_WINDOWS[key].days === days) return key;
    }
    return null;
}

/** dedupeKey shape — see the module docstring's dedup contract. */
export function buildTaskDueDedupeKey(
    tenantId: string,
    window: TaskDueWindow,
    taskId: string,
    userId: string,
    now: Date,
    tz: string = 'UTC',
): string {
    return `${tenantId}:TASK_DUE:${window}:${taskId}:${userId}:${dayKeyInTz(now, tz)}`;
}

/** One task in the shape the per-task notification helper needs. */
export interface TaskDueTarget {
    id: string;
    tenantId: string;
    tenantSlug: string;
    title: string;
    key?: string | null;
    dueAt: Date;
    assigneeUserId: string;
}

export interface TaskDueNotificationOutcome {
    status: 'created' | 'duplicate' | 'out-of-window';
    /** The matched reminder window, or null when out of window. */
    window: TaskDueWindow | null;
}

/**
 * Create the in-app `TASK_DUE` notification for ONE task, if its
 * `dueAt` lands on a {7,1,0}-day reminder window. Idempotent — a
 * repeat `dedupeKey` is absorbed without an exception.
 *
 * The insert is a `createMany` with `skipDuplicates`, NOT a `create`.
 * `skipDuplicates` compiles to `INSERT ... ON CONFLICT DO NOTHING`:
 * a duplicate `dedupeKey` returns `count: 0` with NO exception —
 * `create` would throw P2002, and a thrown P2002 inside an
 * interactive transaction poisons the whole PostgreSQL transaction
 * (a caught JS error does not un-poison an aborted PG transaction).
 */
export async function createTaskDueNotification(
    db: Pick<PrismaClient, 'notification'>,
    task: TaskDueTarget,
    now: Date = new Date(),
    tz: string = 'UTC',
): Promise<TaskDueNotificationOutcome> {
    const window = classifyDueWindow(task.dueAt, now, tz);
    if (!window) return { status: 'out-of-window', window: null };

    const copy = TASK_DUE_WINDOWS[window];
    const label = task.key
        ? `${task.key} "${task.title}"`
        : `"${task.title}"`;

    const row = {
        tenantId: task.tenantId,
        userId: task.assigneeUserId,
        type: 'TASK_DUE' as const,
        title: copy.title,
        message: `${label} ${copy.phrase}.`,
        linkUrl: `/t/${task.tenantSlug}/farm-tasks/${task.id}`,
        dedupeKey: buildTaskDueDedupeKey(
            task.tenantId,
            window,
            task.id,
            task.assigneeUserId,
            now,
            tz,
        ),
    };

    const result = await db.notification.createMany({
        data: [row],
        skipDuplicates: true,
    });

    // 2026-05-27 (PR-C) — on a fresh insert, push the event to
    // every live SSE subscriber for this (tenant, user). The row
    // we wrote is a value-equal copy of the inputs we're holding
    // here — no re-read needed for the bell-bound payload shape.
    // `id` would normally come from Prisma's return, but
    // `createMany` doesn't return ids; we omit it from the event
    // and the client treats `id`-less events as "prepend then
    // refetch on next open" — graceful fallback.
    if (result.count > 0) {
        publishNotificationEvent(task.tenantId, task.assigneeUserId, {
            // No id — see comment above. The client uses createdAt
            // as the dedupe seed for prepend.
            id: row.dedupeKey,
            type: row.type,
            title: row.title,
            message: row.message,
            read: false,
            linkUrl: row.linkUrl,
            createdAt: now.toISOString(),
        });
    }

    // count 0 ⇒ the dedupeKey already existed ⇒ already notified.
    return { status: result.count > 0 ? 'created' : 'duplicate', window };
}
