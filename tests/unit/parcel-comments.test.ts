/**
 * A MECHANISATOR's one screen — the two server reads behind it (#2474).
 *
 * `attachParcelIds` feeds the per-parcel counts on the map;
 * `listParcelComments` feeds the history under a tapped parcel. Repositories
 * are doubles so the merge, the ordering and the two caps are testable; the
 * batching is asserted on the CALLS, because "two queries regardless of queue
 * length" is the property that makes the field worth having at all.
 */
const mockDb = { parcel: { findFirst: jest.fn() } };

const linksByTasksMock = jest.fn();
const linesByTasksMock = jest.fn();
const taskIdsByParcelMock = jest.fn();
const opTaskIdsForParcelMock = jest.fn();
const commentsByTasksMock = jest.fn();
const resolutionsByIdsMock = jest.fn();

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: typeof mockDb) => unknown) => fn(mockDb),
}));
jest.mock('@/app-layer/repositories/WorkItemRepository', () => {
    const actual = jest.requireActual('@/app-layer/repositories/WorkItemRepository');
    return {
        ...actual,
        WorkItemRepository: {
            ...actual.WorkItemRepository,
            listResolutionsByIds: (...a: unknown[]) => resolutionsByIdsMock(...a),
        },
        TaskLinkRepository: {
            ...actual.TaskLinkRepository,
            listParcelIdsByTasks: (...a: unknown[]) => linksByTasksMock(...a),
            listTaskIdsByParcel: (...a: unknown[]) => taskIdsByParcelMock(...a),
        },
        TaskCommentRepository: {
            ...actual.TaskCommentRepository,
            listByTasks: (...a: unknown[]) => commentsByTasksMock(...a),
        },
    };
});
jest.mock('@/app-layer/repositories/ParcelRepository', () => {
    const actual = jest.requireActual('@/app-layer/repositories/ParcelRepository');
    return {
        ...actual,
        ParcelRepository: {
            ...actual.ParcelRepository,
            listOperationParcelIdsForTasks: (...a: unknown[]) => linesByTasksMock(...a),
            listOperationTaskIdsForParcel: (...a: unknown[]) => opTaskIdsForParcelMock(...a),
        },
    };
});

import { attachParcelIds, listParcelComments } from '@/app-layer/usecases/task';
import type { RequestContext } from '@/app-layer/types';

const ctx = {
    tenantId: 't1',
    userId: 'u1',
    role: 'MECHANISATOR',
    permissions: { canRead: true, canWrite: false, canAdmin: false },
    appPermissions: {},
} as unknown as RequestContext;

function comment(id: string, taskId: string, at: string, over: Record<string, unknown> = {}) {
    return {
        id,
        taskId,
        body: `body ${id}`,
        createdAt: new Date(at),
        createdByUserId: 'u9',
        createdBy: { id: 'u9', name: 'Иван', email: 'ivan@example.test' },
        task: { key: `T-${taskId}`, title: `task ${taskId}` },
        ...over,
    };
}

function resolution(taskId: string, at: string | null, over: Record<string, unknown> = {}) {
    return {
        id: taskId,
        key: `T-${taskId}`,
        title: `task ${taskId}`,
        resolution: `closed ${taskId}`,
        completedAt: at === null ? null : new Date(at),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.parcel.findFirst.mockResolvedValue({ id: 'p1' });
    linksByTasksMock.mockResolvedValue([]);
    linesByTasksMock.mockResolvedValue([]);
    taskIdsByParcelMock.mockResolvedValue([]);
    opTaskIdsForParcelMock.mockResolvedValue([]);
    commentsByTasksMock.mockResolvedValue([]);
    resolutionsByIdsMock.mockResolvedValue([]);
});

describe('attachParcelIds — the map badge counts (#2474)', () => {
    it('is TWO queries for the whole queue, not one per row', async () => {
        // The property the field exists for. A loop here would also trip the
        // D1 no-read-in-a-loop guardrail.
        const rows = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}` }));
        await attachParcelIds(ctx, rows);
        expect(linksByTasksMock).toHaveBeenCalledTimes(1);
        expect(linesByTasksMock).toHaveBeenCalledTimes(1);
        // Both received the whole id set.
        expect((linksByTasksMock.mock.calls[0][2] as string[])).toHaveLength(50);
    });

    it('unions BOTH sources, because a field operation reaches parcels by line', async () => {
        linksByTasksMock.mockResolvedValue([{ taskId: 't1', parcelId: 'p-link' }]);
        linesByTasksMock.mockResolvedValue([{ taskId: 't1', parcelId: 'p-line' }]);
        const [row] = await attachParcelIds(ctx, [{ id: 't1' }]);
        expect(row.parcelIds.sort()).toEqual(['p-line', 'p-link']);
    });

    it('deduplicates a parcel reached by both sources and by two products', async () => {
        linksByTasksMock.mockResolvedValue([{ taskId: 't1', parcelId: 'p9' }]);
        linesByTasksMock.mockResolvedValue([
            { taskId: 't1', parcelId: 'p9' },
            { taskId: 't1', parcelId: 'p9' },
        ]);
        const [row] = await attachParcelIds(ctx, [{ id: 't1' }]);
        expect(row.parcelIds).toEqual(['p9']);
    });

    it('gives a task with no parcels an EMPTY ARRAY, never a missing key', async () => {
        // The phone counts by iterating these; an absent field would have to
        // be told apart from an empty one at every call site.
        const [row] = await attachParcelIds(ctx, [{ id: 't1' }]);
        expect(row.parcelIds).toEqual([]);
        expect('parcelIds' in row).toBe(true);
    });

    it('keeps each row’s own ids apart', async () => {
        linksByTasksMock.mockResolvedValue([
            { taskId: 't1', parcelId: 'a' },
            { taskId: 't2', parcelId: 'b' },
        ]);
        const rows = await attachParcelIds(ctx, [{ id: 't1' }, { id: 't2' }]);
        expect(rows.map((r) => r.parcelIds)).toEqual([['a'], ['b']]);
    });

    it('issues NO query for an empty queue', async () => {
        const out = await attachParcelIds(ctx, []);
        expect(out).toEqual([]);
        expect(linksByTasksMock).not.toHaveBeenCalled();
        expect(linesByTasksMock).not.toHaveBeenCalled();
    });

    it('preserves the row it decorates', async () => {
        const rows = await attachParcelIds(ctx, [{ id: 't1', title: 'Пръскане' }]);
        expect(rows[0]).toMatchObject({ id: 't1', title: 'Пръскане' });
    });
});

describe('listParcelComments — the parcel history (#2474)', () => {
    it('merges comments and closing notes into ONE list, newest first', async () => {
        taskIdsByParcelMock.mockResolvedValue(['t1', 't2']);
        commentsByTasksMock.mockResolvedValue([comment('c1', 't1', '2026-03-02T00:00:00Z')]);
        resolutionsByIdsMock.mockResolvedValue([resolution('t2', '2026-03-05T00:00:00Z')]);

        const out = await listParcelComments(ctx, 'p1');
        expect(out.rows.map((r) => r.kind)).toEqual(['RESOLUTION', 'COMMENT']);
        expect(out.rows.map((r) => r.id)).toEqual(['resolution:t2', 'c1']);
    });

    it('a RESOLUTION names no author, because the column has none', async () => {
        // Deliberate: attributing the note to the assignee or the last
        // status-changer would name somebody the row does not identify.
        taskIdsByParcelMock.mockResolvedValue(['t2']);
        resolutionsByIdsMock.mockResolvedValue([resolution('t2', '2026-03-05T00:00:00Z')]);
        const [row] = (await listParcelComments(ctx, 'p1')).rows;
        expect(row.createdBy).toBeNull();
        expect(row.createdByUserId).toBeNull();
        expect(row.body).toBe('closed t2');
    });

    it('a COMMENT carries the same author shape /tasks/{id}/comments sends', async () => {
        taskIdsByParcelMock.mockResolvedValue(['t1']);
        commentsByTasksMock.mockResolvedValue([comment('c1', 't1', '2026-03-02T00:00:00Z')]);
        const [row] = (await listParcelComments(ctx, 'p1')).rows;
        expect(row.createdBy).toEqual({ id: 'u9', name: 'Иван', email: 'ivan@example.test' });
        expect(row.createdByUserId).toBe('u9');
        expect(row.taskKey).toBe('T-t1');
        expect(row.taskTitle).toBe('task t1');
    });

    it('a resolution with no completedAt falls back rather than being DROPPED', async () => {
        // A closing note with an approximate time is worth more than a missing
        // one, and `completedAt` can be null on a task carrying a resolution
        // without a terminal status.
        taskIdsByParcelMock.mockResolvedValue(['t2']);
        resolutionsByIdsMock.mockResolvedValue([resolution('t2', null)]);
        const out = await listParcelComments(ctx, 'p1');
        expect(out.rows).toHaveLength(1);
        expect(out.rows[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('both kinds read the SAME task set as the parcel-tasks route', async () => {
        // The two halves of one screen must not disagree about which tasks
        // touched the parcel.
        taskIdsByParcelMock.mockResolvedValue(['t1']);
        opTaskIdsForParcelMock.mockResolvedValue(['t9']);
        await listParcelComments(ctx, 'p1');
        expect((commentsByTasksMock.mock.calls[0][2] as string[]).sort()).toEqual(['t1', 't9']);
        expect((resolutionsByIdsMock.mock.calls[0][2] as string[]).sort()).toEqual(['t1', 't9']);
    });

    it('a parcel outside the tenant is a 404, not an empty history', async () => {
        mockDb.parcel.findFirst.mockResolvedValue(null);
        await expect(listParcelComments(ctx, 'nope')).rejects.toMatchObject({
            code: 'PARCEL_NOT_FOUND',
        });
        expect(commentsByTasksMock).not.toHaveBeenCalled();
    });

    it('a parcel with nothing recorded is 200 and empty', async () => {
        const out = await listParcelComments(ctx, 'p1');
        expect(out).toEqual({ rows: [], truncated: false });
    });

    it('truncated is set by the PAGE cap, and the extra rows are not returned', async () => {
        taskIdsByParcelMock.mockResolvedValue(['t1']);
        commentsByTasksMock.mockResolvedValue(
            Array.from({ length: 201 }, (_, i) =>
                comment(`c${i}`, 't1', `2026-03-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`),
            ),
        );
        const out = await listParcelComments(ctx, 'p1');
        expect(out.rows).toHaveLength(200);
        expect(out.truncated).toBe(true);
    });

    it('truncated is set by the upstream ID cap even when few rows come back', async () => {
        taskIdsByParcelMock.mockResolvedValue(Array.from({ length: 2000 }, (_, i) => `t${i}`));
        commentsByTasksMock.mockResolvedValue([comment('c1', 't0', '2026-03-02T00:00:00Z')]);
        const out = await listParcelComments(ctx, 'p1');
        expect(out.rows).toHaveLength(1);
        expect(out.truncated).toBe(true);
    });

    it('CONTROL: an ordinary history is not truncated', async () => {
        taskIdsByParcelMock.mockResolvedValue(['t1']);
        commentsByTasksMock.mockResolvedValue([comment('c1', 't1', '2026-03-02T00:00:00Z')]);
        const out = await listParcelComments(ctx, 'p1');
        expect(out.truncated).toBe(false);
    });

    it('orders on a TOTAL key, so the truncation boundary cannot move', async () => {
        // A treatment closes several tasks in the same millisecond.
        taskIdsByParcelMock.mockResolvedValue(['t1', 't2', 't3']);
        resolutionsByIdsMock.mockResolvedValue([
            resolution('t1', '2026-03-05T00:00:00Z'),
            resolution('t2', '2026-03-05T00:00:00Z'),
            resolution('t3', '2026-03-05T00:00:00Z'),
        ]);
        const first = (await listParcelComments(ctx, 'p1')).rows.map((r) => r.id);
        const again = (await listParcelComments(ctx, 'p1')).rows.map((r) => r.id);
        expect(first).toEqual(again);
        // Descending by id within the identical timestamp.
        expect(first).toEqual(['resolution:t3', 'resolution:t2', 'resolution:t1']);
    });
});
