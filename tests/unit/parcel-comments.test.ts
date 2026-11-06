/**
 * A MECHANISATOR's one screen — the two server reads behind it (#2474).
 *
 * `attachParcelIds` feeds the per-parcel counts on the map;
 * `listParcelComments` feeds the history under a tapped parcel. Repositories
 * are doubles so the merge, the ordering and the two caps are testable; the
 * batching is asserted on the CALLS, because "two queries regardless of queue
 * length" is the property that makes the field worth having at all.
 */
const mockDb = {
    parcel: { findFirst: jest.fn() },
    parcelComment: {
        findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn(),
    },
};

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

import { addParcelComment, attachParcelIds, deleteParcelComment, listParcelComments } from '@/app-layer/usecases/task';
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
    mockDb.parcelComment.findMany.mockResolvedValue([]);
    mockDb.parcelComment.findFirst.mockResolvedValue(null);
    mockDb.parcelComment.create.mockImplementation(({ data }: never) => ({ id: 'pc1', ...(data as object) }));
    mockDb.parcelComment.updateMany.mockResolvedValue({ count: 1 });
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

/**
 * Notes about the FIELD, tied to no task (owner ruling 2026-11-06).
 *
 * The properties worth pinning are the ones a reader of the merged list could
 * get wrong: that a `PARCEL` row carries no task, and that it is NOT filtered
 * by the task set — which is the whole reason the kind exists.
 */
describe('a note about the parcel itself', () => {
    const note = (id: string, at: string) => ({
        id,
        body: `note ${id}`,
        createdAt: new Date(at),
        createdByUserId: 'u7',
        createdBy: { id: 'u7', name: 'Петър', email: 'p@example.test' },
    });

    it('appears as kind PARCEL with NO task fields', async () => {
        mockDb.parcel.findFirst.mockResolvedValue({ id: 'p1' });
        taskIdsByParcelMock.mockResolvedValue([]);
        opTaskIdsForParcelMock.mockResolvedValue([]);
        commentsByTasksMock.mockResolvedValue([]);
        resolutionsByIdsMock.mockResolvedValue([]);
        mockDb.parcelComment.findMany.mockResolvedValue([note('n1', '2026-05-01T10:00:00Z')]);

        const res = await listParcelComments(ctx, 'p1');
        expect(res.rows).toHaveLength(1);
        const row = res.rows[0];
        expect(row.kind).toBe('PARCEL');
        // NULL, not '' — an empty taskKey would render as a task whose key
        // nobody set, which is a different claim from "there is no task".
        expect(row.taskId).toBeNull();
        expect(row.taskKey).toBeNull();
        expect(row.taskTitle).toBeNull();
        expect(row.body).toBe('note n1');
    });

    it('is NOT filtered by the task set — a parcel with no tasks still has notes', async () => {
        // The reason the kind exists. The other two sources are keyed on the
        // parcel's task ids; this one is keyed on the PARCEL.
        mockDb.parcel.findFirst.mockResolvedValue({ id: 'p1' });
        taskIdsByParcelMock.mockResolvedValue([]);
        opTaskIdsForParcelMock.mockResolvedValue([]);
        commentsByTasksMock.mockResolvedValue([]);
        resolutionsByIdsMock.mockResolvedValue([]);
        mockDb.parcelComment.findMany.mockResolvedValue([note('n1', '2026-05-01T10:00:00Z')]);

        const res = await listParcelComments(ctx, 'p1');
        expect(res.rows).toHaveLength(1);
        const where = mockDb.parcelComment.findMany.mock.calls[0][0].where;
        expect(where).toMatchObject({ tenantId: 't1', parcelId: 'p1' });
        // And emphatically NOT by task id.
        expect(where).not.toHaveProperty('taskId');
    });

    it('is read on the TENANT client, so the encrypted body decrypts', async () => {
        // `body` is in ENCRYPTED_FIELDS. A privileged read would hand back a
        // `v2:` envelope with no error and no log (#2723), so the assertion is
        // that this read happens on the client `runInTenantContext` provided.
        mockDb.parcel.findFirst.mockResolvedValue({ id: 'p1' });
        taskIdsByParcelMock.mockResolvedValue([]);
        opTaskIdsForParcelMock.mockResolvedValue([]);
        commentsByTasksMock.mockResolvedValue([]);
        resolutionsByIdsMock.mockResolvedValue([]);
        await listParcelComments(ctx, 'p1');
        expect(mockDb.parcelComment.findMany).toHaveBeenCalled();
    });

    it('sorts into the SAME chronological list as the other two kinds', async () => {
        mockDb.parcel.findFirst.mockResolvedValue({ id: 'p1' });
        taskIdsByParcelMock.mockResolvedValue(['t1']);
        opTaskIdsForParcelMock.mockResolvedValue([]);
        commentsByTasksMock.mockResolvedValue([comment('c1', 't1', '2026-05-02T10:00:00Z')]);
        resolutionsByIdsMock.mockResolvedValue([]);
        mockDb.parcelComment.findMany.mockResolvedValue([note('n1', '2026-05-03T10:00:00Z')]);

        const res = await listParcelComments(ctx, 'p1');
        // Newest first, across kinds — one history, not three lists.
        expect(res.rows.map((r) => r.kind)).toEqual(['PARCEL', 'COMMENT']);
    });
});

describe('writing a note', () => {
    const wctx = {
        ...ctx,
        role: 'EDITOR',
        permissions: { canRead: true, canWrite: true, canAdmin: false },
    } as unknown as RequestContext;

    beforeEach(() => {
        mockDb.parcel.findFirst.mockResolvedValue({ id: 'p1' });
    });

    it('stores a sanitised body', async () => {
        await addParcelComment(wctx, 'p1', '  Северният ъгъл се подмокря  ');
        const { data } = mockDb.parcelComment.create.mock.calls[0][0];
        expect(data.body).toBe('Северният ъгъл се подмокря');
        expect(data.parcelId).toBe('p1');
        expect(data.createdByUserId).toBe('u1');
    });

    it('refuses a body that is blank AFTER sanitising', async () => {
        // `sanitizePlainText` trims, so three spaces reach the check as ''. The
        // order matters: checking before sanitising would store '   '.
        await expect(addParcelComment(wctx, 'p1', '   ')).rejects.toMatchObject({
            code: 'PARCEL_COMMENT_EMPTY',
        });
        expect(mockDb.parcelComment.create).not.toHaveBeenCalled();
    });

    it('refuses an over-long body and names the ceiling', async () => {
        await expect(
            addParcelComment(wctx, 'p1', 'x'.repeat(2_001)),
        ).rejects.toMatchObject({ code: 'PARCEL_COMMENT_TOO_LONG' });
    });

    it('returns the ORIGINAL note on an idempotent replay', async () => {
        mockDb.parcelComment.findFirst.mockResolvedValue({ id: 'pc-original' });
        const res = await addParcelComment(wctx, 'p1', 'again', 'key-1');
        expect(res).toMatchObject({ id: 'pc-original' });
        // The point: no second row.
        expect(mockDb.parcelComment.create).not.toHaveBeenCalled();
        // And the lookup is keyed on the CALLER's key. The assertion above is
        // satisfied by a pre-read on any key at all, because a double returns
        // its row whatever the `where` says — so the key has to be read back.
        expect(mockDb.parcelComment.findFirst.mock.calls[0][0].where).toMatchObject({
            tenantId: 't1',
            parcelId: 'p1',
            clientMutationId: 'key-1',
        });
    });

    it('does NOT pre-read when the caller sent no key', async () => {
        await addParcelComment(wctx, 'p1', 'once');
        expect(mockDb.parcelComment.findFirst).not.toHaveBeenCalled();
        expect(mockDb.parcelComment.create).toHaveBeenCalled();
    });

    it('404s on a parcel that is not this farm\u2019s', async () => {
        mockDb.parcel.findFirst.mockResolvedValue(null);
        await expect(addParcelComment(wctx, 'nope', 'hi')).rejects.toMatchObject({
            code: 'PARCEL_NOT_FOUND',
        });
        expect(mockDb.parcelComment.create).not.toHaveBeenCalled();
    });
});

describe('removing a note', () => {
    const member = (role: string, userId: string, canAdmin: boolean) =>
        ({
            ...ctx,
            userId,
            role,
            permissions: { canRead: true, canWrite: true, canAdmin },
        }) as unknown as RequestContext;

    const author = member('EDITOR', 'u-author', false);
    const other = member('EDITOR', 'u-other', false);
    const admin = member('ADMIN', 'u-admin', true);

    const held = { id: 'pc9', createdByUserId: 'u-author' };

    it('lets the AUTHOR remove their own note, as a SOFT delete', async () => {
        mockDb.parcelComment.findFirst.mockResolvedValue(held);
        await deleteParcelComment(author, 'p1', 'pc9');

        // An UPDATE, not a delete: nothing in this usecase may call `delete`.
        expect(mockDb.parcelComment.updateMany).toHaveBeenCalled();
        const call = mockDb.parcelComment.updateMany.mock.calls[0][0];
        expect(call.data.deletedAt).toBeInstanceOf(Date);
        // Conditional on it still being live, so two concurrent deletes cannot
        // both claim the removal and write two audit entries for one act.
        expect(call.where).toMatchObject({ id: 'pc9', tenantId: 't1', deletedAt: null });
    });

    it('lets an ADMIN remove someone ELSE\u2019s note', async () => {
        mockDb.parcelComment.findFirst.mockResolvedValue(held);
        await deleteParcelComment(admin, 'p1', 'pc9');
        expect(mockDb.parcelComment.updateMany).toHaveBeenCalled();
    });

    it('refuses a non-admin member removing someone else\u2019s note', async () => {
        mockDb.parcelComment.findFirst.mockResolvedValue(held);
        await expect(deleteParcelComment(other, 'p1', 'pc9')).rejects.toMatchObject({
            code: 'PARCEL_COMMENT_NOT_FOUND',
        });
        expect(mockDb.parcelComment.updateMany).not.toHaveBeenCalled();
    });

    /**
     * The property is INDISTINGUISHABILITY, not "it was refused".
     *
     * Four causes must produce one observable, or the 404 confirms that a note
     * exists at an id the caller may not read. Asserting a 404 four times over
     * would pass just as happily on four different codes or messages, so this
     * runs all four and compares what came back.
     */
    it('answers all four refusals IDENTICALLY', async () => {
        const capture = async (prep: () => void, call: () => Promise<unknown>) => {
            jest.clearAllMocks();
            mockDb.parcelComment.updateMany.mockResolvedValue({ count: 1 });
            prep();
            try {
                await call();
                return { threw: false };
            } catch (e) {
                const err = e as { code?: string; status?: number; message?: string };
                return { threw: true, code: err.code, status: err.status, message: err.message };
            }
        };

        const missing = await capture(
            () => mockDb.parcelComment.findFirst.mockResolvedValue(null),
            () => deleteParcelComment(author, 'p1', 'nope'),
        );
        const alreadyGone = await capture(
            // The read filters `deletedAt: null`, so an already-removed note is
            // the same `null` the missing one produces.
            () => mockDb.parcelComment.findFirst.mockResolvedValue(null),
            () => deleteParcelComment(author, 'p1', 'pc9'),
        );
        const notMine = await capture(
            () => mockDb.parcelComment.findFirst.mockResolvedValue(held),
            () => deleteParcelComment(other, 'p1', 'pc9'),
        );
        const lostTheRace = await capture(
            () => {
                mockDb.parcelComment.findFirst.mockResolvedValue(held);
                mockDb.parcelComment.updateMany.mockResolvedValue({ count: 0 });
            },
            () => deleteParcelComment(author, 'p1', 'pc9'),
        );

        expect(missing.threw).toBe(true);
        expect(missing.code).toBe('PARCEL_COMMENT_NOT_FOUND');
        // Every observable, not just the code.
        expect(alreadyGone).toEqual(missing);
        expect(notMine).toEqual(missing);
        expect(lostTheRace).toEqual(missing);
    });

    it('refuses a READER outright, before any read', async () => {
        const reader = member('READER', 'u-author', false);
        await expect(deleteParcelComment(reader, 'p1', 'pc9')).rejects.toBeDefined();
        expect(mockDb.parcelComment.findFirst).not.toHaveBeenCalled();
    });

    it('scopes the lookup to the PARCEL in the path, not just the id', async () => {
        // Otherwise a note id from another parcel is removable by anyone who
        // can comment on this one.
        mockDb.parcelComment.findFirst.mockResolvedValue(held);
        await deleteParcelComment(author, 'p1', 'pc9');
        expect(mockDb.parcelComment.findFirst.mock.calls[0][0].where).toMatchObject({
            id: 'pc9', parcelId: 'p1', tenantId: 't1', deletedAt: null,
        });
    });
});

describe('a removed note', () => {
    it('is filtered out of the list by deletedAt', async () => {
        // Named explicitly: ParcelComment is NOT in SOFT_DELETE_TARGETS, so no
        // extension injects this and a dropped clause would resurrect every
        // removed note silently.
        mockDb.parcel.findFirst.mockResolvedValue({ id: 'p1' });
        taskIdsByParcelMock.mockResolvedValue([]);
        opTaskIdsForParcelMock.mockResolvedValue([]);
        commentsByTasksMock.mockResolvedValue([]);
        resolutionsByIdsMock.mockResolvedValue([]);
        await listParcelComments(ctx, 'p1');
        expect(mockDb.parcelComment.findMany.mock.calls[0][0].where).toMatchObject({
            tenantId: 't1', parcelId: 'p1', deletedAt: null,
        });
    });
});
