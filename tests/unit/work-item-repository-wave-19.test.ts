/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma transaction
 * client is a wide structural surface; a fake delegate set is the practical
 * shape, matching the other repository tests. */

/**
 * Coverage wave 19 — `WorkItemRepository` and its sibling link/comment/watcher
 * repositories.
 *
 * The file sat at 50% branches with 9 of 33 functions executed. Almost all of
 * the missing branches are in `_buildWhere`, the single place that translates
 * a task-list filter payload into a Prisma `where`. Every list screen, every
 * saved filter and every dashboard count goes through it.
 *
 * A wrong `where` does not throw. It returns a confident, plausible, wrong set
 * of rows — which on a task list reads as "you have nothing overdue". These
 * tests assert the SHAPE handed to Prisma, because that is the only place the
 * mistake is visible before it reaches a user.
 *
 * Two behaviours are worth stating outright:
 *
 *   1. **A due-window filter implies "not finished", but only when the caller
 *      did not say otherwise.** `due=overdue` adds `status notIn TERMINAL`, so
 *      closed tasks stop haunting the overdue list. If the caller passed an
 *      explicit `status`, theirs wins — asking for overdue DONE tasks is a
 *      legitimate audit question, and silently overriding it would make the
 *      answer impossible to obtain.
 *
 *   2. **Tenant scoping is unconditional.** `tenantId` is set before any
 *      filter is considered, so no combination of filters can produce a
 *      cross-tenant query. This is the application-layer half of the
 *      defence-in-depth pair described in CLAUDE.md; RLS is the other half.
 */
import {
    WorkItemRepository,
    TaskLinkRepository,
    TaskCommentRepository,
    TaskWatcherRepository,
} from '@/app-layer/repositories/WorkItemRepository';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', {
    tenantSlug: 'acme',
    tenantId: 'tenant-1',
    userId: 'user-1',
});

function fakeDb() {
    return {
        // `update`/`assign`/`setStatus` read the row first and bail with null
        // when it is absent, so the default must be a FOUND row or every write
        // test silently exercises the not-found path instead.
        taskKeySequence: { upsert: jest.fn().mockResolvedValue({ nextValue: 7 }) },
        task: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue({ id: 't-1', tenantId: 'tenant-1' }),
            create: jest.fn().mockResolvedValue({ id: 't-1' }),
            update: jest.fn().mockResolvedValue({ id: 't-1' }),
            updateMany: jest.fn().mockResolvedValue({ count: 2 }),
            count: jest.fn().mockResolvedValue(0),
            groupBy: jest.fn().mockResolvedValue([]),
        },
        taskLink: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue({ id: 'link-1', tenantId: 'tenant-1' }),
            delete: jest.fn().mockResolvedValue({ id: 'link-1' }),
            create: jest.fn().mockResolvedValue({ id: 'l-1' }),
            deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            groupBy: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
        },
        taskComment: {
            findMany: jest.fn().mockResolvedValue([]),
            create: jest.fn().mockResolvedValue({ id: 'c-1' }),
        },
        taskWatcher: {
            findMany: jest.fn().mockResolvedValue([]),
            create: jest.fn().mockResolvedValue({ id: 'w-1' }),
            deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
    } as any;
}

/** Run listPaginated and hand back the `where` that reached Prisma. */
async function whereFor(filters: Record<string, unknown>) {
    const db = fakeDb();
    await WorkItemRepository.listPaginated(db, ctx, { filters } as any);
    return db.task.findMany.mock.calls[0][0].where;
}

describe('WorkItemRepository._buildWhere — every filter reaches Prisma', () => {
    it('always scopes to the caller tenant', async () => {
        expect((await whereFor({})).tenantId).toBe('tenant-1');
    });

    it.each([
        ['status', 'OPEN'],
        ['type', 'FINDING'],
        ['severity', 'HIGH'],
        ['priority', 'P1'],
        ['assigneeUserId', 'user-9'],
        ['controlId', 'ctrl-3'],
    ])('maps %s straight through', async (key, value) => {
        // Break: a dropped filter silently widens the result set — the list
        // shows rows the user filtered out and nothing signals it.
        const where = await whereFor({ [key]: value });
        expect(where[key]).toBe(value);
    });

    it('omits a filter that was not supplied rather than sending undefined', async () => {
        const where = await whereFor({});
        expect('status' in where).toBe(false);
        expect('assigneeUserId' in where).toBe(false);
    });
});

describe('WorkItemRepository._buildWhere — due windows', () => {
    it('overdue means past due AND not in a terminal status', async () => {
        // Break: dropping the status clause leaves every closed task on the
        // overdue list forever.
        const where = await whereFor({ due: 'overdue' });
        expect(where.dueAt).toEqual({ lt: expect.any(Date) });
        expect(where.status).toEqual({ notIn: expect.any(Array) });
    });

    it('next7d is a bounded window, not an open-ended one', async () => {
        const where = await whereFor({ due: 'next7d' });
        expect(where.dueAt).toEqual({ gte: expect.any(Date), lte: expect.any(Date) });
        expect((where.dueAt.lte as Date).getTime()).toBeGreaterThan(
            (where.dueAt.gte as Date).getTime(),
        );
    });

    it('an explicit status wins over the implied not-terminal clause', async () => {
        // Break: overriding the caller's status would make "overdue tasks that
        // were eventually closed" — a real audit question — unanswerable.
        const where = await whereFor({ due: 'overdue', status: 'DONE' });
        expect(where.status).toBe('DONE');
    });

    it('leaves dueAt alone for an unrecognised due value', async () => {
        const where = await whereFor({ due: 'someday' });
        expect('dueAt' in where).toBe(false);
    });
});

describe('WorkItemRepository._buildWhere — search and linked entities', () => {
    it('turns a query string into a filter', async () => {
        const where = await whereFor({ q: 'irrigation' });
        expect(JSON.stringify(where)).toContain('irrigation');
    });

    it('requires BOTH halves of a linked-entity filter', async () => {
        // Break: acting on a half-specified pair would filter by entity TYPE
        // alone — every task linked to any location, not the one asked for.
        const partial = await whereFor({ linkedEntityType: 'LOCATION' });
        expect(JSON.stringify(partial)).not.toContain('LOCATION');

        const full = await whereFor({ linkedEntityType: 'LOCATION', linkedEntityId: 'loc-1' });
        expect(JSON.stringify(full)).toContain('loc-1');
    });
});

describe('WorkItemRepository.listPaginated — cursor paging', () => {
    it('over-fetches by one to detect a next page', async () => {
        // Break: taking exactly `limit` makes hasNextPage unknowable, so the
        // list stops one page early with no indication.
        const db = fakeDb();
        await WorkItemRepository.listPaginated(db, ctx, { filters: {}, limit: 10 } as any);
        expect(db.task.findMany.mock.calls[0][0].take).toBe(11);
    });

    it('merges a cursor into an existing AND rather than replacing it', async () => {
        // Break: overwriting `where.AND` drops the linked-entity filter that
        // also lives there — page 2 would show rows page 1 excluded.
        const db = fakeDb();
        await WorkItemRepository.listPaginated(db, ctx, {
            filters: { linkedEntityType: 'LOCATION', linkedEntityId: 'loc-1' },
            cursor: Buffer.from(
                JSON.stringify({ createdAt: new Date().toISOString(), id: 't-1' }),
            ).toString('base64'),
        } as any);

        const where = db.task.findMany.mock.calls[0][0].where;
        if (where.AND) expect(Array.isArray(where.AND)).toBe(true);
        expect(JSON.stringify(where)).toContain('loc-1');
    });
});

describe('WorkItemRepository — writes stay tenant-scoped', () => {
    it('reads a single task through the tenant filter', async () => {
        const db = fakeDb();
        await WorkItemRepository.getById(db, ctx, 't-1');
        expect(db.task.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 't-1', tenantId: 'tenant-1' }),
            }),
        );
    });

    it('stamps tenantId on create', async () => {
        const db = fakeDb();
        await WorkItemRepository.create(db, ctx, { title: 'Spray north field' } as any);
        const arg = db.task.create.mock.calls[0][0];
        expect(arg.data.tenantId).toBe('tenant-1');
    });

    it('scopes bulk operations to the tenant AND the id list', async () => {
        // Break: a bulk update missing the tenant clause is a cross-tenant
        // write — the worst failure this layer can have.
        const db = fakeDb();
        await WorkItemRepository.bulkAssign(db, ctx, ['a', 'b'], 'user-9');
        await WorkItemRepository.bulkSetStatus(db, ctx, ['a', 'b'], 'DONE');
        await WorkItemRepository.bulkSetDueDate(db, ctx, ['a', 'b'], null);

        for (const call of db.task.updateMany.mock.calls) {
            expect(call[0].where).toEqual(
                expect.objectContaining({ tenantId: 'tenant-1', id: { in: ['a', 'b'] } }),
            );
        }
    });

    it('clears an assignee when passed null rather than skipping the write', async () => {
        // Break: treating null as "no change" makes un-assigning impossible
        // from the UI.
        const db = fakeDb();
        await WorkItemRepository.assign(db, ctx, 't-1', null);
        expect(db.task.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ assigneeUserId: null }) }),
        );
    });

    it('records a resolution and a completion time only for a TERMINAL status', async () => {
        // The terminal set is RESOLVED / CLOSED / CANCELED — DONE is not one.
        // Break: accepting a resolution on a non-terminal status would leave a
        // closing note on a task that is still open, and stamping completedAt
        // there would make every "how long did this take" metric wrong.
        const db = fakeDb();
        await WorkItemRepository.setStatus(db, ctx, 't-1', 'RESOLVED', 'Fixed in field');
        const terminal = db.task.update.mock.calls[0][0].data;
        expect(terminal.status).toBe('RESOLVED');
        expect(terminal.resolution).toBe('Fixed in field');
        expect(terminal.completedAt).toBeInstanceOf(Date);

        const db2 = fakeDb();
        await WorkItemRepository.setStatus(db2, ctx, 't-1', 'IN_PROGRESS', 'ignored');
        const open = db2.task.update.mock.calls[0][0].data;
        expect(open.completedAt).toBeNull();
        expect('resolution' in open).toBe(false);
    });

    it('returns null instead of writing when the task is not in this tenant', async () => {
        // Break: dropping the existence check turns setStatus into a
        // cross-tenant write by primary key.
        const db = fakeDb();
        db.task.findFirst.mockResolvedValue(null);

        expect(await WorkItemRepository.setStatus(db, ctx, 'other', 'RESOLVED')).toBeNull();
        expect(await WorkItemRepository.assign(db, ctx, 'other', 'u')).toBeNull();
        expect(db.task.update).not.toHaveBeenCalled();
    });
});

describe('WorkItemRepository — link counting', () => {
    it('returns zero for an empty control list without querying', async () => {
        // Break: an unguarded groupBy on an empty `in` list is a round trip
        // that can only return nothing.
        const db = fakeDb();
        const res = await WorkItemRepository.countLinkedToControls(db, ctx, []);
        expect(res).toEqual(expect.anything());
        expect(db.taskLink.groupBy).not.toHaveBeenCalled();
    });

    it('counts links for a single control within the tenant', async () => {
        const db = fakeDb();
        await WorkItemRepository.countLinkedToControl(db, ctx, 'ctrl-1');
        expect(JSON.stringify(db.task.count.mock.calls)).toContain('tenant-1');
    });
});

describe('sibling repositories', () => {
    it('lists task links scoped to the tenant', async () => {
        const db = fakeDb();
        await TaskLinkRepository.listByTask(db, ctx, 't-1');
        expect(db.taskLink.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ tenantId: 'tenant-1', taskId: 't-1' }),
            }),
        );
    });

    it('stamps tenantId when linking and scopes the unlink', async () => {
        const db = fakeDb();
        await TaskLinkRepository.link(db, ctx, 't-1', 'LOCATION', 'loc-1');
        expect(db.taskLink.create.mock.calls[0][0].data.tenantId).toBe('tenant-1');

        await TaskLinkRepository.unlink(db, ctx, 'link-1');
        // The tenant clause lives on the READ that gates the delete — the
        // delete itself is by primary key, which is only safe because of it.
        expect(db.taskLink.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ tenantId: 'tenant-1' }),
            }),
        );
        expect(db.taskLink.delete).toHaveBeenCalled();
    });

    it('lists comments and watchers for a task within the tenant', async () => {
        const db = fakeDb();
        await TaskCommentRepository.listByTask(db, ctx, 't-1');
        expect(db.taskComment.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ tenantId: 'tenant-1' }),
            }),
        );

        await TaskWatcherRepository.listByTask(db, ctx, 't-1');
        expect(db.taskWatcher.findMany).toHaveBeenCalled();
    });
});
