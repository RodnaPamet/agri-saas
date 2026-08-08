/**
 * Coverage wave 21 — `WorkItemRepository` and its three satellites.
 *
 * The densest untested file left in `src/app-layer/repositories`: 24
 * uncovered functions and 75 uncovered branches on the main artifact.
 * It is also the busiest repository in the product — Tasks, Issues and
 * Field Operations are all the same `Task` row, so every one of those
 * three surfaces reads and writes through this single class.
 *
 * Repositories are the layer CLAUDE.md gives one non-negotiable rule:
 * **every query filters by `tenantId`**. RLS is the real enforcement;
 * the application filter is the defence-in-depth half — and it is the
 * half a refactor can drop silently, because dropping it produces no
 * error at all while RLS is working.
 *
 * These tests assert the QUERY the repository emits, not Prisma's
 * behaviour — the boundary contract this code owns. `db` is a
 * recording double; the pagination helpers (`clampLimit`,
 * `buildCursorWhere`, `computePageInfo`) and the status domain
 * (`isTerminalStatus`) run for real, because their interaction with
 * the repository is part of what is under test.
 *
 * Time is frozen so the three date-derived filters (`overdue`,
 * `next7d`, the metrics windows) can be asserted exactly rather than
 * with a tolerance — a `7 * 60 * 60 * 1000` typo in place of
 * `7 * 24 * 60 * 60 * 1000` is precisely the kind of break a
 * tolerance-based assertion waves through.
 */
import {
    WorkItemRepository,
    TaskLinkRepository,
    TaskCommentRepository,
    TaskWatcherRepository,
} from '@/app-layer/repositories/WorkItemRepository';
import { makeRequestContext } from '../../helpers/make-context';
import { encodeCursor, MAX_LIMIT, DEFAULT_LIMIT } from '@/lib/pagination';
import { Prisma } from '@prisma/client';
import type { PrismaTx } from '@/lib/db-context';

const ctx = makeRequestContext('ADMIN'); // tenantId: 'tenant-1', userId: 'user-1'
const OTHER_TENANT = makeRequestContext('ADMIN', { tenantId: 'tenant-2' });

const NOW = new Date('2026-03-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function makeDb() {
    return {
        task: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
            count: jest.fn().mockResolvedValue(0),
            create: jest.fn().mockResolvedValue({ id: 'created' }),
            update: jest.fn().mockResolvedValue({ id: 'updated' }),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            groupBy: jest.fn().mockResolvedValue([]),
        },
        taskKeySequence: {
            upsert: jest.fn().mockResolvedValue({ lastValue: 7 }),
        },
        taskLink: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'link-created' }),
            delete: jest.fn().mockResolvedValue({ id: 'link-deleted' }),
            groupBy: jest.fn().mockResolvedValue([]),
        },
        taskComment: {
            findMany: jest.fn().mockResolvedValue([]),
            create: jest.fn().mockResolvedValue({ id: 'comment-created' }),
        },
        taskWatcher: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'watcher-created' }),
            delete: jest.fn().mockResolvedValue({ id: 'watcher-deleted' }),
        },
        control: {
            findMany: jest.fn().mockResolvedValue([]),
        },
    };
}

type FakeDb = ReturnType<typeof makeDb>;
const asTx = (db: FakeDb) => db as unknown as PrismaTx;

type Args = Record<string, unknown>;
/** The whole argument object of the nth (default first) call. */
const argOf = (fn: jest.Mock, call = 0): Args => fn.mock.calls[call][0] as Args;
/** The `where` of the nth (default first) call. */
const whereOf = (fn: jest.Mock, call = 0): Args => argOf(fn, call).where as Args;
/** The `data` of the nth (default first) call. */
const dataOf = (fn: jest.Mock, call = 0): Args => argOf(fn, call).data as Args;

let db: FakeDb;
beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    db = makeDb();
});
afterEach(() => {
    jest.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────
// Tenant isolation — the invariant the whole layer exists to hold.
// ─────────────────────────────────────────────────────────────────────

describe('WorkItemRepository — tenant isolation', () => {
    it('scopes the list query to the calling tenant', async () => {
        // Break: dropping `tenantId` from `_buildWhere` returns every
        // tenant's tasks to whoever asks.
        await WorkItemRepository.list(asTx(db), ctx);

        expect(whereOf(db.task.findMany)).toMatchObject({ tenantId: 'tenant-1' });
    });

    it('scopes the list query to the OTHER tenant when that is the caller', async () => {
        // Break: hard-coding or caching a tenantId. Naming one tenant in
        // a single test cannot catch that; two can.
        await WorkItemRepository.list(asTx(db), OTHER_TENANT);

        expect(whereOf(db.task.findMany)).toMatchObject({ tenantId: 'tenant-2' });
    });

    it('requires both id and tenant to read a task by id', async () => {
        // Break: looking up by id alone makes every task readable
        // cross-tenant by guessing or leaking an id.
        await WorkItemRepository.getById(asTx(db), ctx, 't-1');

        expect(argOf(db.task.findFirst)).toMatchObject({
            where: { id: 't-1', tenantId: 'tenant-1' },
        });
    });

    it('refuses to update a task belonging to another tenant', async () => {
        // Break: dropping the tenant-scoped existence check. The final
        // `db.task.update` is keyed by id ALONE — the pre-read IS the
        // tenant guard, so without it a foreign id is writable.
        db.task.findFirst.mockResolvedValue(null);

        const result = await WorkItemRepository.update(asTx(db), ctx, 't-foreign', { title: 'hijacked' });

        expect(result).toBeNull();
        expect(db.task.update).not.toHaveBeenCalled();
        // Assert the LOOKUP is tenant-scoped, not merely that a missing
        // row is refused: with findFirst stubbed to null the refusal
        // holds for any where-clause, so it alone would not notice the
        // tenant filter being dropped.
        expect(db.task.findFirst).toHaveBeenCalledWith({
            where: { id: 't-foreign', tenantId: 'tenant-1' },
        });
    });

    it('refuses to change the status of a task belonging to another tenant', async () => {
        // Break: same missing guard on the status path — an unscoped
        // status write can close another tenant's work.
        db.task.findFirst.mockResolvedValue(null);

        const result = await WorkItemRepository.setStatus(asTx(db), ctx, 't-foreign', 'CLOSED');

        expect(result).toBeNull();
        expect(db.task.update).not.toHaveBeenCalled();
        expect(db.task.findFirst).toHaveBeenCalledWith({
            where: { id: 't-foreign', tenantId: 'tenant-1' },
        });
    });

    it('refuses to assign a task belonging to another tenant', async () => {
        // Break: same missing guard on the assign path.
        db.task.findFirst.mockResolvedValue(null);

        const result = await WorkItemRepository.assign(asTx(db), ctx, 't-foreign', 'user-9');

        expect(result).toBeNull();
        expect(db.task.update).not.toHaveBeenCalled();
        expect(db.task.findFirst).toHaveBeenCalledWith({
            where: { id: 't-foreign', tenantId: 'tenant-1' },
        });
    });

    it('does assign a task inside the tenant', async () => {
        // Paired with the refusal above on purpose: a refusal assertion
        // alone still passes if the method never does anything at all.
        db.task.findFirst.mockResolvedValue({ id: 't-1' });

        await WorkItemRepository.assign(asTx(db), ctx, 't-1', 'user-9');

        expect(argOf(db.task.update)).toMatchObject({
            where: { id: 't-1' },
            data: { assigneeUserId: 'user-9' },
        });
    });

    it('scopes every bulk write to the tenant', async () => {
        // Break: a bulk `updateMany` keyed on `id: { in: [...] }` alone
        // is the worst shape in the file — one request mutates an
        // arbitrary set of foreign rows, with no per-row guard above it.
        await WorkItemRepository.bulkAssign(asTx(db), ctx, ['a', 'b'], 'user-9');
        await WorkItemRepository.bulkSetStatus(asTx(db), ctx, ['a', 'b'], 'CLOSED');
        await WorkItemRepository.bulkSetDueDate(asTx(db), ctx, ['a', 'b'], null);

        for (const call of [0, 1, 2]) {
            expect(whereOf(db.task.updateMany, call)).toMatchObject({
                id: { in: ['a', 'b'] },
                tenantId: 'tenant-1',
            });
        }
    });

    it('scopes the link, comment and watcher listings to the tenant as well as the task', async () => {
        // Break: filtering by taskId alone. Task ids are opaque but not
        // secret; the tenant filter is what actually isolates.
        await TaskLinkRepository.listByTask(asTx(db), ctx, 't-1');
        await TaskCommentRepository.listByTask(asTx(db), ctx, 't-1');
        await TaskWatcherRepository.listByTask(asTx(db), ctx, 't-1');

        expect(whereOf(db.taskLink.findMany)).toEqual({ taskId: 't-1', tenantId: 'tenant-1' });
        expect(whereOf(db.taskComment.findMany)).toEqual({ taskId: 't-1', tenantId: 'tenant-1' });
        expect(whereOf(db.taskWatcher.findMany)).toEqual({ taskId: 't-1', tenantId: 'tenant-1' });
    });
});

// ─────────────────────────────────────────────────────────────────────
// Filter translation — `_buildWhere`, reached through `list`.
// ─────────────────────────────────────────────────────────────────────

describe('WorkItemRepository — filter translation', () => {
    it('emits nothing but the tenant filter when no filters are supplied', async () => {
        // Break: a stray default filter would silently hide rows.
        await WorkItemRepository.list(asTx(db), ctx);

        expect(whereOf(db.task.findMany)).toEqual({ tenantId: 'tenant-1' });
    });

    it('maps the six scalar filters straight onto the where clause', async () => {
        // Break: a copy-paste slip mapping `severity` onto `priority`
        // (or similar) makes a filter chip select the wrong rows —
        // wrong, but plausible-looking, results.
        await WorkItemRepository.list(asTx(db), ctx, {
            status: 'OPEN',
            type: 'FARM_TASK',
            severity: 'HIGH',
            priority: 'P1',
            assigneeUserId: 'user-3',
            controlId: 'c-1',
        });

        expect(whereOf(db.task.findMany)).toEqual({
            tenantId: 'tenant-1',
            status: 'OPEN',
            type: 'FARM_TASK',
            severity: 'HIGH',
            priority: 'P1',
            assigneeUserId: 'user-3',
            controlId: 'c-1',
        });
    });

    it('treats "overdue" as past-due AND not terminal', async () => {
        // Break: dropping the status guard. Every RESOLVED/CLOSED/
        // CANCELED task with a past due date becomes permanently
        // "overdue" — the overdue count then only ever grows.
        await WorkItemRepository.list(asTx(db), ctx, { due: 'overdue' });

        expect(whereOf(db.task.findMany)).toEqual({
            tenantId: 'tenant-1',
            dueAt: { lt: NOW },
            status: { notIn: ['RESOLVED', 'CLOSED', 'CANCELED'] },
        });
    });

    it('lets an explicit status filter win over the implicit not-terminal guard', async () => {
        // Break: writing the not-terminal guard unconditionally would
        // clobber the caller's own status filter, so "closed AND
        // overdue" — the query an auditor runs to find late work —
        // would silently return nothing.
        await WorkItemRepository.list(asTx(db), ctx, { due: 'overdue', status: 'CLOSED' });

        expect(whereOf(db.task.findMany)).toMatchObject({
            status: 'CLOSED',
            dueAt: { lt: NOW },
        });
    });

    it('builds "next7d" as a seven-day window forward from now', async () => {
        // Break: a wrong multiplier (7 hours, 7 minutes) or an
        // inverted bound. The window width is asserted exactly, so a
        // `7 * 60 * 60 * 1000` typo fails here rather than shipping a
        // near-empty "due soon" list.
        await WorkItemRepository.list(asTx(db), ctx, { due: 'next7d' });

        const where = whereOf(db.task.findMany);
        expect(where.dueAt).toEqual({ gte: NOW, lte: new Date(NOW.getTime() + 7 * DAY) });
        expect(where.status).toEqual({ notIn: ['RESOLVED', 'CLOSED', 'CANCELED'] });
    });

    it('lets an explicit status filter win on the next7d window too', async () => {
        // Break: the guard is written on both date branches, so it can
        // be fixed on one and left broken on the other. Asserting it
        // only for `overdue` would let "closed AND due this week" —
        // the query for work that was closed early — return nothing.
        await WorkItemRepository.list(asTx(db), ctx, { due: 'next7d', status: 'RESOLVED' });

        expect(whereOf(db.task.findMany).status).toBe('RESOLVED');
    });

    it('searches title AND key, case-insensitively', async () => {
        // Break: dropping `mode: 'insensitive'` makes a lowercase
        // "tsk-12" miss the row whose key is "TSK-12"; dropping the
        // `key` arm breaks paste-the-key lookup entirely.
        await WorkItemRepository.list(asTx(db), ctx, { q: 'irrigation' });

        expect(whereOf(db.task.findMany).AND).toEqual([
            {
                OR: [
                    { title: { contains: 'irrigation', mode: 'insensitive' } },
                    { key: { contains: 'irrigation', mode: 'insensitive' } },
                ],
            },
        ]);
    });

    it('matches a non-control entity through TaskLink only', async () => {
        // Break: applying the control-only direct-FK arm to every
        // entity type would match on `Task.controlId` while filtering
        // for an ASSET — returning rows linked to an unrelated control.
        await WorkItemRepository.list(asTx(db), ctx, {
            linkedEntityType: 'ASSET',
            linkedEntityId: 'a-1',
        });

        expect(whereOf(db.task.findMany).AND).toEqual([
            { links: { some: { entityType: 'ASSET', entityId: 'a-1' } } },
        ]);
    });

    it('matches a control through EITHER the TaskLink or the direct controlId FK', async () => {
        // Break: dropping the `{ controlId }` arm. Pack-installed tasks
        // set the FK and never create a TaskLink row, so they would
        // vanish from the control's Tasks tab while still showing that
        // control on their own detail page — the regression the OR was
        // added to fix.
        await WorkItemRepository.list(asTx(db), ctx, {
            linkedEntityType: 'CONTROL',
            linkedEntityId: 'c-1',
        });

        expect(whereOf(db.task.findMany).AND).toEqual([
            {
                OR: [
                    { links: { some: { entityType: 'CONTROL', entityId: 'c-1' } } },
                    { controlId: 'c-1' },
                ],
            },
        ]);
    });

    it('ignores a linked-entity type with no id (and an id with no type)', async () => {
        // Break: building the clause from a half-filled pair emits
        // `entityId: undefined`, which Prisma reads as "no constraint"
        // — the list would silently widen to every linked task.
        await WorkItemRepository.list(asTx(db), ctx, { linkedEntityType: 'ASSET' });
        await WorkItemRepository.list(asTx(db), ctx, { linkedEntityId: 'a-1' });

        expect(whereOf(db.task.findMany, 0)).toEqual({ tenantId: 'tenant-1' });
        expect(whereOf(db.task.findMany, 1)).toEqual({ tenantId: 'tenant-1' });
    });

    it('leaves AND off the where clause entirely when no AND-shaped filter applies', async () => {
        // Break: emitting `AND: []`. Harmless to Prisma but it makes
        // the cursor merge below take the "append" branch on a page
        // that has no filters, which is how a shape bug hides.
        await WorkItemRepository.list(asTx(db), ctx, { status: 'OPEN' });

        expect(whereOf(db.task.findMany)).not.toHaveProperty('AND');
    });
});

// ─────────────────────────────────────────────────────────────────────
// List shape — select trim, ordering, bounding.
// ─────────────────────────────────────────────────────────────────────

describe('WorkItemRepository — list shape', () => {
    it('returns the trimmed list projection, never the full row', async () => {
        // Break: reverting to `include: { assignee, createdBy, _count }`
        // pulls back every Task scalar — including the encrypted-at-rest
        // `description` and `metadataJson`, which the list view never
        // renders — plus three correlated `_count` subqueries per row.
        await WorkItemRepository.list(asTx(db), ctx);

        const args = argOf(db.task.findMany);
        expect(args).not.toHaveProperty('include');
        const select = args.select as Args;
        expect(select).toMatchObject({ id: true, key: true, title: true, assigneeUserId: true });
        expect(select).not.toHaveProperty('description');
        expect(select).not.toHaveProperty('metadataJson');
        expect(select).not.toHaveProperty('_count');
    });

    it('orders the list by priority first, then newest', async () => {
        // Break: losing the priority key reshuffles the Tasks page into
        // pure recency, burying P0 work under whatever was typed last.
        await WorkItemRepository.list(asTx(db), ctx);

        expect(argOf(db.task.findMany).orderBy).toEqual([
            { priority: 'asc' },
            { createdAt: 'desc' },
        ]);
    });

    it('omits `take` unless the caller asks for a bound, and passes it through when they do', async () => {
        // Break: a hard-coded default `take` would silently truncate the
        // unbounded callers; ignoring `options.take` would un-bound the
        // callers that deliberately cap.
        await WorkItemRepository.list(asTx(db), ctx, {}, {});
        await WorkItemRepository.list(asTx(db), ctx, {}, { take: 5 });

        expect(argOf(db.task.findMany, 0)).not.toHaveProperty('take');
        expect(argOf(db.task.findMany, 1).take).toBe(5);
    });

    it('bounds the dashboard trend read and asks only for the two timestamps', async () => {
        // Break: dropping the `take` makes a pathological tenant's task
        // table stream into the dashboard request; widening the select
        // drags encrypted columns through a read that only buckets dates.
        const since = new Date('2026-02-01T00:00:00.000Z');
        await WorkItemRepository.farmTaskTrendRows(asTx(db), ctx, since);

        const args = argOf(db.task.findMany);
        expect(args.take).toBe(5000);
        expect(args.select).toEqual({ createdAt: true, completedAt: true });
        expect(args.where).toEqual({
            tenantId: 'tenant-1',
            type: { in: ['FARM_TASK', 'FIELD_OPERATION'] },
            OR: [{ createdAt: { gte: since } }, { completedAt: { gte: since } }],
        });
    });
});

// ─────────────────────────────────────────────────────────────────────
// Cursor pagination.
// ─────────────────────────────────────────────────────────────────────

describe('WorkItemRepository — listPaginated', () => {
    it('over-fetches by exactly one row to detect the next page', async () => {
        // Break: `take: limit` cannot distinguish "last page" from "full
        // page", so `hasNextPage` would be wrong on every exact multiple.
        await WorkItemRepository.listPaginated(asTx(db), ctx, { limit: 5 });

        expect(argOf(db.task.findMany).take).toBe(6);
        expect(argOf(db.task.findMany).orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('clamps an absent or oversized limit', async () => {
        // Break: forwarding the raw query-string limit lets a client ask
        // for 100000 rows in one page.
        await WorkItemRepository.listPaginated(asTx(db), ctx, {});
        await WorkItemRepository.listPaginated(asTx(db), ctx, { limit: 100000 });

        expect(argOf(db.task.findMany, 0).take).toBe(DEFAULT_LIMIT + 1);
        expect(argOf(db.task.findMany, 1).take).toBe(MAX_LIMIT + 1);
    });

    it('APPENDS the cursor to an existing AND instead of replacing it', async () => {
        // Break: `where.AND = [cursorWhere]` unconditionally. Page 1 of a
        // searched list is filtered, page 2 is not — the user scrolls and
        // the list silently widens to every task in the tenant. The
        // if/else is the whole point of this method.
        const cursor = encodeCursor({ createdAt: '2026-03-01T00:00:00.000Z', id: 't-50' });

        await WorkItemRepository.listPaginated(asTx(db), ctx, { cursor, filters: { q: 'wheat' } });

        const and = whereOf(db.task.findMany).AND as Args[];
        expect(and).toHaveLength(2);
        expect(and[0]).toEqual({
            OR: [
                { title: { contains: 'wheat', mode: 'insensitive' } },
                { key: { contains: 'wheat', mode: 'insensitive' } },
            ],
        });
        expect(and[1]).toHaveProperty('OR');
    });

    it('creates the AND when the filters produced none', async () => {
        // Break: pushing onto an undefined `where.AND` throws; an
        // unfiltered second page would 500.
        const cursor = encodeCursor({ createdAt: '2026-03-01T00:00:00.000Z', id: 't-50' });

        await WorkItemRepository.listPaginated(asTx(db), ctx, { cursor });

        const and = whereOf(db.task.findMany).AND as Args[];
        expect(and).toHaveLength(1);
        expect(and[0]).toHaveProperty('OR');
    });

    it('ignores an unreadable cursor rather than emitting a broken predicate', async () => {
        // Break: trusting `decodeCursor` output. A tampered cursor would
        // otherwise reach Prisma as `createdAt: { lt: Invalid Date }`.
        await WorkItemRepository.listPaginated(asTx(db), ctx, { cursor: 'not-a-cursor' });

        expect(whereOf(db.task.findMany)).not.toHaveProperty('AND');
    });

    it('trims the over-fetched row and hands back a cursor pointing at the last KEPT row', async () => {
        // Break: emitting a cursor built from the extra (trimmed) row
        // skips an item at every page boundary — silent data loss in a
        // paged list.
        const rows = [1, 2, 3].map((n) => ({
            id: `t-${n}`,
            createdAt: new Date(`2026-03-0${n}T00:00:00.000Z`),
        }));
        db.task.findMany.mockResolvedValue(rows);

        const page = await WorkItemRepository.listPaginated(asTx(db), ctx, { limit: 2 });

        expect(page.items).toHaveLength(2);
        expect(page.pageInfo.hasNextPage).toBe(true);
        expect(page.pageInfo.nextCursor).toBe(
            encodeCursor({ createdAt: rows[1].createdAt.toISOString(), id: 't-2' }),
        );
    });

    it('reports the end of the list with no cursor', async () => {
        // Break: always returning a cursor makes the client loop forever
        // on the final page.
        db.task.findMany.mockResolvedValue([
            { id: 't-1', createdAt: new Date('2026-03-01T00:00:00.000Z') },
        ]);

        const page = await WorkItemRepository.listPaginated(asTx(db), ctx, { limit: 2 });

        expect(page.pageInfo.hasNextPage).toBe(false);
        expect(page.pageInfo.nextCursor).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────
// Linked-task counting — the control/asset/risk badges.
// ─────────────────────────────────────────────────────────────────────

describe('WorkItemRepository — countLinkedToControl', () => {
    it('counts the linked set with the SAME where the tab renders, and "done" as RESOLVED|CLOSED only', async () => {
        // Break: counting `done` with CANCELED included. A control whose
        // tasks were all abandoned would read 100% complete on the
        // readiness header — the single most misleading number the page
        // can show.
        db.task.count.mockResolvedValueOnce(4).mockResolvedValueOnce(1);

        const result = await WorkItemRepository.countLinkedToControl(asTx(db), ctx, 'c-1');

        expect(result).toEqual({ total: 4, done: 1 });
        const listWhere = whereOf(db.task.count, 0);
        expect(listWhere).toMatchObject({ tenantId: 'tenant-1' });
        expect(listWhere.AND).toEqual([
            {
                OR: [
                    { links: { some: { entityType: 'CONTROL', entityId: 'c-1' } } },
                    { controlId: 'c-1' },
                ],
            },
        ]);
        expect(whereOf(db.task.count, 1)).toEqual({
            AND: [listWhere, { status: { in: ['RESOLVED', 'CLOSED'] } }],
        });
    });
});

describe('WorkItemRepository — countLinkedToControls (batched)', () => {
    it('short-circuits an empty id set without touching the database', async () => {
        // Break: falling through emits `entityId: { in: [] }` twice on
        // every controls page that happens to render zero rows.
        const result = await WorkItemRepository.countLinkedToControls(asTx(db), ctx, []);

        expect(result.size).toBe(0);
        expect(db.task.findMany).not.toHaveBeenCalled();
        expect(db.taskLink.findMany).not.toHaveBeenCalled();
    });

    it('counts a task linked BOTH ways exactly once', async () => {
        // Break: summing the two queries instead of deduping by task id.
        // A task created from the control tab (TaskLink) that also
        // carries the FK would be counted twice — 2/1 progress.
        db.task.findMany.mockResolvedValue([
            { id: 't-1', controlId: 'c-1', status: 'CLOSED' },
        ]);
        db.taskLink.findMany.mockResolvedValue([
            { entityId: 'c-1', taskId: 't-1', task: { status: 'CLOSED' } },
        ]);

        const result = await WorkItemRepository.countLinkedToControls(asTx(db), ctx, ['c-1']);

        expect(result.get('c-1')).toEqual({ total: 1, done: 1 });
    });

    it('tallies done as RESOLVED|CLOSED and never CANCELED, per control', async () => {
        // Break: treating every terminal status as done. CANCELED work
        // is terminal but not completed; counting it inflates coverage.
        db.task.findMany.mockResolvedValue([
            { id: 't-1', controlId: 'c-1', status: 'RESOLVED' },
            { id: 't-2', controlId: 'c-1', status: 'CANCELED' },
            { id: 't-3', controlId: 'c-1', status: 'OPEN' },
            { id: 't-4', controlId: 'c-2', status: 'CLOSED' },
        ]);

        const result = await WorkItemRepository.countLinkedToControls(asTx(db), ctx, ['c-1', 'c-2']);

        expect(result.get('c-1')).toEqual({ total: 3, done: 1 });
        expect(result.get('c-2')).toEqual({ total: 1, done: 1 });
    });

    it('skips a direct row whose controlId came back null', async () => {
        // Break: keying the map on a null controlId produces a "null"
        // bucket the caller silently ignores — but only after it has
        // already displaced a real count.
        db.task.findMany.mockResolvedValue([
            { id: 't-1', controlId: null, status: 'OPEN' },
        ]);

        const result = await WorkItemRepository.countLinkedToControls(asTx(db), ctx, ['c-1']);

        expect(result.size).toBe(0);
    });

    it('omits a control with no linked tasks from the map entirely', async () => {
        // Break: pre-seeding every requested id with { total: 0 } changes
        // the caller's "no data" branch into "explicitly zero".
        const result = await WorkItemRepository.countLinkedToControls(asTx(db), ctx, ['c-1']);

        expect(result.has('c-1')).toBe(false);
    });

    it('scopes both batched queries to the tenant and to the requested ids', async () => {
        // Break: an unscoped TaskLink read counts another tenant's tasks
        // into this tenant's control badge.
        await WorkItemRepository.countLinkedToControls(asTx(db), ctx, ['c-1', 'c-2']);

        expect(whereOf(db.task.findMany)).toEqual({
            tenantId: 'tenant-1',
            controlId: { in: ['c-1', 'c-2'] },
        });
        expect(whereOf(db.taskLink.findMany)).toEqual({
            tenantId: 'tenant-1',
            entityType: 'CONTROL',
            entityId: { in: ['c-1', 'c-2'] },
        });
    });
});

describe('WorkItemRepository — countLinkedToEntities (batched, link-only)', () => {
    it('short-circuits an empty id set without touching the database', async () => {
        // Break: an `in: []` query on every asset/risk list page that
        // renders no rows.
        const result = await WorkItemRepository.countLinkedToEntities(asTx(db), ctx, 'ASSET', []);

        expect(result.size).toBe(0);
        expect(db.taskLink.findMany).not.toHaveBeenCalled();
    });

    it('uses ONE tenant-scoped query keyed on the caller-supplied entity type', async () => {
        // Break: hard-coding the entity type (the method was extracted
        // from the CONTROL-specific one) makes the assets column show
        // counts for a different entity. And an N+1 over the entity
        // list is the shape this method exists to avoid.
        await WorkItemRepository.countLinkedToEntities(asTx(db), ctx, 'ASSET', ['r-1', 'r-2']);

        expect(db.taskLink.findMany).toHaveBeenCalledTimes(1);
        expect(whereOf(db.taskLink.findMany)).toEqual({
            tenantId: 'tenant-1',
            entityType: 'ASSET',
            entityId: { in: ['r-1', 'r-2'] },
        });
    });

    it('dedupes by task id and tallies done as RESOLVED|CLOSED', async () => {
        // Break: counting duplicate TaskLink rows separately, or letting
        // CANCELED count as done — same failure as the control path, and
        // the two implementations are separate code.
        db.taskLink.findMany.mockResolvedValue([
            { entityId: 'r-1', taskId: 't-1', task: { status: 'RESOLVED' } },
            { entityId: 'r-1', taskId: 't-1', task: { status: 'RESOLVED' } },
            { entityId: 'r-1', taskId: 't-2', task: { status: 'CANCELED' } },
            { entityId: 'r-2', taskId: 't-3', task: { status: 'CLOSED' } },
        ]);

        const result = await WorkItemRepository.countLinkedToEntities(asTx(db), ctx, 'ASSET', ['r-1', 'r-2']);

        expect(result.get('r-1')).toEqual({ total: 2, done: 1 });
        expect(result.get('r-2')).toEqual({ total: 1, done: 1 });
    });
});

// ─────────────────────────────────────────────────────────────────────
// Writes.
// ─────────────────────────────────────────────────────────────────────

describe('WorkItemRepository — create', () => {
    it('mints the key from the atomic per-tenant counter', async () => {
        // Break: deriving the key from `db.task.count()` again. That
        // races the unique [tenantId, key] index under concurrent
        // imports and scales linearly with tenant size — the exact
        // regression the upsert replaced.
        db.taskKeySequence.upsert.mockResolvedValue({ lastValue: 42 });

        await WorkItemRepository.create(asTx(db), ctx, { title: 'Scout field 4' });

        expect(db.taskKeySequence.upsert).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1' },
            create: { tenantId: 'tenant-1', lastValue: 1 },
            update: { lastValue: { increment: 1 } },
        });
        expect(dataOf(db.task.create).key).toBe('TSK-42');
        expect(db.task.count).not.toHaveBeenCalled();
    });

    it('applies the documented defaults when the caller omits the classification fields', async () => {
        // Break: a wrong default (say severity CRITICAL) makes every
        // quick-created task page the on-call farm manager.
        await WorkItemRepository.create(asTx(db), ctx, { title: 'Scout field 4' });

        expect(dataOf(db.task.create)).toMatchObject({
            tenantId: 'tenant-1',
            createdByUserId: 'user-1',
            title: 'Scout field 4',
            type: 'TASK',
            severity: 'MEDIUM',
            priority: 'P2',
            source: 'MANUAL',
        });
    });

    it('lets the caller override every default', async () => {
        // Break: a `??` written as `||`-on-the-wrong-side, or the
        // override dropped entirely — field operations would be filed
        // as plain TASKs and vanish from the field-ops views.
        await WorkItemRepository.create(asTx(db), ctx, {
            title: 'Spray block B',
            type: 'FIELD_OPERATION',
            severity: 'HIGH',
            priority: 'P1',
            source: 'AUTOMATION',
        });

        expect(dataOf(db.task.create)).toMatchObject({
            type: 'FIELD_OPERATION',
            severity: 'HIGH',
            priority: 'P1',
            source: 'AUTOMATION',
        });
    });

    it('parses a due date and normalises the empty optionals to null', async () => {
        // Break: writing `dueAt` through as a string (Prisma rejects it)
        // or persisting '' as an assignee id — a foreign key that
        // matches no user and breaks the assignee join on read.
        await WorkItemRepository.create(asTx(db), ctx, {
            title: 'x',
            dueAt: '2026-04-01T00:00:00.000Z',
            assigneeUserId: '',
            reviewerUserId: '',
            controlId: '',
            clientMutationId: '',
        });

        const data = dataOf(db.task.create);
        expect(data.dueAt).toEqual(new Date('2026-04-01T00:00:00.000Z'));
        expect(data.assigneeUserId).toBeNull();
        expect(data.reviewerUserId).toBeNull();
        expect(data.controlId).toBeNull();
        expect(data.clientMutationId).toBeNull();
    });

    it('stores a null due date as null rather than the epoch', async () => {
        // Break: `new Date(null)` is 1970-01-01, which would make every
        // date-less task read as overdue.
        await WorkItemRepository.create(asTx(db), ctx, { title: 'x', dueAt: null });

        expect(dataOf(db.task.create).dueAt).toBeNull();
    });

    it('writes Prisma.JsonNull — not JS null — for an absent metadata blob', async () => {
        // Break: passing JS `null` into a Json column makes Prisma throw
        // at runtime ("Argument metadataJson must not be null"), so every
        // create without metadata would 500.
        await WorkItemRepository.create(asTx(db), ctx, { title: 'x' });
        await WorkItemRepository.create(asTx(db), ctx, { title: 'x', metadataJson: null });
        await WorkItemRepository.create(asTx(db), ctx, { title: 'x', metadataJson: { rate: 2 } });

        expect(dataOf(db.task.create, 0).metadataJson).toBe(Prisma.JsonNull);
        expect(dataOf(db.task.create, 1).metadataJson).toBe(Prisma.JsonNull);
        expect(dataOf(db.task.create, 2).metadataJson).toEqual({ rate: 2 });
    });
});

describe('WorkItemRepository — update', () => {
    beforeEach(() => {
        db.task.findFirst.mockResolvedValue({ id: 't-1' });
    });

    it('writes only the keys the caller actually sent', async () => {
        // Break: spreading the whole payload. Every PATCH of a title
        // would also blank the description, severity and due date,
        // because the absent keys arrive as `undefined`.
        await WorkItemRepository.update(asTx(db), ctx, 't-1', { title: 'renamed' });

        expect(dataOf(db.task.update)).toEqual({ title: 'renamed' });
    });

    it('applies an explicitly-null description instead of skipping it', async () => {
        // Break: guarding with `if (data.description)` rather than
        // `!== undefined` makes "clear the notes" a no-op — the user
        // saves, the text stays.
        await WorkItemRepository.update(asTx(db), ctx, 't-1', { description: null });

        expect(dataOf(db.task.update)).toEqual({ description: null });
    });

    it('parses a supplied due date and clears it when sent as null', async () => {
        // Break: same string-vs-Date and epoch traps as create.
        await WorkItemRepository.update(asTx(db), ctx, 't-1', { dueAt: '2026-05-01T00:00:00.000Z' });
        await WorkItemRepository.update(asTx(db), ctx, 't-1', { dueAt: null });

        expect(dataOf(db.task.update, 0).dueAt).toEqual(new Date('2026-05-01T00:00:00.000Z'));
        expect(dataOf(db.task.update, 1).dueAt).toBeNull();
    });

    it('carries the classification and linkage fields through when supplied', async () => {
        // Break: the five remaining conditional spreads are written
        // identically, which makes a copy-paste slip (`severity:
        // data.priority`) invisible — a re-triage would silently write
        // the wrong column. `controlId: null` is asserted alongside
        // because unlinking a control goes through the same `!==
        // undefined` gate as setting one.
        await WorkItemRepository.update(asTx(db), ctx, 't-1', {
            type: 'FIELD_OPERATION',
            severity: 'LOW',
            priority: 'P3',
            controlId: null,
            reviewerUserId: 'user-4',
        });

        expect(dataOf(db.task.update)).toEqual({
            type: 'FIELD_OPERATION',
            severity: 'LOW',
            priority: 'P3',
            controlId: null,
            reviewerUserId: 'user-4',
        });
    });

    it('routes a null metadata blob through Prisma.JsonNull on the update path too', async () => {
        // Break: the create path handles this and the update path does
        // not — clearing metadata would 500 while setting it works.
        await WorkItemRepository.update(asTx(db), ctx, 't-1', { metadataJson: null });
        await WorkItemRepository.update(asTx(db), ctx, 't-1', { metadataJson: { rate: 2 } });

        expect(dataOf(db.task.update, 0).metadataJson).toBe(Prisma.JsonNull);
        expect(dataOf(db.task.update, 1).metadataJson).toEqual({ rate: 2 });
    });
});

describe('WorkItemRepository — setStatus', () => {
    beforeEach(() => {
        db.task.findFirst.mockResolvedValue({ id: 't-1' });
    });

    it('stamps completedAt when the task reaches a terminal status', async () => {
        // Break: never stamping it empties the "resolved in the last 30
        // days" trend and the completion half of every progress badge.
        await WorkItemRepository.setStatus(asTx(db), ctx, 't-1', 'CLOSED');

        expect(dataOf(db.task.update)).toEqual({ status: 'CLOSED', completedAt: NOW });
    });

    it('CLEARS completedAt when a terminal task is re-opened', async () => {
        // Break: leaving the old timestamp behind. The task is visibly
        // open, yet keeps counting as completed work in the dashboard
        // trend — the two numbers disagree with no way to tell which
        // is right.
        await WorkItemRepository.setStatus(asTx(db), ctx, 't-1', 'IN_PROGRESS');

        expect(dataOf(db.task.update)).toEqual({ status: 'IN_PROGRESS', completedAt: null });
    });

    it('records a resolution only when one was supplied', async () => {
        // Break: writing `resolution: undefined` is harmless, but
        // writing `resolution: null` on every close would erase the
        // note a previous close left behind.
        await WorkItemRepository.setStatus(asTx(db), ctx, 't-1', 'RESOLVED', 'fixed in the field');
        await WorkItemRepository.setStatus(asTx(db), ctx, 't-1', 'RESOLVED');

        expect(dataOf(db.task.update, 0).resolution).toBe('fixed in the field');
        expect(dataOf(db.task.update, 1)).not.toHaveProperty('resolution');
    });

    it('does NOT stamp completedAt on CANCELED — terminal is not completed', async () => {
        // The load-bearing distinction in this file. CANCELED is
        // terminal (`isTerminalStatus`) but not completed
        // (`isCompletedStatus`), and `completedAt` tracks the latter.
        //
        // Break: gating the stamp on `isTerminalStatus` instead. Every
        // cancelled task then carries a completion timestamp, and since
        // `farmTaskTrendRows` and `metrics().trend.resolved30d` both read
        // the TIMESTAMP rather than the status, a cancelled spray job
        // silently lands in the dashboard's "completed" series — while
        // the linked-task badges two methods up, which partition on
        // status, keep excluding it. The two halves of the same file
        // would disagree about the same task.
        await WorkItemRepository.setStatus(asTx(db), ctx, 't-1', 'CANCELED');

        expect(dataOf(db.task.update).completedAt).toBeNull();
    });

    it('still records the resolution on CANCELED, which is terminal', async () => {
        // The other half of the split predicate, and the reason the fix
        // above could not simply narrow `isTerminalStatus`. A cancelled
        // item owes the auditor a "why" exactly like a closed one — S8
        // requires a non-empty resolution on every terminal write. Break:
        // moving the resolution write onto `isCompletedStatus` too would
        // drop the cancellation reason on the floor.
        await WorkItemRepository.setStatus(asTx(db), ctx, 't-1', 'CANCELED', 'field re-let to another contractor');

        expect(dataOf(db.task.update)).toEqual({
            status: 'CANCELED',
            completedAt: null,
            resolution: 'field re-let to another contractor',
        });
    });
});

describe('WorkItemRepository — bulk writes', () => {
    it('applies the SAME completedAt rule as setStatus — stamped on close, cleared on re-open', async () => {
        // The bulk path used to leave `completedAt` untouched on a
        // non-terminal target, so a task's completion timestamp depended
        // on whether it was re-opened one-at-a-time or from the list
        // page's checkbox column. Break: dropping the `: null` arm
        // restores that split, and a bulk-re-opened task stays in the
        // "completed" trend while showing as IN_PROGRESS.
        //
        // Clearing is safe here despite `updateMany` writing one payload
        // to every row: both callers run the S8 all-or-nothing transition
        // gate first, and CLOSED/CANCELED have no outgoing transitions, so
        // the only terminal row that can reach a non-completed target is
        // RESOLVED → IN_PROGRESS — a real re-open.
        await WorkItemRepository.bulkSetStatus(asTx(db), ctx, ['a'], 'CLOSED', 'batch closed');
        await WorkItemRepository.bulkSetStatus(asTx(db), ctx, ['a'], 'IN_PROGRESS');

        expect(dataOf(db.task.updateMany, 0)).toEqual({
            status: 'CLOSED',
            completedAt: NOW,
            resolution: 'batch closed',
        });
        expect(dataOf(db.task.updateMany, 1)).toEqual({
            status: 'IN_PROGRESS',
            completedAt: null,
        });
    });

    it('does NOT stamp completedAt on a bulk cancel either', async () => {
        // Break: the CANCELED-is-completed bug reintroduced on the bulk
        // path only. A single cancel would be correct while the list
        // page's bulk cancel quietly inflated the completed series —
        // the worst shape of this bug, because the two paths disagree.
        await WorkItemRepository.bulkSetStatus(asTx(db), ctx, ['a', 'b'], 'CANCELED', 'season abandoned');

        expect(dataOf(db.task.updateMany)).toEqual({
            status: 'CANCELED',
            completedAt: null,
            resolution: 'season abandoned',
        });
    });

    it('parses a bulk due date and clears it when sent as null', async () => {
        // Break: the same string-vs-Date trap, multiplied by the batch.
        await WorkItemRepository.bulkSetDueDate(asTx(db), ctx, ['a'], '2026-06-01T00:00:00.000Z');
        await WorkItemRepository.bulkSetDueDate(asTx(db), ctx, ['a'], null);

        expect(dataOf(db.task.updateMany, 0).dueAt).toEqual(new Date('2026-06-01T00:00:00.000Z'));
        expect(dataOf(db.task.updateMany, 1).dueAt).toBeNull();
    });

    it('reads the current statuses of a known id set without the soft-deleted rows', async () => {
        // Break: dropping `deletedAt: null` feeds the bulk transition
        // validator rows the user cannot see, so a batch would be
        // rejected (or allowed) on the strength of a deleted task.
        await WorkItemRepository.listByIds(asTx(db), ctx, ['a', 'b']);

        expect(argOf(db.task.findMany)).toMatchObject({
            where: { id: { in: ['a', 'b'] }, tenantId: 'tenant-1', deletedAt: null },
            select: { id: true, status: true },
        });
    });

    it('short-circuits an empty id set without querying', async () => {
        // Break: `id: { in: [] }` on every empty bulk submission.
        const rows = await WorkItemRepository.listByIds(asTx(db), ctx, []);

        expect(rows).toEqual([]);
        expect(db.task.findMany).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────
// Metrics.
// ─────────────────────────────────────────────────────────────────────

describe('WorkItemRepository — metrics', () => {
    /** Discriminates the six parallel counts by the shape of their where. */
    function wireCounts() {
        db.task.count.mockImplementation((args: { where: Args }) => {
            const where = args.where;
            const dueAt = where.dueAt as { lt?: Date; gte?: Date; lte?: Date } | undefined;
            if (dueAt?.lt) return Promise.resolve(11);
            if (dueAt?.lte) {
                const span = dueAt.lte.getTime() - (dueAt.gte as Date).getTime();
                return Promise.resolve(span === 7 * DAY ? 22 : 33);
            }
            if (where.createdAt) return Promise.resolve(55);
            if (where.completedAt) return Promise.resolve(66);
            return Promise.resolve(44);
        });
    }

    it('separates the overdue / 7-day / 30-day windows and excludes terminal work from all three', async () => {
        // Break: a shared window (7d used for the 30d count) or a missing
        // status guard. Both produce plausible numbers that are simply
        // wrong, which is why each is asserted by its own value.
        wireCounts();

        const m = await WorkItemRepository.metrics(asTx(db), ctx);

        expect(m.overdue).toBe(11);
        expect(m.dueIn7d).toBe(22);
        expect(m.dueIn30d).toBe(33);
        expect(m.total).toBe(44);
        expect(m.trend).toEqual({ created30d: 55, resolved30d: 66 });

        const openFilter = { notIn: ['RESOLVED', 'CLOSED', 'CANCELED'] };
        for (const call of [0, 1, 2]) {
            expect(whereOf(db.task.count, call)).toMatchObject({ tenantId: 'tenant-1', status: openFilter });
        }
        // The plain total must NOT carry the open filter — otherwise the
        // denominator of every ratio silently becomes "open tasks".
        expect(whereOf(db.task.count, 3)).toEqual({ tenantId: 'tenant-1' });
    });

    it('looks 30 days back for the trend, not 30 days forward', async () => {
        // Break: a sign slip on the trend window returns 0 forever.
        wireCounts();

        await WorkItemRepository.metrics(asTx(db), ctx);

        const created = whereOf(db.task.count, 4).createdAt as { gte: Date };
        expect(created.gte).toEqual(new Date(NOW.getTime() - 30 * DAY));
    });

    it('folds the three groupBy results into keyed count maps', async () => {
        // Break: mapping `_count` from the wrong field, or keying by the
        // groupBy column of a different call — the donut charts would
        // render another dimension's numbers under this one's labels.
        db.task.groupBy.mockImplementation((args: { by: string[] }) => {
            const rows: Record<string, unknown[]> = {
                status: [{ status: 'OPEN', _count: 3 }, { status: 'CLOSED', _count: 1 }],
                severity: [{ severity: 'HIGH', _count: 2 }],
                type: [{ type: 'FARM_TASK', _count: 5 }],
                controlId: [],
            };
            return Promise.resolve(rows[args.by[0]] ?? []);
        });

        const m = await WorkItemRepository.metrics(asTx(db), ctx);

        expect(m.byStatus).toEqual({ OPEN: 3, CLOSED: 1 });
        expect(m.bySeverity).toEqual({ HIGH: 2 });
        expect(m.byType).toEqual({ FARM_TASK: 5 });
    });

    it('resolves the top controls to code + name in ONE batched lookup', async () => {
        // Break: reading the control per group row is an N+1 on a
        // dashboard query; skipping the lookup leaves the panel showing
        // opaque ids.
        db.task.groupBy.mockImplementation((args: { by: string[] }) =>
            Promise.resolve(
                args.by[0] === 'controlId'
                    ? [{ controlId: 'c-1', _count: 4 }, { controlId: 'c-2', _count: 2 }]
                    : [],
            ),
        );
        db.control.findMany.mockResolvedValue([{ id: 'c-1', code: 'A.5.1', name: 'Policies' }]);

        const m = await WorkItemRepository.metrics(asTx(db), ctx);

        expect(db.control.findMany).toHaveBeenCalledTimes(1);
        expect(whereOf(db.control.findMany)).toEqual({ id: { in: ['c-1', 'c-2'] } });
        expect(m.topControls[0]).toEqual({
            controlId: 'c-1', code: 'A.5.1', name: 'Policies', openTaskCount: 4,
        });
        // Break: `controlMap.get(id).code` without the `?.`/`|| ''`
        // fallback throws when a control was deleted between the two
        // queries — the whole dashboard 500s on a race.
        expect(m.topControls[1]).toEqual({
            controlId: 'c-2', code: '', name: '', openTaskCount: 2,
        });
    });

    it('skips the control lookup entirely when no control has open tasks', async () => {
        // Break: `findMany({ where: { id: { in: [] } } })` on every
        // dashboard load for a tenant that does not use controls.
        const m = await WorkItemRepository.metrics(asTx(db), ctx);

        expect(db.control.findMany).not.toHaveBeenCalled();
        expect(m.topControls).toEqual([]);
    });

    it('pushes the top-linked-entity aggregation down to the database', async () => {
        // Break: loading every TaskLink and aggregating in JS — the
        // shape this groupBy replaced. Also pins the ASSET|RISK scope
        // and the open-only join filter: without them a control link or
        // a closed task would crowd out live work.
        db.taskLink.groupBy.mockResolvedValue([
            { entityType: 'ASSET', entityId: 'a-1', _count: 3 },
        ]);

        const m = await WorkItemRepository.metrics(asTx(db), ctx);

        const args = argOf(db.taskLink.groupBy);
        expect(args.take).toBe(5);
        expect(args.where).toEqual({
            tenantId: 'tenant-1',
            entityType: { in: ['ASSET'] },
            task: { status: { notIn: ['RESOLVED', 'CLOSED', 'CANCELED'] } },
        });
        expect(m.topLinkedEntities).toEqual([
            { entityType: 'ASSET', entityId: 'a-1', count: 3 },
        ]);
    });
});

// ─────────────────────────────────────────────────────────────────────
// Satellites: links, comments, watchers.
// ─────────────────────────────────────────────────────────────────────

describe('TaskLinkRepository', () => {
    it('defaults an unspecified relation to RELATES_TO', async () => {
        // Break: writing `relation: undefined` violates the non-null
        // column, so every link created without an explicit relation
        // (the common case) would fail.
        await TaskLinkRepository.link(asTx(db), ctx, 't-1', 'ASSET', 'a-1');

        expect(dataOf(db.taskLink.create)).toEqual({
            tenantId: 'tenant-1',
            taskId: 't-1',
            entityType: 'ASSET',
            entityId: 'a-1',
            relation: 'RELATES_TO',
        });
    });

    it('honours an explicit relation', async () => {
        // Break: a `??` that ignores the argument would flatten every
        // link to RELATES_TO, losing the BLOCKS/DUPLICATES semantics.
        await TaskLinkRepository.link(asTx(db), ctx, 't-1', 'ASSET', 'r-1', 'BLOCKS');

        expect(dataOf(db.taskLink.create).relation).toBe('BLOCKS');
    });

    it('refuses to unlink a row belonging to another tenant', async () => {
        // Break: `delete({ where: { id } })` runs unscoped — without the
        // pre-read any link id is deletable cross-tenant.
        db.taskLink.findFirst.mockResolvedValue(null);

        const result = await TaskLinkRepository.unlink(asTx(db), ctx, 'link-foreign');

        expect(result).toBeNull();
        expect(db.taskLink.delete).not.toHaveBeenCalled();
        expect(db.taskLink.findFirst).toHaveBeenCalledWith({
            where: { id: 'link-foreign', tenantId: 'tenant-1' },
        });
    });

    it('does unlink a row inside the tenant', async () => {
        // Positive half of the guard above.
        db.taskLink.findFirst.mockResolvedValue({ id: 'link-1' });

        const result = await TaskLinkRepository.unlink(asTx(db), ctx, 'link-1');

        expect(result).toBe(true);
        expect(db.taskLink.delete).toHaveBeenCalledWith({ where: { id: 'link-1' } });
    });
});

describe('TaskCommentRepository', () => {
    it('attributes a comment to the calling user and tenant', async () => {
        // Break: taking the author from the request body instead of the
        // context lets a caller post as someone else — and comment
        // bodies are encrypted-at-rest business content.
        await TaskCommentRepository.add(asTx(db), ctx, 't-1', 'looks dry');

        expect(dataOf(db.taskComment.create)).toEqual({
            tenantId: 'tenant-1',
            taskId: 't-1',
            body: 'looks dry',
            createdByUserId: 'user-1',
        });
    });

    it('reads a thread oldest-first', async () => {
        // Break: `desc` renders the conversation backwards.
        await TaskCommentRepository.listByTask(asTx(db), ctx, 't-1');

        expect(argOf(db.taskComment.findMany).orderBy).toEqual({ createdAt: 'asc' });
    });
});

describe('TaskWatcherRepository', () => {
    it('stamps the tenant on a new watcher row', async () => {
        // Break: a tenant-less watcher row is invisible to RLS reads and
        // silently stops the user's notifications.
        await TaskWatcherRepository.add(asTx(db), ctx, 't-1', 'user-9');

        expect(dataOf(db.taskWatcher.create)).toEqual({
            tenantId: 'tenant-1',
            taskId: 't-1',
            userId: 'user-9',
        });
    });

    it('refuses to remove a watcher outside the tenant', async () => {
        // Break: the delete is keyed by the row id found above, so
        // without the tenant-scoped lookup any watcher is removable.
        db.taskWatcher.findFirst.mockResolvedValue(null);

        const result = await TaskWatcherRepository.remove(asTx(db), ctx, 't-1', 'user-9');

        expect(result).toBeNull();
        expect(db.taskWatcher.delete).not.toHaveBeenCalled();
        expect(db.taskWatcher.findFirst).toHaveBeenCalledWith({
            where: { taskId: 't-1', userId: 'user-9', tenantId: 'tenant-1' },
        });
    });

    it('removes the watcher row it actually found, by id', async () => {
        // Break: deleting by `{ taskId, userId }` is not a unique key —
        // Prisma rejects it, so unwatch would 500.
        db.taskWatcher.findFirst.mockResolvedValue({ id: 'w-1' });

        const result = await TaskWatcherRepository.remove(asTx(db), ctx, 't-1', 'user-9');

        expect(result).toBe(true);
        expect(db.taskWatcher.delete).toHaveBeenCalledWith({ where: { id: 'w-1' } });
    });
});
