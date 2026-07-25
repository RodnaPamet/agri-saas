/**
 * Unit tests for the `task-due-notification` job.
 *
 * Covers the pure window-classification math, the scan/notify flow,
 * the three reminder windows (one week / one day / due day), tenant
 * scoping, and the dedupeKey idempotency contract.
 *
 * Prisma is mocked — this is a behavioural unit test, not an
 * integration test. The job's only collaborators are `db.task` and
 * `db.notification`. The notification write is a `createMany` with
 * `skipDuplicates` (`INSERT ... ON CONFLICT DO NOTHING`): a duplicate
 * `dedupeKey` returns `count: 0` instead of throwing P2002.
 */

import type { PrismaClient } from '@prisma/client';

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        fatal: jest.fn(),
        child: jest.fn().mockReturnThis(),
    },
}));

import {
    daysUntilDue,
    classifyDueWindow,
    buildTaskDueDedupeKey,
    processTaskDueNotifications,
    createTaskDueNotification,
    TASK_DUE_WINDOWS,
} from '../../src/app-layer/jobs/task-due-notification';

// ── Fixtures ────────────────────────────────────────────────────────

/** Anchor instant — 08:00 UTC, the cron firing time. */
const NOW = new Date('2026-05-20T08:00:00.000Z');

const DUE_TODAY = new Date('2026-05-20T14:30:00.000Z');
const DUE_TOMORROW = new Date('2026-05-21T03:00:00.000Z');
const DUE_IN_7_DAYS = new Date('2026-05-27T22:00:00.000Z');
const DUE_IN_3_DAYS = new Date('2026-05-23T10:00:00.000Z');

interface TaskRow {
    id: string;
    tenantId: string;
    title: string;
    key: string | null;
    dueAt: Date | null;
    assigneeUserId: string | null;
    tenant: { slug: string };
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
    return {
        id: 'task-1',
        tenantId: 'tenant-a',
        title: 'Rotate API keys',
        key: 'TSK-1',
        dueAt: DUE_TODAY,
        assigneeUserId: 'user-1',
        tenant: { slug: 'acme' },
        ...overrides,
    };
}

function makeDb(tasks: TaskRow[]) {
    const findMany = jest.fn().mockResolvedValue(tasks);
    // `createMany` + `skipDuplicates` → `{ count: 1 }` on insert,
    // `{ count: 0 }` when the dedupeKey already existed.
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const db = {
        task: { findMany },
        notification: { createMany },
    } as unknown as PrismaClient;
    return { db, findMany, createMany };
}

/** Last row payload passed to `notification.createMany`. */
function lastCreateData(createMany: jest.Mock): Record<string, unknown> {
    const call = createMany.mock.calls[createMany.mock.calls.length - 1][0];
    return call.data[0];
}

// ════════════════════════════════════════════════════════════════════
// 1. daysUntilDue — calendar-day math
// ════════════════════════════════════════════════════════════════════

describe('daysUntilDue', () => {
    test('due later the same UTC day → 0', () => {
        expect(daysUntilDue(DUE_TODAY, NOW)).toBe(0);
    });

    test('due the next UTC day → 1', () => {
        expect(daysUntilDue(DUE_TOMORROW, NOW)).toBe(1);
    });

    test('due seven UTC days out → 7', () => {
        expect(daysUntilDue(DUE_IN_7_DAYS, NOW)).toBe(7);
    });

    test('overdue by one day → -1', () => {
        expect(daysUntilDue(new Date('2026-05-19T23:00:00.000Z'), NOW)).toBe(-1);
    });

    test('time-of-day is discarded — 2h apart but across midnight → 1', () => {
        const lateNow = new Date('2026-05-20T23:00:00.000Z');
        const earlyNextDay = new Date('2026-05-21T01:00:00.000Z');
        expect(daysUntilDue(earlyNextDay, lateNow)).toBe(1);
    });
});

// ════════════════════════════════════════════════════════════════════
// 2. classifyDueWindow — only {0,1,7} map to a window
// ════════════════════════════════════════════════════════════════════

describe('classifyDueWindow', () => {
    test('due today → "today"', () => {
        expect(classifyDueWindow(DUE_TODAY, NOW)).toBe('today');
    });

    test('due tomorrow → "day"', () => {
        expect(classifyDueWindow(DUE_TOMORROW, NOW)).toBe('day');
    });

    test('due in seven days → "week"', () => {
        expect(classifyDueWindow(DUE_IN_7_DAYS, NOW)).toBe('week');
    });

    test.each([2, 3, 4, 5, 6])('due in %i days → null (no touchpoint)', (offset) => {
        const dueAt = new Date(NOW.getTime() + offset * 24 * 60 * 60 * 1000);
        expect(classifyDueWindow(dueAt, NOW)).toBeNull();
    });

    test('overdue → null', () => {
        expect(classifyDueWindow(new Date('2026-05-19T10:00:00.000Z'), NOW)).toBeNull();
    });

    test('beyond the week window → null', () => {
        expect(classifyDueWindow(new Date('2026-05-28T10:00:00.000Z'), NOW)).toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════════
// 2b. Timezone parameter — calendar-day bucketing in a local zone
// ════════════════════════════════════════════════════════════════════

describe('timezone-aware classification', () => {
    // 2026-05-20 23:30 UTC = 2026-05-21 00:30 BST (London is UTC+1 in
    // May — DST). 2026-05-21 07:00 UTC = 2026-05-21 08:00 BST.
    const dueNearLondonMidnight = new Date('2026-05-20T23:30:00.000Z');
    const londonCronFire = new Date('2026-05-21T07:00:00.000Z');

    test('daysUntilDue: same London calendar day → 0 under Europe/London', () => {
        expect(
            daysUntilDue(dueNearLondonMidnight, londonCronFire, 'Europe/London'),
        ).toBe(0);
    });

    test('daysUntilDue: the same instants are a different day under UTC', () => {
        // Under UTC the due date is May 20, "now" is May 21 → 1 day.
        expect(daysUntilDue(dueNearLondonMidnight, londonCronFire, 'UTC')).toBe(-1);
    });

    test('classifyDueWindow: "today" under Europe/London, not under UTC', () => {
        expect(
            classifyDueWindow(dueNearLondonMidnight, londonCronFire, 'Europe/London'),
        ).toBe('today');
        // Under UTC the same inputs are overdue by a day → no window.
        expect(classifyDueWindow(dueNearLondonMidnight, londonCronFire, 'UTC')).toBeNull();
    });

    test('omitting tz keeps the historical UTC behaviour', () => {
        // Default arg is 'UTC' — the existing fixtures must be unchanged.
        expect(daysUntilDue(DUE_TODAY, NOW)).toBe(0);
        expect(classifyDueWindow(DUE_TOMORROW, NOW)).toBe('day');
    });

    test('buildTaskDueDedupeKey: the date segment is the tz-local day', () => {
        // `londonCronFire` is 2026-05-21 08:00 BST but 2026-05-21 07:00
        // UTC — both render as 2026-05-21, so use an instant where the
        // UTC and London calendar dates genuinely diverge.
        const lateUtcEarlyLondon = new Date('2026-05-20T23:30:00.000Z');
        const utcKey = buildTaskDueDedupeKey(
            'tenant-a', 'today', 'task-9', 'user-3', lateUtcEarlyLondon, 'UTC',
        );
        const londonKey = buildTaskDueDedupeKey(
            'tenant-a', 'today', 'task-9', 'user-3', lateUtcEarlyLondon, 'Europe/London',
        );
        expect(utcKey).toBe('tenant-a:TASK_DUE:today:task-9:user-3:2026-05-20');
        expect(londonKey).toBe('tenant-a:TASK_DUE:today:task-9:user-3:2026-05-21');
    });

    test('createTaskDueNotification: tz arg drives the window + dedupeKey', async () => {
        const { db, createMany } = makeDb([]);
        const outcome = await createTaskDueNotification(
            db,
            {
                id: 'task-x',
                tenantId: 'tenant-a',
                tenantSlug: 'acme',
                title: 'Ship it',
                key: 'TSK-9',
                dueAt: dueNearLondonMidnight,
                assigneeUserId: 'user-1',
            },
            londonCronFire,
            'Europe/London',
        );
        expect(outcome).toEqual({ status: 'created', window: 'today' });
        expect(lastCreateData(createMany)).toMatchObject({
            title: 'Task due today',
            dedupeKey: 'tenant-a:TASK_DUE:today:task-x:user-1:2026-05-21',
        });
    });
});

// ════════════════════════════════════════════════════════════════════
// 3. buildTaskDueDedupeKey — shape contract
// ════════════════════════════════════════════════════════════════════

describe('buildTaskDueDedupeKey', () => {
    test('encodes tenant, type, window, task, user and UTC run-day', () => {
        const key = buildTaskDueDedupeKey('tenant-a', 'today', 'task-9', 'user-3', NOW);
        expect(key).toBe('tenant-a:TASK_DUE:today:task-9:user-3:2026-05-20');
    });

    test('the same task on a different window yields a distinct key', () => {
        const week = buildTaskDueDedupeKey('tenant-a', 'week', 'task-9', 'user-3', NOW);
        const day = buildTaskDueDedupeKey('tenant-a', 'day', 'task-9', 'user-3', NOW);
        expect(week).not.toBe(day);
    });
});

// ════════════════════════════════════════════════════════════════════
// 4. processTaskDueNotifications — scan + notify
// ════════════════════════════════════════════════════════════════════

describe('processTaskDueNotifications — notification creation', () => {
    test('creates a TASK_DUE notification for a task due today', async () => {
        const { db, createMany } = makeDb([makeTask()]);

        const result = await processTaskDueNotifications(db, {
            tenantId: 'tenant-a',
            now: NOW,
        });

        expect(createMany).toHaveBeenCalledTimes(1);
        expect(lastCreateData(createMany)).toMatchObject({
            tenantId: 'tenant-a',
            userId: 'user-1',
            type: 'TASK_DUE',
            title: 'Task due today',
            message: 'TSK-1 "Rotate API keys" is due today.',
            linkUrl: '/t/acme/farm-tasks/task-1',
            dedupeKey: 'tenant-a:TASK_DUE:today:task-1:user-1:2026-05-20',
        });
        expect(result).toEqual({
            scanned: 1,
            created: 1,
            skippedDuplicate: 0,
            byWindow: { week: 0, day: 0, today: 1 },
        });
    });

    test('the insert opts into skipDuplicates (ON CONFLICT DO NOTHING)', async () => {
        const { db, createMany } = makeDb([makeTask()]);

        await processTaskDueNotifications(db, { now: NOW });

        expect(createMany.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
    });

    test('fires distinct copy for each of the three windows', async () => {
        const { db, createMany } = makeDb([
            makeTask({ id: 't-today', dueAt: DUE_TODAY }),
            makeTask({ id: 't-tomorrow', dueAt: DUE_TOMORROW }),
            makeTask({ id: 't-week', dueAt: DUE_IN_7_DAYS }),
        ]);

        const result = await processTaskDueNotifications(db, { now: NOW });

        expect(createMany).toHaveBeenCalledTimes(3);
        const byTitle = createMany.mock.calls.map((c) => c[0].data[0].title).sort();
        expect(byTitle).toEqual([
            'Task due in one week',
            'Task due today',
            'Task due tomorrow',
        ]);
        expect(result.byWindow).toEqual({ week: 1, day: 1, today: 1 });
        expect(result.created).toBe(3);
    });

    test('window copy matches the TASK_DUE_WINDOWS table', async () => {
        const { db, createMany } = makeDb([
            makeTask({ id: 't-tomorrow', key: null, dueAt: DUE_TOMORROW }),
        ]);

        await processTaskDueNotifications(db, { now: NOW });

        const data = lastCreateData(createMany);
        expect(data.title).toBe(TASK_DUE_WINDOWS.day.title);
        expect(data.message).toBe('"Rotate API keys" is due tomorrow.');
    });

    test('ignores tasks not on a {7,1,0}-day touchpoint', async () => {
        const { db, createMany } = makeDb([
            makeTask({ id: 't-3days', dueAt: DUE_IN_3_DAYS }),
        ]);

        const result = await processTaskDueNotifications(db, { now: NOW });

        expect(createMany).not.toHaveBeenCalled();
        expect(result).toEqual({
            scanned: 1,
            created: 0,
            skippedDuplicate: 0,
            byWindow: { week: 0, day: 0, today: 0 },
        });
    });

    test('a task with no key omits the key prefix from the message', async () => {
        const { db, createMany } = makeDb([makeTask({ key: null })]);

        await processTaskDueNotifications(db, { now: NOW });

        expect(lastCreateData(createMany).message).toBe('"Rotate API keys" is due today.');
    });

    test('linkUrl is built from the task tenant slug', async () => {
        const { db, createMany } = makeDb([
            makeTask({ id: 'abc', tenant: { slug: 'globex' } }),
        ]);

        await processTaskDueNotifications(db, { now: NOW });

        expect(lastCreateData(createMany).linkUrl).toBe('/t/globex/farm-tasks/abc');
    });

    test('no matching tasks → no writes, zeroed result', async () => {
        const { db, createMany } = makeDb([]);

        const result = await processTaskDueNotifications(db, { now: NOW });

        expect(createMany).not.toHaveBeenCalled();
        expect(result).toEqual({
            scanned: 0,
            created: 0,
            skippedDuplicate: 0,
            byWindow: { week: 0, day: 0, today: 0 },
        });
    });
});

// ════════════════════════════════════════════════════════════════════
// 5. Query filters — status / soft-delete / assignee / horizon
// ════════════════════════════════════════════════════════════════════

describe('processTaskDueNotifications — query filters', () => {
    test('excludes terminal statuses, soft-deleted, and unassigned tasks', async () => {
        const { db, findMany } = makeDb([]);

        await processTaskDueNotifications(db, { now: NOW });

        const where = findMany.mock.calls[0][0].where;
        expect(where.deletedAt).toBeNull();
        expect(where.assigneeUserId).toEqual({ not: null });
        expect(where.status.notIn).toEqual(
            expect.arrayContaining(['RESOLVED', 'CLOSED', 'CANCELED']),
        );
    });

    test('scans a deliberately wide -1d → +9d horizon around UTC midnight', async () => {
        // The horizon carries ±1-day slop beyond the {0..7} windows so
        // a task due near local midnight is never missed at a tz/UTC
        // day boundary — `classifyDueWindow` does the precise tz-aware
        // filter to exactly {7,1,0}.
        const { db, findMany } = makeDb([]);

        await processTaskDueNotifications(db, { now: NOW });

        const where = findMany.mock.calls[0][0].where;
        expect(where.dueAt.gte.toISOString()).toBe('2026-05-19T00:00:00.000Z');
        expect(where.dueAt.lt.toISOString()).toBe('2026-05-29T00:00:00.000Z');
    });
});

// ════════════════════════════════════════════════════════════════════
// 6. Tenant scoping
// ════════════════════════════════════════════════════════════════════

describe('processTaskDueNotifications — tenant scoping', () => {
    test('tenant-scoped run filters the query by tenantId', async () => {
        const { db, findMany } = makeDb([]);

        await processTaskDueNotifications(db, { tenantId: 'tenant-a', now: NOW });

        expect(findMany.mock.calls[0][0].where).toHaveProperty('tenantId', 'tenant-a');
    });

    test('system-wide run does not filter the query by tenantId', async () => {
        const { db, findMany } = makeDb([]);

        await processTaskDueNotifications(db, { now: NOW });

        expect(findMany.mock.calls[0][0].where).not.toHaveProperty('tenantId');
    });

    test('the notification inherits the task tenantId, not the option', async () => {
        // A system-wide scan returns rows from many tenants; each
        // notification must be written to the row's own tenant.
        const { db, createMany } = makeDb([
            makeTask({ id: 't-b', tenantId: 'tenant-b', tenant: { slug: 'beta' } }),
        ]);

        await processTaskDueNotifications(db, { now: NOW });

        expect(lastCreateData(createMany).tenantId).toBe('tenant-b');
    });
});

// ════════════════════════════════════════════════════════════════════
// 7. Deduplication — idempotency contract
// ════════════════════════════════════════════════════════════════════

describe('processTaskDueNotifications — deduplication', () => {
    test('a dedupeKey collision (count 0) is counted as skipped, not thrown', async () => {
        const { db, createMany } = makeDb([makeTask()]);
        // ON CONFLICT DO NOTHING absorbed the row → nothing inserted.
        createMany.mockResolvedValueOnce({ count: 0 });

        const result = await processTaskDueNotifications(db, { now: NOW });

        expect(result.created).toBe(0);
        expect(result.skippedDuplicate).toBe(1);
    });

    test('a partial collision skips the duplicate and still writes the rest', async () => {
        const { db, createMany } = makeDb([
            makeTask({ id: 't-1' }),
            makeTask({ id: 't-2' }),
        ]);
        createMany.mockResolvedValueOnce({ count: 0 });

        const result = await processTaskDueNotifications(db, { now: NOW });

        expect(result).toMatchObject({ created: 1, skippedDuplicate: 1, scanned: 2 });
    });

    test('a database error propagates', async () => {
        const { db, createMany } = makeDb([makeTask()]);
        createMany.mockRejectedValueOnce(new Error('connection reset'));

        await expect(
            processTaskDueNotifications(db, { now: NOW }),
        ).rejects.toThrow('connection reset');
    });
});

// ════════════════════════════════════════════════════════════════════
// 8. createTaskDueNotification — the shared per-task helper
//    (the event-driven seam the task usecases call directly)
// ════════════════════════════════════════════════════════════════════

describe('createTaskDueNotification — per-task helper', () => {
    const target = {
        id: 'task-x',
        tenantId: 'tenant-a',
        tenantSlug: 'acme',
        title: 'Ship it',
        key: 'TSK-9',
        dueAt: DUE_TOMORROW,
        assigneeUserId: 'user-1',
    };

    it('creates a TASK_DUE notification for an in-window task', async () => {
        const { db, createMany } = makeDb([]);

        const outcome = await createTaskDueNotification(db, target, NOW);

        expect(outcome).toEqual({ status: 'created', window: 'day' });
        expect(createMany).toHaveBeenCalledTimes(1);
        expect(createMany.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
        expect(lastCreateData(createMany)).toMatchObject({
            tenantId: 'tenant-a',
            userId: 'user-1',
            type: 'TASK_DUE',
            title: 'Task due tomorrow',
            message: 'TSK-9 "Ship it" is due tomorrow.',
            linkUrl: '/t/acme/farm-tasks/task-x',
            dedupeKey: 'tenant-a:TASK_DUE:day:task-x:user-1:2026-05-20',
        });
    });

    it('does nothing for a task outside the {7,1,0}-day windows', async () => {
        const { db, createMany } = makeDb([]);

        const outcome = await createTaskDueNotification(
            db,
            { ...target, dueAt: DUE_IN_3_DAYS },
            NOW,
        );

        expect(outcome).toEqual({ status: 'out-of-window', window: null });
        expect(createMany).not.toHaveBeenCalled();
    });

    it('reports a dedupeKey collision (count 0) as duplicate — not an error', async () => {
        const { db, createMany } = makeDb([]);
        createMany.mockResolvedValueOnce({ count: 0 });

        const outcome = await createTaskDueNotification(db, target, NOW);

        expect(outcome).toEqual({ status: 'duplicate', window: 'day' });
    });

    it('a database error propagates', async () => {
        const { db, createMany } = makeDb([]);
        createMany.mockRejectedValueOnce(new Error('connection reset'));

        await expect(
            createTaskDueNotification(db, target, NOW),
        ).rejects.toThrow('connection reset');
    });
});
