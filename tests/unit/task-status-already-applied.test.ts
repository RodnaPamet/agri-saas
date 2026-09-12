/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirror runtime
 * contracts; the codebase's standard file-level disable for test doubles. */
/**
 * #923 prerequisite — a replayed status change that ALREADY LANDED returns 200,
 * not 400.
 *
 * The advisory lock in `setTaskStatus` serialises the two drains of one queued
 * item (the in-page sender and the service worker's background sync). The
 * loser re-reads the post-state and, until now, fell through to
 * `checkWorkItemTransition(RESOLVED, RESOLVED)` → no_op → 400, whereupon the
 * outbox DROPPED it. Exactly once — but by a gate that means something else.
 *
 * That accident has to end before #923 ships, because #923 stops a terminal
 * 4xx from destroying a queued write and starts telling the operator about it.
 * With the old behaviour the operator would be told their farm task did not go
 * through, and asked to re-enter a compliance record that IS already recorded.
 * One status code cannot mean both "refused" and "already landed" once
 * somebody acts on it.
 *
 * The arm mirrors `markOperationParcel` (field-operation.ts), which #913 gave
 * the same treatment for parcel marks.
 */
import { makeRequestContext } from '../helpers/make-context';

const mockDb: any = {
    $executeRaw: jest.fn(async () => 0),
    task: { update: jest.fn(), findFirst: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: any, fn: any) => fn(mockDb),
}));

const getById = jest.fn();
const setStatus = jest.fn();
jest.mock('../../src/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: {
        getById: (...a: any[]) => getById(...a),
        setStatus: (...a: any[]) => setStatus(...a),
    },
}));

const logEvent = jest.fn();
jest.mock('../../src/app-layer/events/audit', () => ({ logEvent: (...a: any[]) => logEvent(...a) }));
const emitAutomationEvent = jest.fn();
jest.mock('../../src/app-layer/automation', () => ({ emitAutomationEvent: (...a: any[]) => emitAutomationEvent(...a) }));
jest.mock('@/lib/cache/list-cache', () => ({ bumpEntityCacheVersion: jest.fn(), cachedListRead: jest.fn() }));
jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (v: string) => v,
    sanitizeRichTextHtml: (v: string) => v,
}));

import { setTaskStatus } from '../../src/app-layer/usecases/task';

const TASK = {
    id: 't1',
    tenantId: 'tenant-1',
    status: 'RESOLVED',
    resolution: 'sprayed and logged',
    assigneeUserId: 'user-1',
    key: 'TSK-1',
    type: 'FARM_TASK',
    title: 'Spray block 4',
};

describe('setTaskStatus — an already-applied replay', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getById.mockResolvedValue({ ...TASK });
        setStatus.mockResolvedValue({ ...TASK });
    });

    it('returns the current task instead of throwing a 400 no-op', async () => {
        const ctx = makeRequestContext('ADMIN', { userId: 'user-1' });
        // The SAME body the first, successful drain sent.
        const out = await setTaskStatus(ctx, 't1', 'RESOLVED', 'sprayed and logged');
        expect(out).toMatchObject({ id: 't1', status: 'RESOLVED' });
    });

    it('writes no second audit row and emits no second automation event', async () => {
        const ctx = makeRequestContext('ADMIN', { userId: 'user-1' });
        await setTaskStatus(ctx, 't1', 'RESOLVED', 'sprayed and logged');
        // The whole point: the task row was never duplicated, the HISTORY was,
        // and the history is what an auditor reads.
        expect(logEvent).not.toHaveBeenCalled();
        expect(emitAutomationEvent).not.toHaveBeenCalled();
        expect(setStatus).not.toHaveBeenCalled();
    });

    it('still takes the advisory lock before deciding', async () => {
        const ctx = makeRequestContext('ADMIN', { userId: 'user-1' });
        await setTaskStatus(ctx, 't1', 'RESOLVED', 'sprayed and logged');
        // Short-circuiting BEFORE the lock would reintroduce the race the lock
        // exists for: two drains could both read the pre-state and both write.
        expect(mockDb.$executeRaw).toHaveBeenCalled();
    });

    // CONTROL — the arm must not swallow a real transition.
    it('CONTROL: a genuine status change still writes and audits', async () => {
        getById.mockResolvedValue({ ...TASK, status: 'IN_PROGRESS', resolution: null });
        setStatus.mockResolvedValue({ ...TASK, status: 'RESOLVED' });
        const ctx = makeRequestContext('ADMIN', { userId: 'user-1' });
        await setTaskStatus(ctx, 't1', 'RESOLVED', 'sprayed and logged');
        expect(setStatus).toHaveBeenCalled();
        expect(logEvent).toHaveBeenCalled();
        expect(emitAutomationEvent).toHaveBeenCalled();
    });

    // CONTROL — the arm is gated on the resolution too, so it cannot convert a
    // visible error into a silent no-op that discards what the operator typed.
    // A same-status call carrying DIFFERENT text is not a replay.
    it('CONTROL: same status but changed resolution is NOT treated as a replay', async () => {
        const ctx = makeRequestContext('ADMIN', { userId: 'user-1' });
        await expect(setTaskStatus(ctx, 't1', 'RESOLVED', 'a different account of what happened')).rejects.toThrow();
        expect(logEvent).not.toHaveBeenCalled();
    });

    // CONTROL — authorization is decided before the short-circuit, or the arm
    // would hand a 200 to a caller who may not touch the task at all.
    it('CONTROL: a non-assignee without write permission is still refused', async () => {
        getById.mockResolvedValue({ ...TASK, assigneeUserId: 'someone-else' });
        const ctx = makeRequestContext('READER', { userId: 'user-1' });
        await expect(setTaskStatus(ctx, 't1', 'RESOLVED', 'sprayed and logged')).rejects.toThrow();
    });
});
