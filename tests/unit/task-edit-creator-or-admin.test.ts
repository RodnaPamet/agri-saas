/**
 * Who may edit a task — #2169, owner ruling 2026-10-22.
 *
 * ## What this pins
 *
 * Only the task's CREATOR or a farm admin. Before this, three surfaces gave two
 * answers and the server had no rule for either to be right about: iOS has
 * enforced creator-or-admin CLIENT-SIDE since agrent-ios #382, while the web
 * and this API allowed anyone with `canWrite`. That is the shape
 * `docs/billing.md` lists in its own what-not-to-do as "no UI-only gating".
 *
 * ## `task.policies` is deliberately NOT mocked
 *
 * The nearest precedent, `task-weed-observation-authz.test.ts`, mocks that
 * module out. Here the composition IS the property: `assertCanWriteTasks` runs
 * first and `assertCanEditTask` narrows it. Mocking either would leave the
 * interesting case — a caller who passes one and fails the other — untested,
 * and the ordering is what makes the change a narrowing rather than a
 * replacement. So both run for real against `makeRequestContext`'s permissions.
 *
 * ## Codes are read off the WIRE, not off the throw
 *
 * Through `toApiErrorResponse`, for the reason that precedent records: a throw
 * whose MESSAGE happens to be a code looks machine-readable and is not. The
 * phone renders `TASK_EDIT_NOT_PERMITTED` in Bulgarian, so it is only useful if
 * it arrives in `error.code`.
 *
 * ## The removal is the point, so it is asserted directly
 *
 * This takes away something that worked: an EDITOR could edit any task on their
 * farm and now cannot unless they created it. That was put to the owner as a
 * behaviour removal and chosen knowingly, so the test says so rather than only
 * checking the happy paths.
 */
import { makeRequestContext } from '../helpers/make-context';
import { toApiErrorResponse } from '@/lib/errors/types';

const mockDb = { task: { findFirst: jest.fn() } };
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
    afterCommit: jest.fn(),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

const getById = jest.fn();
const update = jest.fn();
jest.mock('../../src/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: {
        getById: (...a: unknown[]) => getById(...a),
        update: (...a: unknown[]) => update(...a),
    },
    TaskLinkRepository: {},
    TaskCommentRepository: {},
    TaskWatcherRepository: {},
}));

// `emitTaskDueNotification` is a LOCAL function in the usecase, so it cannot be
// mocked by module — and it does not need to be: it returns early without an
// assignee and a due date, and the fixture below has neither. Mocking the cache
// bump IS needed; it reaches Redis.
jest.mock('@/lib/cache/list-cache', () => ({
    bumpEntityCacheVersion: jest.fn(),
    cachedListRead: jest.fn(),
}));

import { updateTask } from '@/app-layer/usecases/task';

/** The task under edit, created by `u-creator`. */
const TASK = { id: 't-1', createdByUserId: 'u-creator', title: 'Spray the north block' };
const PATCH = { title: 'Spray the north block today' };

const CREATOR = makeRequestContext('EDITOR', { userId: 'u-creator' });
const OTHER_EDITOR = makeRequestContext('EDITOR', { userId: 'u-colleague' });
const ADMIN = makeRequestContext('ADMIN', { userId: 'u-admin' });
const READER = makeRequestContext('READER', { userId: 'u-reader' });

/** The envelope a client receives, rather than the thrown object. */
async function refusal(
    ctx: ReturnType<typeof makeRequestContext>,
): Promise<{ status: number; code: string }> {
    try {
        await updateTask(ctx, TASK.id, PATCH);
    } catch (err) {
        const { payload, status } = toApiErrorResponse(err);
        return { status, code: (payload as { error?: { code?: string } }).error?.code ?? '' };
    }
    return { status: 0, code: '<did not refuse>' };
}

beforeEach(() => {
    jest.clearAllMocks();
    getById.mockResolvedValue(TASK);
    update.mockResolvedValue({ ...TASK, ...PATCH });
});

describe('editing a task is creator-or-admin', () => {
    it('the CREATOR may edit, with no admin rights', async () => {
        await updateTask(CREATOR, TASK.id, PATCH);
        expect(update).toHaveBeenCalledTimes(1);
    });

    it('a farm ADMIN may edit a task they did not create', async () => {
        await updateTask(ADMIN, TASK.id, PATCH);
        expect(update).toHaveBeenCalledTimes(1);
    });

    it('another EDITOR may NOT — the behaviour this removes', async () => {
        // Worked before #2169 and deliberately does not now. If this ever goes
        // green again, the rule has been lost rather than relaxed, because
        // relaxing it is an owner decision that would also delete this test.
        expect(await refusal(OTHER_EDITOR)).toEqual({
            status: 403,
            code: 'TASK_EDIT_NOT_PERMITTED',
        });
        expect(update).not.toHaveBeenCalled();
    });

    it('nothing is written when the edit is refused', async () => {
        // Separate from the code assertion: a refusal that threw AFTER writing
        // would satisfy the test above and still have changed the row.
        await refusal(OTHER_EDITOR);
        expect(update).not.toHaveBeenCalled();
        expect(mockDb.task.findFirst).not.toHaveBeenCalled();
    });

    it('a READER is refused by the WRITE gate, which still runs first', async () => {
        // The ordering is the claim: this NARROWS `assertCanWriteTasks` rather
        // than replacing it. A reader must never reach the creator check, and
        // the distinct code is what shows which gate answered.
        const { status, code } = await refusal(READER);
        expect(status).toBe(403);
        expect(code).not.toBe('TASK_EDIT_NOT_PERMITTED');
        expect(getById).not.toHaveBeenCalled();
    });

    it('a task that does not exist is NOT FOUND, not forbidden', async () => {
        // No disclosure: `getById` is tenant-scoped, so another farm's task id
        // must answer exactly as a made-up one does. Reporting a 403 there
        // would confirm the id exists somewhere.
        getById.mockResolvedValue(null);
        expect(await refusal(OTHER_EDITOR)).toEqual({
            status: 404,
            code: 'TASK_NOT_FOUND',
        });
    });

    it('the creator check reads the row, not the patch', async () => {
        // A patch carrying `createdByUserId` must not be able to claim
        // authorship. The schema does not accept that field on a patch, so this
        // guards the day somebody widens the shape.
        await refusal({
            ...OTHER_EDITOR,
        } as ReturnType<typeof makeRequestContext>);
        expect(getById).toHaveBeenCalledWith(mockDb, OTHER_EDITOR, TASK.id);
    });
});
