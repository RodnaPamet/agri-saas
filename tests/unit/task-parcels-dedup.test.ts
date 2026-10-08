/**
 * `listTaskParcels` returns each parcel ONCE, however many ways it is reached.
 *
 * ## The defect this pins before it can exist
 *
 * `OperationParcel` rows are per **(parcel, product)**, not per parcel — its
 * own schema comment records why: a spray job writes a soil-nurturing
 * fertilizer line AND a treatment product line for the same parcel, with
 * uniqueness per product. So a job with two products over three parcels is six
 * rows covering three parcels, and the obvious implementation —
 * `lines.map(l => l.parcelId)` — returns each parcel twice.
 *
 * That failure is nasty because of how it presents: a client building a `Set`
 * gets the right answer and never notices, while one building a list draws
 * every parcel's outline twice and labels its legend twice. Two clients, one
 * response, and only one of them looks broken.
 *
 * The second source makes it unavoidable rather than theoretical: a parcel can
 * be BOTH on an operation line and a `PARCEL` link, so even a per-source
 * `distinct` in SQL would not be enough — the union is where the duplicate
 * appears.
 *
 * ## Why a unit test with mocked repositories
 *
 * The behaviour under test is the SET ARITHMETIC in the usecase, and mocking
 * the two id sources is the only way to present the exact overlap that matters
 * (same parcel from both sources, plus a repeat within one source). An
 * integration test would have to construct a real spray job with two products
 * to produce the same input, and would then be testing the field-operation
 * write path as much as this read.
 *
 * What the mocks CANNOT see is whether the repositories really return
 * duplicates. That is asserted where it belongs: `listOperationParcelIdsForTask`
 * deliberately does not use `distinct`, and its docblock says so.
 */
import { makeRequestContext } from '../helpers/make-context';

const mockDb = {};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    // `unknown` rather than `any`: the lint ceiling counts SUPPRESSED findings,
    // so one `any` under a file-level disable costs exactly what a new warning
    // costs. A passthrough mock needs neither.
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));

const findBareById = jest.fn();
const listParcelIdsByTask = jest.fn();
jest.mock('../../src/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: { findBareById: (...a: unknown[]) => findBareById(...a) },
    TaskLinkRepository: { listParcelIdsByTask: (...a: unknown[]) => listParcelIdsByTask(...a) },
    TaskCommentRepository: {},
    TaskWatcherRepository: {},
}));

const listOperationParcelIdsForTask = jest.fn();
const listSummariesByIds = jest.fn();
jest.mock('../../src/app-layer/repositories/ParcelRepository', () => ({
    ParcelRepository: {
        listOperationParcelIdsForTask: (...a: unknown[]) => listOperationParcelIdsForTask(...a),
        listSummariesByIds: (...a: unknown[]) => listSummariesByIds(...a),
    },
}));

jest.mock('../../src/app-layer/policies/task.policies', () => ({
    assertCanReadTasks: jest.fn(),
    assertCanWriteTasks: jest.fn(),
    assertCanCommentOnTasks: jest.fn(),
}));

import { listTaskParcels } from '@/app-layer/usecases/task';

const ctx = makeRequestContext('EDITOR');

/** The ids the usecase actually asked the repository to resolve. */
function requestedIds(): string[] {
    expect(listSummariesByIds).toHaveBeenCalled();
    return listSummariesByIds.mock.calls[0][2] as string[];
}

beforeEach(() => {
    findBareById.mockReset().mockResolvedValue({ id: 't1', type: 'FIELD_OPERATION' });
    listParcelIdsByTask.mockReset().mockResolvedValue([]);
    listOperationParcelIdsForTask.mockReset().mockResolvedValue([]);
    listSummariesByIds.mockReset().mockResolvedValue([]);
});

describe('listTaskParcels deduplicates', () => {
    it('a two-product spray over three parcels resolves THREE parcels, not six', async () => {
        // Exactly the shape the schema comment describes: six rows, three parcels.
        listOperationParcelIdsForTask.mockResolvedValue([
            'p1', 'p2', 'p3', 'p1', 'p2', 'p3',
        ]);

        await listTaskParcels(ctx, 't1');

        expect(requestedIds()).toEqual(['p1', 'p2', 'p3']);
    });

    it('a parcel reached BOTH ways appears once — the union, not just each source', async () => {
        // This is the case a per-source `distinct` in SQL would NOT fix.
        listParcelIdsByTask.mockResolvedValue(['p1', 'p2']);
        listOperationParcelIdsForTask.mockResolvedValue(['p2', 'p3']);

        await listTaskParcels(ctx, 't1');

        const ids = requestedIds();
        expect(ids).toEqual(['p1', 'p2', 'p3']);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('control: the fixtures really do contain duplicates', () => {
        // Without this, both cases above would pass against fixtures that were
        // already unique — i.e. against a test that cannot fail.
        const lines = ['p1', 'p2', 'p3', 'p1', 'p2', 'p3'];
        expect(new Set(lines).size).toBeLessThan(lines.length);
        const linked = ['p1', 'p2'];
        const overlap = ['p2', 'p3'];
        expect(linked.some((id) => overlap.includes(id))).toBe(true);
    });
});

describe('listTaskParcels boundary behaviour', () => {
    it('a task that links no parcels asks for an empty set and returns []', async () => {
        const out = await listTaskParcels(ctx, 't1');
        expect(requestedIds()).toEqual([]);
        expect(out).toEqual([]);
    });

    it('a missing task throws rather than returning an empty list', async () => {
        // The 404 belongs to the TASK. If this returned [] a client could not
        // tell a typo in the id from a task with no parcels yet.
        findBareById.mockResolvedValue(null);
        await expect(listTaskParcels(ctx, 'nope')).rejects.toThrow();
        expect(listSummariesByIds).not.toHaveBeenCalled();
    });

    it('operation lines are read for EVERY task type, not only FIELD_OPERATION', async () => {
        // The usecase deliberately does not branch on `task.type`: only a field
        // operation has lines by construction, so this is an empty indexed read
        // for other types — and the branch it replaces would silently exclude a
        // future type that gains lines.
        findBareById.mockResolvedValue({ id: 't1', type: 'GENERAL' });
        await listTaskParcels(ctx, 't1');
        expect(listOperationParcelIdsForTask).toHaveBeenCalled();
    });
});
