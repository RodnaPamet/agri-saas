/**
 * Who may record a weed observation from inside a task, and on which parcel.
 *
 * ## What this pins
 *
 * Owner decision 2026-10-08: a mechanisator closing their own task records the
 * weeds they met. `createParcelWeedObservation` previously began with
 * `assertCanWrite`, so a MECHANISATOR — who has `canWrite: false` — got a 403
 * on the only write the task-closing form makes. The widening is scoped: the
 * task id bounds it, and the parcel must be one the task actually touches.
 *
 * Three properties, and the test exists for all three because each fails
 * differently and two of them fail SILENTLY:
 *
 *   1. an assigned caller with no general write CAN post (the feature);
 *   2. an unassigned caller still cannot (a widening that over-widens looks
 *      identical from the client that was already allowed);
 *   3. the parcel must be on the task (a widening with no scope reads as
 *      working perfectly until someone posts to a neighbour's field).
 *
 * ## Why the real `taskParcelIds` runs here
 *
 * The repositories are mocked; `taskParcelIds` is NOT. That is deliberate and
 * it is the point of the "reached only by an operation line" case below.
 *
 * I promised the iOS client that the parcel set has ONE definition — the check
 * uses the same resolution as `GET /tasks/{taskId}/parcels` — so that the
 * parcels a client can draw on the map are exactly the parcels it can post
 * against. The way that promise rots is somebody re-deriving the set here with
 * only `TaskLinkRepository.listParcelIdsByTask`, which is the obvious
 * implementation and is wrong for every field operation. Mocking
 * `taskParcelIds` would make that rot invisible; letting it run means the case
 * below fails if the two definitions ever diverge.
 *
 * ## Codes are read off the wire, not off the throw
 *
 * Through `toApiErrorResponse`, for the reason
 * `farm-creation-error-codes.test.ts` documents: a throw whose MESSAGE is a
 * code looks machine-readable and is not. `PARCEL_NOT_ON_TASK` is only useful
 * if it arrives in `error.code`.
 */
import { makeRequestContext } from '../helpers/make-context';
import { toApiErrorResponse } from '@/lib/errors/types';

const mockDb = {
    parcel: { findFirst: jest.fn() },
    parcelWeedObservation: { create: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

const findBareById = jest.fn();
const listParcelIdsByTask = jest.fn();
jest.mock('../../src/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: { findBareById: (...a: unknown[]) => findBareById(...a) },
    TaskLinkRepository: { listParcelIdsByTask: (...a: unknown[]) => listParcelIdsByTask(...a) },
    TaskCommentRepository: {},
    TaskWatcherRepository: {},
}));

const listOperationParcelIdsForTask = jest.fn();
jest.mock('../../src/app-layer/repositories/ParcelRepository', () => ({
    ParcelRepository: {
        listOperationParcelIdsForTask: (...a: unknown[]) => listOperationParcelIdsForTask(...a),
        listSummariesByIds: jest.fn(),
    },
}));

jest.mock('../../src/app-layer/policies/task.policies', () => ({
    assertCanReadTasks: jest.fn(),
    assertCanWriteTasks: jest.fn(),
    assertCanCommentOnTasks: jest.fn(),
}));

import { createParcelWeedObservation } from '@/app-layer/usecases/parcel-history';

/** The mechanisator standing in the field: assigned, and no general write. */
const MECHANISATOR = makeRequestContext('MECHANISATOR', { userId: 'u-mech' });
const EDITOR = makeRequestContext('EDITOR', { userId: 'u-editor' });

const BODY = {
    parcelId: 'p-on-task',
    observedAt: new Date('2026-10-08T08:00:00.000Z'),
    weeds: ['паламида'],
    notes: null,
};

/** The envelope a client receives, rather than the thrown object. */
async function refusal(
    ctx: ReturnType<typeof makeRequestContext>,
    input: typeof BODY,
    scope?: { taskId: string },
): Promise<{ status: number; code: string }> {
    try {
        await createParcelWeedObservation(ctx, input, scope);
    } catch (err) {
        const { payload, status } = toApiErrorResponse(err);
        return { status, code: payload.error.code };
    }
    throw new Error('expected a refusal, and the call succeeded');
}

beforeEach(() => {
    findBareById.mockReset().mockResolvedValue({
        id: 't1',
        type: 'FIELD_OPERATION',
        assigneeUserId: 'u-mech',
    });
    listParcelIdsByTask.mockReset().mockResolvedValue(['p-on-task']);
    listOperationParcelIdsForTask.mockReset().mockResolvedValue([]);
    mockDb.parcel.findFirst.mockReset().mockResolvedValue({
        id: 'p-on-task',
        name: 'Нива 1',
        cropType: 'wheat',
    });
    mockDb.parcelWeedObservation.create
        .mockReset()
        .mockImplementation(({ data }: { data: object }) => ({ id: 'wo-1', ...data }));
});

describe('the assignee self-serve rule', () => {
    it('an ASSIGNED mechanisator with no general write CAN record an observation', async () => {
        // The feature. Before the widening this threw the canonical 403.
        expect(MECHANISATOR.permissions.canWrite).toBe(false);

        const row = await createParcelWeedObservation(MECHANISATOR, BODY, { taskId: 't1' });

        expect(row.id).toBe('wo-1');
        expect(mockDb.parcelWeedObservation.create).toHaveBeenCalledTimes(1);
    });

    it('an UNASSIGNED mechanisator is still refused, and writes nothing', async () => {
        // The over-widening case. A client that was already allowed cannot tell
        // this apart from the case above, so nothing but a test notices.
        findBareById.mockResolvedValue({
            id: 't1',
            type: 'FIELD_OPERATION',
            assigneeUserId: 'someone-else',
        });

        const r = await refusal(MECHANISATOR, BODY, { taskId: 't1' });

        expect(r.status).toBe(403);
        expect(mockDb.parcelWeedObservation.create).not.toHaveBeenCalled();
    });

    it('a null assignee does not match a null caller', async () => {
        // `!!ctx.userId &&` guards this. An unassigned task has
        // `assigneeUserId: null`, and a context with no user has
        // `userId: undefined` — a loose comparison of two absent values would
        // make an UNASSIGNED task writable by ANYONE.
        findBareById.mockResolvedValue({ id: 't1', type: 'FIELD_OPERATION', assigneeUserId: null });
        const anon = makeRequestContext('MECHANISATOR', { userId: undefined });

        const r = await refusal(anon, BODY, { taskId: 't1' });

        expect(r.status).toBe(403);
        expect(mockDb.parcelWeedObservation.create).not.toHaveBeenCalled();
    });
});

describe('the parcel must be on the task', () => {
    it('an assignee posting an off-task parcel gets PARCEL_NOT_ON_TASK, not a write', async () => {
        // This is the SCOPE. Without it, "assigned to one task" silently means
        // "may write to every parcel in the farm".
        const r = await refusal(
            MECHANISATOR,
            { ...BODY, parcelId: 'p-elsewhere' },
            { taskId: 't1' },
        );

        expect(r.code).toBe('PARCEL_NOT_ON_TASK');
        expect(r.status).toBe(400);
        expect(mockDb.parcelWeedObservation.create).not.toHaveBeenCalled();
    });

    it('a PRIVILEGED caller is checked too — the scope is not only for assignees', async () => {
        // An EDITOR has general write and would pass gate 1, so it would be
        // easy to apply gate 2 only in the assignee branch. For a privileged
        // caller the check is a correctness one: a mis-addressed post is a
        // client bug worth reporting, not a row to file against the wrong
        // field.
        expect(EDITOR.permissions.canWrite).toBe(true);

        const r = await refusal(EDITOR, { ...BODY, parcelId: 'p-elsewhere' }, { taskId: 't1' });

        expect(r.code).toBe('PARCEL_NOT_ON_TASK');
        expect(mockDb.parcelWeedObservation.create).not.toHaveBeenCalled();
    });

    it('a parcel reached ONLY by an operation line is accepted', async () => {
        // The anti-drift case, and the reason the real `taskParcelIds` runs in
        // this file. A re-derivation using only `listParcelIdsByTask` — the
        // obvious implementation — refuses this, which would mean every field
        // operation's own parcels were un-postable while the map drew them.
        listParcelIdsByTask.mockResolvedValue([]);
        listOperationParcelIdsForTask.mockResolvedValue(['p-line', 'p-line']);
        mockDb.parcel.findFirst.mockResolvedValue({
            id: 'p-line',
            name: 'Нива 2',
            cropType: 'maize',
        });

        const row = await createParcelWeedObservation(
            MECHANISATOR,
            { ...BODY, parcelId: 'p-line' },
            { taskId: 't1' },
        );

        expect(row.id).toBe('wo-1');
        expect(listOperationParcelIdsForTask).toHaveBeenCalled();
    });

    it('control: the off-task fixture is genuinely absent from both sources', async () => {
        // Otherwise the two refusals above would pass against a parcel that was
        // on the task all along, refused for some other reason.
        expect(await listParcelIdsByTask()).not.toContain('p-elsewhere');
        expect(await listOperationParcelIdsForTask()).not.toContain('p-elsewhere');
    });
});

describe('the task gate', () => {
    it('a task that does not exist is TASK_NOT_FOUND, before any permission verdict', async () => {
        // Ordering matters: a 403 here would tell an unprivileged caller
        // nothing, but it would also mean a typo'd id read as a permission
        // problem in the client's logs.
        findBareById.mockResolvedValue(null);

        const r = await refusal(MECHANISATOR, BODY, { taskId: 'nope' });

        expect(r.code).toBe('TASK_NOT_FOUND');
        expect(r.status).toBe(404);
        expect(mockDb.parcelWeedObservation.create).not.toHaveBeenCalled();
    });
});

describe('the UNSCOPED path is unchanged', () => {
    it('without a scope a mechanisator is still refused, and no task is read', async () => {
        // The widening must be opt-in. `POST /agro/parcels/{id}/weed-observations`
        // has no task to bound it, so it keeps requiring general write — and
        // the proof it kept it is that the task was never even consulted.
        const r = await refusal(MECHANISATOR, BODY);

        expect(r.status).toBe(403);
        expect(findBareById).not.toHaveBeenCalled();
        expect(mockDb.parcelWeedObservation.create).not.toHaveBeenCalled();
    });

    it('without a scope an editor still succeeds', async () => {
        // The other half: the pre-flight check was not simply deleted.
        const row = await createParcelWeedObservation(EDITOR, BODY);
        expect(row.id).toBe('wo-1');
        expect(findBareById).not.toHaveBeenCalled();
    });
});
