/**
 * The three reads behind a parcel's task history, as QUERIES — #2459.
 *
 * `tests/unit/parcel-tasks.test.ts` doubles these repositories to test the
 * usecase's logic, which means the queries themselves are invisible there.
 * This file is the other half: no mocks, a stub `db` that captures the
 * argument, so the filter and the ordering are asserted rather than assumed.
 *
 * Worth having because three of these properties are silent when wrong:
 *
 *   - a missing `deletedAt: null` shows soft-deleted tasks in a parcel's
 *     history, which the Tasks page itself hides — the rows look real;
 *   - a non-TOTAL order makes the `take: cap + 1` truncation boundary move
 *     between identical requests, so a client diffing the list sees rows
 *     appear and vanish with nothing having changed;
 *   - a missing `take` is an unbounded read, which the query-shape guardrail
 *     would catch for `findMany` but not the SIZE of the bound.
 */
import { WorkItemRepository, TaskLinkRepository } from '@/app-layer/repositories/WorkItemRepository';
import { ParcelRepository } from '@/app-layer/repositories/ParcelRepository';
import type { RequestContext } from '@/app-layer/types';

const ctx = { tenantId: 't1', userId: 'u1' } as unknown as RequestContext;

/** Captures the single argument each `findMany` is given. */
function capturing() {
    const calls: Record<string, unknown[]> = { task: [], taskLink: [], operationParcel: [] };
    const db = {
        task: { findMany: async (a: unknown) => { calls.task.push(a); return []; } },
        taskLink: { findMany: async (a: unknown) => { calls.taskLink.push(a); return []; } },
        operationParcel: { findMany: async (a: unknown) => { calls.operationParcel.push(a); return []; } },
    };
    return { db, calls };
}

describe('WorkItemRepository.listRowsByIds (#2459)', () => {
    it('excludes soft-deleted tasks and scopes to the tenant', async () => {
        const { db, calls } = capturing();
        await WorkItemRepository.listRowsByIds(db as never, ctx, ['a', 'b'], { take: 10 });
        expect((calls.task[0] as { where: unknown }).where).toEqual({
            tenantId: 't1',
            id: { in: ['a', 'b'] },
            deletedAt: null,
        });
    });

    it('orders newest-first on a TOTAL key', async () => {
        // `createdAt` alone is not total — a treatment writes several tasks in
        // the same millisecond, which is this read's common case.
        const { db, calls } = capturing();
        await WorkItemRepository.listRowsByIds(db as never, ctx, ['a'], { take: 10 });
        expect((calls.task[0] as { orderBy: unknown }).orderBy).toEqual([
            { createdAt: 'desc' },
            { id: 'desc' },
        ]);
    });

    it('passes the caller’s take through, so the +1 probe reaches the database', async () => {
        const { db, calls } = capturing();
        await WorkItemRepository.listRowsByIds(db as never, ctx, ['a'], { take: 201 });
        expect((calls.task[0] as { take: number }).take).toBe(201);
    });

    it('issues NO query for an empty id set', async () => {
        // `{ id: { in: [] } }` is valid and matches nothing, so this is about
        // not paying a round trip to learn what the caller already knows.
        const { db, calls } = capturing();
        const out = await WorkItemRepository.listRowsByIds(db as never, ctx, [], { take: 10 });
        expect(out).toEqual([]);
        expect(calls.task).toHaveLength(0);
    });
});

describe('the two inverse id reads (#2459)', () => {
    it('TaskLinkRepository.listTaskIdsByParcel filters the three indexed columns', async () => {
        // Exactly @@index([tenantId, entityType, entityId]) — which is why
        // this needed no migration.
        const { db, calls } = capturing();
        await TaskLinkRepository.listTaskIdsByParcel(db as never, ctx, 'p1', 2000);
        const arg = calls.taskLink[0] as { where: Record<string, unknown>; take: number; select: unknown };
        expect(arg.where.tenantId).toBe('t1');
        expect(arg.where.entityId).toBe('p1');
        expect(arg.where.entityType).toBe('PARCEL');
        expect(arg.take).toBe(2000);
        // ids only — a list read must not pull the row.
        expect(arg.select).toEqual({ taskId: true });
    });

    it('ParcelRepository.listOperationTaskIdsForParcel filters (tenantId, parcelId)', async () => {
        const { db, calls } = capturing();
        await ParcelRepository.listOperationTaskIdsForParcel(db as never, ctx, 'p1', 5000);
        const arg = calls.operationParcel[0] as { where: unknown; take: number; select: unknown };
        expect(arg.where).toEqual({ tenantId: 't1', parcelId: 'p1' });
        expect(arg.take).toBe(5000);
        expect(arg.select).toEqual({ taskId: true });
    });

    it('neither uses `distinct`, so the caller must deduplicate', async () => {
        // Deliberate, and the mirror reads say why: `distinct` would hide the
        // shape from the caller, and a caller that then stopped deduplicating
        // would break silently the day a second source was unioned in.
        const { db, calls } = capturing();
        await TaskLinkRepository.listTaskIdsByParcel(db as never, ctx, 'p1', 10);
        await ParcelRepository.listOperationTaskIdsForParcel(db as never, ctx, 'p1', 10);
        expect(calls.taskLink[0]).not.toHaveProperty('distinct');
        expect(calls.operationParcel[0]).not.toHaveProperty('distinct');
    });
});
