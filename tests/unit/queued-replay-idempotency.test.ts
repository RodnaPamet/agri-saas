/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirror runtime
 * contracts; the codebase's standard file-level disable for test doubles. */
/**
 * The two write paths the OUTBOX ALREADY QUEUES but that no endpoint dedupes.
 *
 * An audit of every mutating handler found FOUR that read `Idempotency-Key`.
 * That count is now FIVE — the journal-edit route joined it with #919/#920, and
 * this sentence said four until #924 measured it again. The outbox queues six
 * write paths — and two of them hit endpoints in neither set. Neither mints a duplicate ROW, so neither
 * looked broken; each was protected by something that is not idempotency, and
 * each had a real hole underneath.
 *
 *   1. POST /tasks/:id/status — safe only SEQUENTIALLY, and by ACCIDENT. The
 *      state machine rejected from === to as a no-op, so a serial replay 400d
 *      and the outbox DROPPED it — exactly once, via a gate that meant
 *      something else. #923 replaced that with an explicit already-applied arm
 *      returning 200, because a 400 that means "already landed" and a 400 that
 *      means "refused" cannot both be true once a refused write stops being
 *      destroyed silently. But on reconnect the SAME queued item is drained CONCURRENTLY
 *      by the in-page sender AND the SW background sync (journal.ts documents
 *      this and solves it with an advisory lock). Under READ COMMITTED both
 *      drains read the PRE-state, both pass the gate, both write, and both
 *      logEvent — TWO TASK_STATUS_CHANGED rows in a hash-chained compliance
 *      audit trail for ONE operator action. The row is not duplicated; the
 *      HISTORY is, which is worse, because that is what an auditor reads.
 *
 *   2. PATCH /field-operations/:taskId/parcels/:lineId — protected by If-Match
 *      optimistic locking, not idempotency. A replay after a lost response
 *      carries the version the operator saw BEFORE their own write landed, so
 *      the check fails ON THEIR OWN SUCCESS and the outbox parked a conflict
 *      asking them to resolve keep-mine versus take-server AGAINST THEMSELVES.
 */
const mockDb: any = {
    $executeRaw: jest.fn(async () => 1),
    task: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    operationParcel: { findFirst: jest.fn(), updateMany: jest.fn(), count: jest.fn(async () => 1) },
    logEntry: { update: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: any, fn: any) => fn(mockDb),
}));
const logEvent = jest.fn();
jest.mock('../../src/app-layer/events/audit', () => ({ logEvent: (...a: any[]) => logEvent(...a) }));
jest.mock('../../src/app-layer/automation', () => ({ emitAutomationEvent: jest.fn() }));
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));
// The success path continues into the inventory/journal side effects, which is
// not what this file is about — but the CONTROL has to reach them, or "a normal
// write still writes" cannot be asserted at all.
jest.mock('../../src/app-layer/usecases/inventory', () => ({
    recordInputApplication: jest.fn(async () => null),
}));
jest.mock('../../src/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(), assertCanWrite: jest.fn(), assertCanAdmin: jest.fn(),
}));
jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (s: string) => s, sanitizeRichTextHtml: (s: string) => s,
}));
jest.mock('@/lib/observability', () => ({
    traceAgUsecase: (_n: string, _c: any, fn: any) => fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { markOperationParcel } from '@/app-layer/usecases/field-operation';
import { setTaskStatus } from '@/app-layer/usecases/task';

const CTX: any = { tenantId: 'tenant-1', userId: 'user-1', permissions: { canWrite: true } };

function lineAt(version: number, status: string) {
    return {
        id: 'line-1', tenantId: 'tenant-1', parcelId: 'p1', version, status,
        doseValue: 2, targetNote: null,
        task: { id: 't1', assigneeUserId: 'user-1', status: 'IN_PROGRESS', key: 'OP-1', applicationTechnique: null },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.operationParcel.updateMany.mockResolvedValue({ count: 1 });
});

describe('a replayed parcel mark is not a conflict with yourself', () => {
    it('returns success when the line ALREADY carries the status this write wanted', async () => {
        // The replay: the operator's own write landed and bumped 3 -> 4, and
        // the queued item still carries expectedVersion 3.
        mockDb.operationParcel.findFirst.mockResolvedValue(lineAt(4, 'DONE'));

        const res: any = await markOperationParcel(CTX, 't1', 'line-1', 'DONE' as any, undefined, 3);

        expect(res.success).toBe(true);
        expect(res.alreadyApplied).toBe(true);
        // Version reported is the SERVER's, so the client syncs to truth.
        expect(res.version).toBe(4);
    });

    it('writes NO second audit row for that replay', async () => {
        // The whole point. A duplicated OPERATION_PARCEL_MARKED row is a
        // duplicated compliance record.
        mockDb.operationParcel.findFirst.mockResolvedValue(lineAt(4, 'DONE'));
        await markOperationParcel(CTX, 't1', 'line-1', 'DONE' as any, undefined, 3);
        expect(logEvent).not.toHaveBeenCalled();
        expect(mockDb.operationParcel.updateMany).not.toHaveBeenCalled();
    });

    it('does NOT re-trigger the БАБХ farm-record regeneration', async () => {
        // `resolved` must be false on the replay path, or one operator action
        // enqueues the ДНЕВНИК rebuild twice.
        mockDb.operationParcel.findFirst.mockResolvedValue(lineAt(4, 'DONE'));
        const res: any = await markOperationParcel(CTX, 't1', 'line-1', 'DONE' as any, undefined, 3);
        expect(res.resolved).toBe(false);
    });

    it('STILL 409s when somebody else moved the line somewhere ELSE', async () => {
        // The control, and the reason this is narrow: a genuine conflict — a
        // supervisor set SKIPPED while the operator queued DONE — must still
        // reach the operator as a conflict to resolve. Without this the change
        // would silently swallow every stale write.
        mockDb.operationParcel.findFirst.mockResolvedValue(lineAt(4, 'SKIPPED'));
        await expect(
            markOperationParcel(CTX, 't1', 'line-1', 'DONE' as any, undefined, 3),
        ).rejects.toMatchObject({ code: 'STALE_DATA' });
    });

    it('CONTROL: a normal first write still performs the update and logs', async () => {
        // Without this every assertion above holds for a build that never
        // writes anything at all.
        mockDb.operationParcel.findFirst.mockResolvedValue(lineAt(3, 'PENDING'));
        await markOperationParcel(CTX, 't1', 'line-1', 'DONE' as any, undefined, 3);
        expect(mockDb.operationParcel.updateMany).toHaveBeenCalledTimes(1);
        expect(logEvent).toHaveBeenCalled();
    });
});

describe('concurrent drains of a queued status change are serialised', () => {
    // What this CAN and CANNOT assert, stated plainly: a Postgres advisory
    // lock cannot be exercised without Postgres, so this does not prove two
    // real transactions serialise — tests/integration/ is where that belongs.
    //
    // What it DOES pin is the thing that would silently regress: that a lock is
    // taken AT ALL, and taken BEFORE the status is read. A lock acquired after
    // the read serialises nothing, and is indistinguishable from a correct one
    // by any assertion that only checks it was called.
    const order: string[] = [];

    beforeEach(() => {
        order.length = 0;
        mockDb.$executeRaw.mockImplementation(async () => { order.push('lock'); return 1; });
        mockDb.task.findFirst.mockImplementation(async () => {
            order.push('read');
            return { id: 't1', tenantId: 'tenant-1', status: 'OPEN', assigneeUserId: 'user-1', key: 'TSK-1', type: 'FARM_TASK' };
        });
        mockDb.task.update.mockResolvedValue({ id: 't1', status: 'RESOLVED', key: 'TSK-1', title: 'x' });
    });

    it('takes the advisory lock BEFORE reading the current status', async () => {
        await setTaskStatus(CTX, 't1', 'RESOLVED', 'done in the field').catch(() => {});
        expect(order[0]).toBe('lock');
        expect(order).toContain('read');
    });

    it('keys the lock on the tenant AND the task', async () => {
        // A lock keyed on the tenant alone would serialise every status change
        // in the tenant — correct but a throughput cliff. Keyed on the task
        // alone it would collide across tenants.
        await setTaskStatus(CTX, 't1', 'RESOLVED', 'done in the field').catch(() => {});
        const args = mockDb.$executeRaw.mock.calls[0];
        const flat = JSON.stringify(args);
        expect(flat).toContain('tenant-1');
        expect(flat).toContain('t1');
    });
});
