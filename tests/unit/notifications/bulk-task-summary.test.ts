/**
 * The bulk task summary notification — #2103.
 *
 * `bulkAssignTasks` and `bulkSetTaskDueDate` were silent: a `TASK_ASSIGNED`
 * audit row per task and nothing on the bell, so being assigned twenty tasks
 * at once told the assignee nothing while being assigned one told them. The
 * owner's ruling was ONE summary per bulk action.
 *
 * Sibling of `assignment.test.ts`, and the same fake-`db` shape — this pins
 * the behavioural contract where `notif-task-due-emit-coverage` pins the
 * wiring.
 */
import {
    buildBulkDedupeKey,
    createBulkTaskSummaryNotification,
    type BulkTaskSummaryTarget,
} from '@/app-layer/notifications/bulk-task-summary';
import { __resetNotificationBusForTests } from '@/lib/notifications/notification-bus';

describe('buildBulkDedupeKey', () => {
    const at = new Date('2026-10-21T10:30:00Z');

    it('keys on the BATCH, not on any one task', () => {
        const key = buildBulkDedupeKey('t-1', 'assigned', ['a', 'b', 'c'], 'u-1', at);
        expect(key).toMatch(/^t-1:BULK_ASSIGNED:[0-9a-f]{16}:u-1:2026-10-21$/);
    });

    it('the same set in a different ORDER is the same batch', () => {
        // Sorted before hashing, because the id order a caller happens to send
        // is not part of what happened. Without this a retry that reordered
        // the array would notify twice.
        const a = buildBulkDedupeKey('t-1', 'assigned', ['a', 'b', 'c'], 'u-1', at);
        const b = buildBulkDedupeKey('t-1', 'assigned', ['c', 'a', 'b'], 'u-1', at);
        expect(a).toBe(b);
    });

    it('a DIFFERENT set on the same day is a different batch', () => {
        // The property the per-entity key could not express: two separate bulk
        // actions in one day are two events, not a duplicate.
        const a = buildBulkDedupeKey('t-1', 'assigned', ['a', 'b'], 'u-1', at);
        const b = buildBulkDedupeKey('t-1', 'assigned', ['a', 'b', 'c'], 'u-1', at);
        expect(a).not.toBe(b);
    });

    it('separates kind, recipient, tenant and day', () => {
        const base = buildBulkDedupeKey('t-1', 'assigned', ['a'], 'u-1', at);
        expect(buildBulkDedupeKey('t-1', 'rescheduled', ['a'], 'u-1', at)).not.toBe(base);
        expect(buildBulkDedupeKey('t-1', 'assigned', ['a'], 'u-2', at)).not.toBe(base);
        expect(buildBulkDedupeKey('t-2', 'assigned', ['a'], 'u-1', at)).not.toBe(base);
        expect(
            buildBulkDedupeKey('t-1', 'assigned', ['a'], 'u-1', new Date('2026-10-22T00:00:00Z')),
        ).not.toBe(base);
    });
});

describe('createBulkTaskSummaryNotification', () => {
    let createMany: jest.Mock;
    let findFirst: jest.Mock;
    // `db as never` at each call site, like `assignment.test.ts`: the
    // parameter is `Pick<PrismaClient, 'notification'>`, and `Pick` keeps the
    // WHOLE delegate — sixteen methods this test has no use for. A fake that
    // satisfied the type would be a fake nobody could read.
    let db: { notification: { createMany: jest.Mock; findFirst: jest.Mock } };

    const target = (over: Partial<BulkTaskSummaryTarget> = {}): BulkTaskSummaryTarget => ({
        tenantId: 't-1',
        tenantSlug: 'acme',
        recipientUserId: 'u-1',
        taskIds: ['a', 'b', 'c'],
        locale: 'bg',
        ...over,
    });

    beforeEach(() => {
        __resetNotificationBusForTests();
        createMany = jest.fn().mockResolvedValue({ count: 1 });
        findFirst = jest.fn().mockResolvedValue({ id: 'notif-1' });
        db = { notification: { createMany, findFirst } };
    });

    afterEach(() => __resetNotificationBusForTests());

    it('writes ONE row for a batch of many', async () => {
        const out = await createBulkTaskSummaryNotification(db as never, 'assigned', target());

        expect(out.status).toBe('created');
        expect(createMany).toHaveBeenCalledTimes(1);
        expect(createMany.mock.calls[0][0].data).toHaveLength(1);
    });

    it('says how many, in the recipient’s language', async () => {
        await createBulkTaskSummaryNotification(db as never, 'assigned', target());
        const row = createMany.mock.calls[0][0].data[0];

        // Bulgarian, because the product is — `assignment.ts` and `task-due.ts`
        // hold English literals and this follows `push-summary.ts` instead.
        expect(row.title).toBe('Възложени задачи');
        expect(row.message).toBe('Възложени Ви са 3 задачи.');
        expect(row.message).toContain('3');
    });

    it('uses the SINGULAR form at one, not an ICU plural', async () => {
        // `translateFor` interpolates `{name}` only — it does not evaluate
        // `{count, plural, …}`, so an ICU key reached from here would render
        // its raw syntax. Two keys is the workaround, and this is the case
        // that proves the right one is chosen.
        await createBulkTaskSummaryNotification(db as never, 'assigned', target({ taskIds: ['a'] }));
        const row = createMany.mock.calls[0][0].data[0];

        expect(row.message).toBe('Възложена Ви е 1 задача.');
        expect(row.message).not.toContain('plural');
        expect(row.message).not.toContain('{');
    });

    it('falls back to English for an English recipient', async () => {
        await createBulkTaskSummaryNotification(db as never, 'rescheduled', target({ locale: 'en' }));
        const row = createMany.mock.calls[0][0].data[0];

        expect(row.title).toBe('Due dates changed');
        expect(row.message).toBe('The due dates of 3 of your tasks changed.');
    });

    it('never renders a raw key — both kinds, both plural forms', async () => {
        // A missing message key makes `translateFor` return the KEY, which
        // would ship `notifications.bulkTask.assigned.bodyMany` as the push
        // body. Cheap to assert and the failure is otherwise silent.
        for (const kind of ['assigned', 'rescheduled'] as const) {
            for (const ids of [['a'], ['a', 'b']]) {
                createMany.mockClear();
                await createBulkTaskSummaryNotification(db as never, kind, target({ taskIds: ids }));
                const row = createMany.mock.calls[0][0].data[0];
                expect(row.title).not.toContain('notifications.');
                expect(row.message).not.toContain('notifications.');
            }
        }
    });

    it('links an assignment to the task list filtered to the recipient', async () => {
        await createBulkTaskSummaryNotification(db as never, 'assigned', target());
        const row = createMany.mock.calls[0][0].data[0];

        // `assigneeUserId` is the filter key `farm-tasks` registers, and
        // `parseUrlToFilterState` hydrates the filter state from
        // `window.location.search` on mount — so this lands on the list
        // already narrowed. Root-relative, like every other notification link.
        expect(row.linkUrl).toBe('/t/acme/farm-tasks?assigneeUserId=u-1');
    });

    it('links a reschedule to the plain list', async () => {
        // A reschedule does not change WHOSE the tasks are, so filtering by
        // assignee would say something the action did not do.
        await createBulkTaskSummaryNotification(db as never, 'rescheduled', target());
        expect(createMany.mock.calls[0][0].data[0].linkUrl).toBe('/t/acme/farm-tasks');
    });

    it('uses skipDuplicates, never a bare create', async () => {
        // A duplicate dedupeKey on `create` raises P2002, which poisons an
        // interactive Postgres transaction for every statement after it.
        await createBulkTaskSummaryNotification(db as never, 'assigned', target());
        expect(createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    });

    it('reports "duplicate" when the batch already notified, and writes no push payload', async () => {
        createMany.mockResolvedValueOnce({ count: 0 });
        const out = await createBulkTaskSummaryNotification(db as never, 'assigned', target());

        expect(out.status).toBe('duplicate');
        expect(out.notification).toBeUndefined();
        // No id lookup either — nothing was written to look up.
        expect(findFirst).not.toHaveBeenCalled();
    });

    it('reports "empty" for an update that matched nothing, and writes NO row', async () => {
        // Distinct from `duplicate`: "the update matched no rows" is a
        // different fact from "we already told them", and a summary saying
        // "0 tasks" would be a notification about nothing.
        const out = await createBulkTaskSummaryNotification(db as never, 'assigned', target({ taskIds: [] }));

        expect(out.status).toBe('empty');
        expect(createMany).not.toHaveBeenCalled();
    });

    it('publishes the ROW id to the bus, not the dedupeKey', async () => {
        // `createAssignmentNotification` publishes `{ id: row.dedupeKey }`
        // because `createMany` returns no ids — and `serialiseFrame` puts a
        // notification frame's id on the SSE `id:` line, so it becomes the
        // client's `Last-Event-ID`. `replayNotificationIdsAfter` looks that up
        // as a `Notification.id`, finds nothing, and replays nothing. Reading
        // the row back is what makes this frame's cursor resolvable.
        const seen: string[] = [];
        const { subscribeToNotifications } = await import('@/lib/notifications/notification-bus');
        const release = subscribeToNotifications({
            tenantId: 't-1',
            userId: 'u-1',
            send: (e) => seen.push(e.id),
        });

        await createBulkTaskSummaryNotification(db as never, 'assigned', target());
        // `afterCommit` with no transaction frame open fires immediately via
        // `void runEffect(...)` — which is NOT awaited, so the publish lands on
        // a microtask after this call returns. Asserting without the tick reads
        // an empty array, which is how this case first failed.
        await new Promise((r) => setImmediate(r));
        release();

        expect(seen).toEqual(['notif-1']);
        expect(seen[0]).not.toContain('BULK_ASSIGNED');
    });

    it('still reports created when the row vanishes before the id read', async () => {
        // Possible only if something deleted it between the two statements.
        // Reported as created WITHOUT a payload rather than inventing an id
        // for the frame — the caller then enqueues no push, which is better
        // than pushing a link to a row that is gone.
        findFirst.mockResolvedValueOnce(null);
        const out = await createBulkTaskSummaryNotification(db as never, 'assigned', target());

        expect(out.status).toBe('created');
        expect(out.notification).toBeUndefined();
    });
});
