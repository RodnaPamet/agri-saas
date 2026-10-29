/**
 * A parcel's task history — #2463, contract agreed with agrent-ios.
 *
 * The repositories are doubles and `withMayDelete` runs for real, because the
 * flag is the part a client acts on.
 *
 * ## The case this endpoint exists for
 *
 * `GET /tasks?linkedEntityType=PARCEL` answers with the scouting and the
 * hand-made tasks and silently omits every planned spray and fertilising: a
 * field operation reaches its parcels through its operation LINES, not through
 * a `PARCEL` task link. So the first test below is the whole justification —
 * a task reachable ONLY through a line must appear. Without it, every other
 * case here would pass against the filter this route replaces.
 */
const mockDb = {
    parcel: { findFirst: jest.fn() },
};

const linkIdsMock = jest.fn();
const lineIdsMock = jest.fn();
const rowsByIdsMock = jest.fn();

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: typeof mockDb) => unknown) => fn(mockDb),
}));
jest.mock('@/app-layer/repositories/WorkItemRepository', () => {
    const actual = jest.requireActual('@/app-layer/repositories/WorkItemRepository');
    return {
        ...actual,
        WorkItemRepository: { ...actual.WorkItemRepository, listRowsByIds: (...a: unknown[]) => rowsByIdsMock(...a) },
        TaskLinkRepository: { ...actual.TaskLinkRepository, listTaskIdsByParcel: (...a: unknown[]) => linkIdsMock(...a) },
    };
});
jest.mock('@/app-layer/repositories/ParcelRepository', () => {
    const actual = jest.requireActual('@/app-layer/repositories/ParcelRepository');
    return {
        ...actual,
        ParcelRepository: {
            ...actual.ParcelRepository,
            listOperationTaskIdsForParcel: (...a: unknown[]) => lineIdsMock(...a),
        },
    };
});

import { listTasksForParcel, parcelTaskIds } from '@/app-layer/usecases/task';
import type { RequestContext } from '@/app-layer/types';

const ctx = {
    tenantId: 't1',
    userId: 'u1',
    role: 'ADMIN',
    permissions: { canRead: true, canWrite: true, canAdmin: true },
    appPermissions: {},
} as unknown as RequestContext;

/** A row as `taskListSelect` returns it — the two mayDelete inputs included. */
function row(id: string, over: Record<string, unknown> = {}) {
    return {
        id,
        key: `T-${id}`,
        title: `task ${id}`,
        type: 'TASK',
        status: 'OPEN',
        severity: null,
        priority: 'MEDIUM',
        dueAt: null,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        completedAt: null,
        updatedAt: new Date('2026-10-01T00:00:00Z'),
        assignee: null,
        assigneeUserId: null,
        createdByUserId: 'u1',
        treatmentGroupId: null,
        ...over,
    };
}

/**
 * The row pool the `listRowsByIds` double serves from.
 *
 * **It HONOURS the ids it is handed**, and that is not tidiness. A double
 * returning a fixed array regardless of its argument cannot express "the id
 * never reached the query" — measured: with such a double, the mutation that
 * drops the parcel-LINK source entirely passed 22/22, because the control test
 * got its row back without the id having been asked for. A double that cannot
 * produce the failing input is a control that cannot express failure.
 */
const pool = new Map<string, ReturnType<typeof row>>();

beforeEach(() => {
    jest.clearAllMocks();
    pool.clear();
    mockDb.parcel.findFirst.mockResolvedValue({ id: 'p1' });
    linkIdsMock.mockResolvedValue([]);
    lineIdsMock.mockResolvedValue([]);
    rowsByIdsMock.mockImplementation(
        async (_db: unknown, _ctx: unknown, ids: string[], opts: { take: number }) =>
            ids.map((id) => pool.get(id)).filter(Boolean).slice(0, opts.take),
    );
});

/** Put rows in the pool; the double serves whichever of them are asked for. */
function seed(...rows: Array<ReturnType<typeof row>>) {
    for (const r of rows) pool.set(r.id, r);
}

describe('a field operation is reachable ONLY through its lines (#2463)', () => {
    it('returns a task that has NO parcel link but does have an operation line', async () => {
        // The justification for the whole endpoint. `linkedEntityType=PARCEL`
        // cannot see this task.
        linkIdsMock.mockResolvedValue([]);
        lineIdsMock.mockResolvedValue(['spray-1']);
        seed(row('spray-1', { type: 'FIELD_OPERATION' }))

        const out = await listTasksForParcel(ctx, 'p1');
        expect(out.rows.map((r) => r.id)).toEqual(['spray-1']);
        // And the id really came from the line source.
        expect(rowsByIdsMock.mock.calls[0][2]).toEqual(['spray-1']);
    });

    it('CONTROL: a link-only task is returned too, so the union is not line-only', async () => {
        linkIdsMock.mockResolvedValue(['scout-1']);
        lineIdsMock.mockResolvedValue([]);
        seed(row('scout-1'))
        const out = await listTasksForParcel(ctx, 'p1');
        expect(out.rows.map((r) => r.id)).toEqual(['scout-1']);
    });

    it('reads BOTH sources on every call, not one conditionally', async () => {
        await listTasksForParcel(ctx, 'p1');
        expect(linkIdsMock).toHaveBeenCalledTimes(1);
        expect(lineIdsMock).toHaveBeenCalledTimes(1);
    });
});

describe('deduplication (#2463)', () => {
    it('a task that is BOTH linked and on a line appears once', async () => {
        linkIdsMock.mockResolvedValue(['a']);
        lineIdsMock.mockResolvedValue(['a']);
        const { ids } = await parcelTaskIds({} as never, ctx, 'p1');
        expect(ids).toEqual(['a']);
    });

    it('one job with two products on this parcel appears once', async () => {
        // `OperationParcel` is unique per (task, parcel, product), so the line
        // source returns the same taskId twice by design.
        linkIdsMock.mockResolvedValue([]);
        lineIdsMock.mockResolvedValue(['spray-1', 'spray-1']);
        const { ids } = await parcelTaskIds({} as never, ctx, 'p1');
        expect(ids).toEqual(['spray-1']);
    });
});

describe('truncation is reported from BOTH bounds (#2463)', () => {
    it('the rendered page cap sets truncated, and the extra row is not returned', async () => {
        const ids = Array.from({ length: 201 }, (_, i) => `t${i}`);
        linkIdsMock.mockResolvedValue(ids);
        rowsByIdsMock.mockResolvedValue(ids.map((i) => row(i)));

        const out = await listTasksForParcel(ctx, 'p1');
        expect(out.truncated).toBe(true);
        expect(out.rows).toHaveLength(200);
        // The probe asks for one MORE than the page, which is what makes the
        // boundary detectable without a second COUNT.
        expect(rowsByIdsMock.mock.calls[0][3]).toEqual({ take: 201 });
    });

    it('the ID read cap sets truncated even when few rows come back', async () => {
        // The bound a client would never otherwise see: the history was cut
        // upstream, so the row count is small and complete-looking.
        linkIdsMock.mockResolvedValue(Array.from({ length: 2000 }, (_, i) => `l${i}`));
        seed(row('l0'))

        const out = await listTasksForParcel(ctx, 'p1');
        expect(out.rows).toHaveLength(1);
        expect(out.truncated).toBe(true);
    });

    it('CONTROL: an ordinary history is NOT truncated', async () => {
        // Without this, every case above passes for an implementation that
        // always reports truncation.
        linkIdsMock.mockResolvedValue(['a', 'b']);
        seed(row('a'), row('b'))
        const out = await listTasksForParcel(ctx, 'p1');
        expect(out.truncated).toBe(false);
        expect(out.rows).toHaveLength(2);
    });
});

describe('mayDelete is always computed here (#2463 + #2406)', () => {
    it('is present on every row, never omitted', async () => {
        // The #2406 hazard cannot arise on this path: it does not cache, so
        // `taskListSelect` always projects the two inputs. Asserted as the KEY
        // being present, because `toBeUndefined` would pass for an absent one.
        linkIdsMock.mockResolvedValue(['a']);
        seed(row('a'))
        const out = await listTasksForParcel(ctx, 'p1');
        expect('mayDelete' in out.rows[0]).toBe(true);
        expect(out.rows[0].mayDelete).toBe(true);
    });

    it('a task in a treatment group is a denial, and the inputs are stripped', async () => {
        linkIdsMock.mockResolvedValue(['a']);
        seed(row('a', { treatmentGroupId: 'tg-1' }))
        const out = await listTasksForParcel(ctx, 'p1');
        expect(out.rows[0].mayDelete).toBe(false);
        expect('createdByUserId' in out.rows[0]).toBe(false);
        expect('treatmentGroupId' in out.rows[0]).toBe(false);
    });
});

describe('the parcel, and what a missing one means (#2463)', () => {
    it('a parcel outside the tenant is a 404, not an empty list', async () => {
        // An empty list would read as "an untouched field" rather than "not
        // yours", and the id reads are tenant-scoped so that is exactly what
        // trusting the id would produce.
        mockDb.parcel.findFirst.mockResolvedValue(null);
        await expect(listTasksForParcel(ctx, 'nope')).rejects.toMatchObject({
            code: 'PARCEL_NOT_FOUND',
        });
    });

    it('refuses BEFORE reading any task source', async () => {
        mockDb.parcel.findFirst.mockResolvedValue(null);
        await expect(listTasksForParcel(ctx, 'nope')).rejects.toBeDefined();
        expect(linkIdsMock).not.toHaveBeenCalled();
        expect(lineIdsMock).not.toHaveBeenCalled();
    });

    it('a parcel that exists with no tasks is 200 and an empty list', async () => {
        // The other half of the split: "nothing recorded here yet" must be
        // distinguishable from "wrong id".
        const out = await listTasksForParcel(ctx, 'p1');
        expect(out).toEqual({ rows: [], truncated: false });
    });

    it('is scoped to the tenant and excludes soft-deleted parcels', async () => {
        await listTasksForParcel(ctx, 'p1');
        expect(mockDb.parcel.findFirst.mock.calls[0][0].where).toEqual({
            id: 'p1',
            tenantId: 't1',
            deletedAt: null,
        });
    });
});

describe('status is not filtered server-side (#2463)', () => {
    it('terminal statuses are returned, because the archive tab is the client’s', async () => {
        linkIdsMock.mockResolvedValue(['a', 'b', 'c']);
        seed(row('a', { status: 'RESOLVED' }),
            row('b', { status: 'CANCELED' }),
            row('c', { status: 'OPEN' }))
        const out = await listTasksForParcel(ctx, 'p1');
        expect(out.rows.map((r) => r.status)).toEqual(['RESOLVED', 'CANCELED', 'OPEN']);
    });
});
