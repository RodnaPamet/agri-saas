/**
 * `listMyFarmTasks` scope option — the thin extension that lets /farm-tasks be
 * the tenant-wide manager queue (scope 'all') while /my-work stays the
 * caller's own list (scope 'mine', the default). It must reuse `listTasks`
 * per work-item type and only vary whether an assignee filter is applied.
 */
import { listMyFarmTasks } from '@/app-layer/usecases/farm-task';
import { listTasks } from '@/app-layer/usecases/task';
import { makeRequestContext } from '../helpers/make-context';

// A PARTIAL barrel mock, and it has to stay partial: spreading
// `requireActual` would pull the real task usecases in, and with them
// `runInTenantContext` and Prisma, which this suite has no database for.
//
// The cost of partial is that a NEW export from that module throws here rather
// than being absent — which is how #2474 broke these four tests. `farm-task.ts`
// gained an `attachParcelIds` import and this factory did not know about it, so
// every case died on `attachParcelIds is not a function` with nothing about
// scope having changed. If you add an export that `farm-task.ts` imports, add
// it here in the same diff.
jest.mock('@/app-layer/usecases/task', () => ({
    listTasks: jest.fn(),
    createTask: jest.fn(),
    addTaskLink: jest.fn(),
    // Identity-shaped on purpose. This suite is about the ASSIGNEE filter, and
    // a double that returned a fixed array would make the scope assertions
    // read whatever it returned rather than what `listTasks` was asked for.
    // `parcelIds` is added so the shape still matches what callers receive.
    attachParcelIds: jest.fn(
        async (_ctx: unknown, rows: Array<Record<string, unknown>>) =>
            rows.map((r) => ({ ...r, parcelIds: [] })),
    ),
}));

const mockedListTasks = listTasks as jest.MockedFunction<typeof listTasks>;

describe('listMyFarmTasks scope', () => {
    beforeEach(() => {
        mockedListTasks.mockReset();
        mockedListTasks.mockResolvedValue([] as never);
    });

    it("defaults to scope 'mine' — filters by the caller", async () => {
        const ctx = makeRequestContext('ADMIN', { userId: 'u-1' });
        await listMyFarmTasks(ctx);
        expect(mockedListTasks).toHaveBeenCalled();
        for (const call of mockedListTasks.mock.calls) {
            expect((call[1] as { assigneeUserId?: string[] }).assigneeUserId).toEqual(['u-1']);
        }
    });

    it("scope 'all' does not apply an assignee filter", async () => {
        const ctx = makeRequestContext('ADMIN', { userId: 'u-1' });
        await listMyFarmTasks(ctx, { scope: 'all' });
        for (const call of mockedListTasks.mock.calls) {
            expect((call[1] as { assigneeUserId?: string[] }).assigneeUserId).toBeUndefined();
        }
    });

    it("scope 'all' with an explicit assigneeUserId still narrows", async () => {
        const ctx = makeRequestContext('ADMIN', { userId: 'u-1' });
        await listMyFarmTasks(ctx, { scope: 'all', assigneeUserId: ['u-2'] });
        for (const call of mockedListTasks.mock.calls) {
            expect((call[1] as { assigneeUserId?: string[] }).assigneeUserId).toEqual(['u-2']);
        }
    });

    it('queries both FARM_TASK and FIELD_OPERATION', async () => {
        const ctx = makeRequestContext('ADMIN', { userId: 'u-1' });
        await listMyFarmTasks(ctx, { scope: 'all' });
        const types = mockedListTasks.mock.calls
            .map((c) => (c[1] as { type?: string }).type)
            .sort();
        expect(types).toEqual(['FARM_TASK', 'FIELD_OPERATION']);
    });
});
