/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirror runtime
 * contracts; the codebase's standard file-level disable for test doubles. */
/**
 * #931 — a replay must not confirm an operation that has no prescription lines.
 *
 * `createFieldOperation` commits in TWO transactions. `createTask` opens its
 * own, so `clientMutationId` is durable BEFORE the TaskLink, `operationType`
 * and `OperationParcel` lines are written by the second one. If that second
 * transaction dies — a pod rolled mid-deploy, a connection reset, or
 * `createMany` over N parcels plus an encrypting `logEvent` exceeding Prisma's
 * 5s interactive default — it rolls back whole and the client gets a 500.
 *
 * A 500 is transient, so the outbox keeps the item and replays it. The replay
 * arm used to answer with 201 and `parcelCount: 0`; the drain then removed the
 * queued body as delivered and the operator was told the job synced. What
 * survived was a FIELD_OPERATION with no location link, a NULL operationType
 * and no lines — and nothing can add lines afterwards, because the parcels
 * route is PATCH-only. The ДНЕВНИК joins Location → taskLink → DONE
 * operationParcel, so that treatment can never reach the compliance record.
 *
 * `CreateFieldOperationSchema` requires `parcelIds.min(1)`, so zero lines is
 * unreachable for a healthy operation — it uniquely marks the partial commit.
 * The replay now FINISHES the job from the body the outbox still holds.
 */
import { makeRequestContext } from '../helpers/make-context';

const mockDb: any = {
    location: { findFirst: jest.fn() },
    item: { findFirst: jest.fn() },
    unit: { findUnique: jest.fn() },
    task: { findFirst: jest.fn(), update: jest.fn() },
    operationParcel: { count: jest.fn(), createMany: jest.fn() },
    $executeRaw: jest.fn(async () => 0),
};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: any, fn: any) => fn(mockDb),
}));

const createTask = jest.fn();
jest.mock('../../src/app-layer/usecases/task', () => ({ createTask: (...a: any[]) => createTask(...a) }));
jest.mock('../../src/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(), assertCanWrite: jest.fn(), assertCanAdmin: jest.fn(),
}));
const logEvent = jest.fn();
jest.mock('../../src/app-layer/events/audit', () => ({ logEvent: (...a: any[]) => logEvent(...a) }));
jest.mock('../../src/app-layer/automation', () => ({ emitAutomationEvent: jest.fn() }));
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));
jest.mock('../../src/app-layer/repositories/ParcelRepository', () => ({
    ParcelRepository: { validIdsForLocation: jest.fn(async (_d: any, _c: any, _l: any, ids: string[]) => new Set(ids)) },
}));
const link = jest.fn();
jest.mock('../../src/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: {},
    TaskLinkRepository: { link: (...a: any[]) => link(...a) },
}));
jest.mock('@/lib/security/sanitize', () => ({ sanitizePlainText: (v: string) => v }));

import { createFieldOperation } from '../../src/app-layer/usecases/field-operation';

const INPUT = {
    assigneeUserId: 'user-1',
    parcelIds: ['p1', 'p2'],
    productItemId: 'item-1',
    doseValue: 2,
    doseUnitId: 'unit-1',
};

function primeReferenceData() {
    mockDb.location.findFirst.mockResolvedValue({ id: 'loc-1', name: 'North block', tenantId: 'tenant-1' });
    mockDb.item.findFirst.mockResolvedValue({ id: 'item-1', tenantId: 'tenant-1', category: 'PLANT_PROTECTION' });
    mockDb.unit.findUnique.mockResolvedValue({ id: 'unit-1', code: 'L' });
    mockDb.operationParcel.createMany.mockResolvedValue({ count: 2 });
}

describe('#931 — a replay of a partially committed field operation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        primeReferenceData();
    });

    it('does NOT confirm an operation with zero lines — it writes them', async () => {
        // The partial commit: the Task exists (createTask's own transaction
        // committed), the lines do not.
        mockDb.task.findFirst.mockResolvedValue({ id: 't-orphan', key: 'OP-9' });
        mockDb.operationParcel.count
            .mockResolvedValueOnce(0)  // the replay lookup
            .mockResolvedValueOnce(0); // the re-read inside the advisory lock

        const ctx = makeRequestContext('ADMIN', { userId: 'user-1' });
        const out: any = await createFieldOperation(ctx, 'loc-1', INPUT as any, 'outbox-id-1');

        // The lines are written for the EXISTING task — no second Task minted,
        // which would only collide on (tenantId, clientMutationId) anyway.
        expect(createTask).not.toHaveBeenCalled();
        expect(mockDb.operationParcel.createMany).toHaveBeenCalled();
        expect(link).toHaveBeenCalled();
        expect(out.parcelCount).toBe(2);
    });

    it('serialises the repair, so two concurrent drains cannot double the lines', async () => {
        mockDb.task.findFirst.mockResolvedValue({ id: 't-orphan', key: 'OP-9' });
        mockDb.operationParcel.count
            .mockResolvedValueOnce(0)  // the replay lookup
            .mockResolvedValueOnce(2); // inside the lock: the sibling drain won

        const ctx = makeRequestContext('ADMIN', { userId: 'user-1' });
        const out: any = await createFieldOperation(ctx, 'loc-1', INPUT as any, 'outbox-id-1');

        // OperationParcel carries NO unique on (taskId, parcelId), so an
        // unserialised second pass duplicates every prescription line rather
        // than colliding. The lock is taken and the re-read inside it stops.
        expect(mockDb.$executeRaw).toHaveBeenCalled();
        expect(mockDb.operationParcel.createMany).not.toHaveBeenCalled();
        expect(out.parcelCount).toBe(2);
    });

    // CONTROL — a COMPLETE operation must still short-circuit. Without this, a
    // build that repaired unconditionally would satisfy the cases above while
    // rewriting lines on every replay.
    it('CONTROL: a replay with lines already present short-circuits untouched', async () => {
        mockDb.task.findFirst.mockResolvedValue({ id: 't-done', key: 'OP-7' });
        mockDb.operationParcel.count.mockResolvedValue(2);

        const ctx = makeRequestContext('ADMIN', { userId: 'user-1' });
        const out: any = await createFieldOperation(ctx, 'loc-1', INPUT as any, 'outbox-id-1');

        expect(createTask).not.toHaveBeenCalled();
        expect(mockDb.operationParcel.createMany).not.toHaveBeenCalled();
        expect(link).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
        expect(out).toMatchObject({ taskId: 't-done', parcelCount: 2 });
    });

    // CONTROL — an ordinary first create is unaffected.
    it('CONTROL: a fresh create still mints a task and writes its lines', async () => {
        mockDb.task.findFirst.mockResolvedValue(null);
        mockDb.operationParcel.count.mockResolvedValue(0);
        createTask.mockResolvedValue({ id: 't-new', key: 'OP-10' });

        const ctx = makeRequestContext('ADMIN', { userId: 'user-1' });
        const out: any = await createFieldOperation(ctx, 'loc-1', INPUT as any, 'outbox-id-2');

        expect(createTask).toHaveBeenCalled();
        expect(mockDb.operationParcel.createMany).toHaveBeenCalled();
        expect(out.parcelCount).toBe(2);
    });
});
