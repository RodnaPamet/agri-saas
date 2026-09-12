/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks and Prisma
 * client shims mirror runtime contracts; per-line typing has poor cost/benefit
 * in test files (the codebase's standard file-level disable). */
/**
 * Offline exactly-once — `createFieldOperation` idempotency.
 *
 * The offline outbox re-sends a queued spray job over flaky rural LTE with its
 * item id as the `Idempotency-Key`. The usecase must dedupe on
 * (tenantId, clientMutationId): a replay returns the ORIGINAL task with no
 * second Task row (and no second prescription set). These tests lock:
 *   1. replay with a known key short-circuits — createTask is never called;
 *   2. a create WITHOUT a key mints a task and stamps clientMutationId=null;
 *   3. a create WITH a fresh key stamps clientMutationId=key;
 *   4. a concurrent-replay P2002 race re-reads the winner instead of throwing.
 */
import { Prisma } from '@prisma/client';

// ── mock collaborators ────────────────────────────────────────────
const mockDb = {
    location: { findFirst: jest.fn() },
    item: { findFirst: jest.fn() },
    unit: { findUnique: jest.fn() },
    task: { findFirst: jest.fn(), update: jest.fn() },
    operationParcel: { count: jest.fn(), createMany: jest.fn() },
    // #931 serialises the line write with pg_advisory_xact_lock, the same
    // mechanism task.ts and journal.ts use. The double needs the surface or
    // every path through the second transaction dies on "not a function" —
    // which says nothing about the behaviour under test.
    $executeRaw: jest.fn(async () => 0),
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: any, fn: any) => fn(mockDb),
}));
const createTask = jest.fn();
jest.mock('../../src/app-layer/usecases/task', () => ({ createTask: (...a: any[]) => createTask(...a) }));
jest.mock('../../src/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(),
    assertCanWrite: jest.fn(),
    assertCanAdmin: jest.fn(),
}));
jest.mock('../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('../../src/app-layer/automation', () => ({ emitAutomationEvent: jest.fn() }));
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));
jest.mock('../../src/app-layer/repositories/ParcelRepository', () => ({
    ParcelRepository: { validIdsForLocation: jest.fn(async (_d: any, _c: any, _l: any, ids: string[]) => new Set(ids)) },
}));
jest.mock('../../src/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: {},
    TaskLinkRepository: { link: jest.fn() },
}));

import { createFieldOperation } from '../../src/app-layer/usecases/field-operation';

const ctx: any = { tenantId: 'tenant-1', userId: 'user-1', permissions: { canWrite: true } };

// A valid product-spray body (product XOR fertilizer — product branch).
const body: any = {
    assigneeUserId: 'user-9',
    parcelIds: ['parcel-a', 'parcel-b'],
    productItemId: 'item-1',
    doseValue: 2,
    doseUnitId: 'unit-1',
};

function primeHappyPathValidation() {
    mockDb.location.findFirst.mockResolvedValue({ id: 'loc-1', name: 'North Field' });
    mockDb.item.findFirst.mockResolvedValue({ id: 'item-1' });
    mockDb.unit.findUnique.mockResolvedValue({ id: 'unit-1' });
    mockDb.task.update.mockResolvedValue({});
    mockDb.operationParcel.createMany.mockResolvedValue({ count: 2 });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('createFieldOperation idempotency', () => {
    it('replays a known key — returns the original task, never calls createTask', async () => {
        // The outbox re-sends the same queued job → the Task already exists.
        mockDb.task.findFirst.mockResolvedValue({ id: 'task-existing', key: 'TSK-7' });
        mockDb.operationParcel.count.mockResolvedValue(2);

        const result = await createFieldOperation(ctx, 'loc-1', body, 'outbox-abc');

        expect(result).toEqual({ taskId: 'task-existing', taskKey: 'TSK-7', locationId: 'loc-1', parcelCount: 2 });
        expect(createTask).not.toHaveBeenCalled();
        // No duplicate write — the create path (validation + prescription lines)
        // never runs on a replay.
        expect(mockDb.location.findFirst).not.toHaveBeenCalled();
        expect(mockDb.operationParcel.createMany).not.toHaveBeenCalled();
    });

    it('creates without a key — mints a task, stamps clientMutationId=null', async () => {
        primeHappyPathValidation();
        createTask.mockResolvedValue({ id: 'task-new', key: 'TSK-8' });

        const result = await createFieldOperation(ctx, 'loc-1', body /* no key */);

        expect(result).toEqual({ taskId: 'task-new', taskKey: 'TSK-8', locationId: 'loc-1', parcelCount: 2 });
        // No idempotency lookup happened (no key) …
        expect(mockDb.task.findFirst).not.toHaveBeenCalled();
        // … and the task is created with a null clientMutationId (online create
        // is unconstrained by the partial-unique ledger).
        expect(createTask).toHaveBeenCalledTimes(1);
        expect(createTask.mock.calls[0][1]).toMatchObject({ type: 'FIELD_OPERATION', clientMutationId: null });
    });

    it('creates with a fresh key — stamps clientMutationId=key', async () => {
        mockDb.task.findFirst.mockResolvedValue(null); // no prior task for this key
        primeHappyPathValidation();
        createTask.mockResolvedValue({ id: 'task-new', key: 'TSK-9' });

        await createFieldOperation(ctx, 'loc-1', body, 'outbox-xyz');

        expect(createTask).toHaveBeenCalledTimes(1);
        expect(createTask.mock.calls[0][1]).toMatchObject({ clientMutationId: 'outbox-xyz' });
    });

    it('loses a P2002 race — re-reads the winning task instead of throwing', async () => {
        primeHappyPathValidation();
        // First lookup: no task yet (both replays passed the pre-check).
        // Second lookup (after P2002): the winner's task.
        mockDb.task.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'task-winner', key: 'TSK-10' });
        mockDb.operationParcel.count.mockResolvedValue(2);
        createTask.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
                code: 'P2002',
                clientVersion: 'test',
            }),
        );

        const result = await createFieldOperation(ctx, 'loc-1', body, 'outbox-race');

        expect(result).toEqual({ taskId: 'task-winner', taskKey: 'TSK-10', locationId: 'loc-1', parcelCount: 2 });
    });
});
