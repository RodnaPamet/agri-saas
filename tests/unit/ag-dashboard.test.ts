/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Coverage for the agriculture dashboard read-model.
 *
 * `getAgDashboard` is a THIN aggregation over three existing list
 * usecases (journal / inventory / farm-task), gated by the tenant's
 * enabled modules. The behaviour worth locking:
 *   - each card slices to STRIP_LIMIT (5),
 *   - low-stock is the `lowStock:true` subset of the lots read,
 *   - a disabled ag module short-circuits its fetch (empty list, no call),
 *   - the farm-tasks queue is ALWAYS fetched (Tasks is not module-gated).
 *
 * The four dependency usecases are mocked; `assertCanRead` runs for real
 * via the role on the RequestContext.
 *
 * Also satisfies the usecase-test-coverage guardrail.
 */

const listLogEntries = jest.fn();
const listLots = jest.fn();
const listMyFarmTasks = jest.fn();
const getEnabledModules = jest.fn();
const listSchemes = jest.fn();
const getAchievements = jest.fn();

jest.mock('@/app-layer/usecases/journal', () => ({
    listLogEntries: (...a: any[]) => listLogEntries(...a),
}));
jest.mock('@/app-layer/usecases/inventory', () => ({
    listLots: (...a: any[]) => listLots(...a),
}));
jest.mock('@/app-layer/usecases/farm-task', () => ({
    listMyFarmTasks: (...a: any[]) => listMyFarmTasks(...a),
}));
jest.mock('@/app-layer/usecases/modules', () => ({
    getEnabledModules: (...a: any[]) => getEnabledModules(...a),
}));
jest.mock('@/app-layer/usecases/achievements', () => ({
    getAchievements: (...a: any[]) => getAchievements(...a),
}));

import { getAgDashboard } from '@/app-layer/usecases/ag-dashboard';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('READER');

beforeEach(() => {
    jest.clearAllMocks();
    // Default: no certification schemes exist → certification resolves null.
    listSchemes.mockResolvedValue([]);
    // Default achievements payload (overridden where a test asserts it).
    getAchievements.mockResolvedValue({ milestones: [], streak: { current: 0, best: 0 } });
});

function journalEntry(i: number) {
    return { id: `j${i}`, type: 'HARVEST', title: `Entry ${i}`, occurredAt: new Date('2026-06-01T00:00:00Z') };
}
function lot(id: string, lowStock: boolean) {
    return {
        id,
        lowStock,
        quantityOnHand: 3,
        item: { name: `Item ${id}` },
        unit: { symbol: 'kg' },
    };
}
function task(i: number) {
    return { id: `t${i}`, title: `Task ${i}`, status: 'TODO', dueAt: new Date('2026-06-10T00:00:00Z') };
}

describe('getAgDashboard', () => {
    it('both ag modules on — slices each card to ≤5 and maps the shape', async () => {
        getEnabledModules.mockResolvedValue(['JOURNAL', 'INVENTORY', 'CERTIFICATION']);
        listLogEntries.mockResolvedValue(Array.from({ length: 7 }, (_, i) => journalEntry(i)));
        listLots.mockResolvedValue([lot('a', true), lot('b', false), lot('c', true)]);
        listMyFarmTasks.mockResolvedValue(Array.from({ length: 6 }, (_, i) => task(i)));
        // Top scheme present → certification reading from its readiness report.
        listSchemes.mockResolvedValue([{ id: 'fw-1', key: 'ORGANIC', name: 'Organic' }]);

        const out = await getAgDashboard(ctx);

        expect(out.enabledModules).toEqual(['JOURNAL', 'INVENTORY', 'CERTIFICATION']);
        // Journal sliced 7 → 5, ISO-stringified.
        expect(out.recentJournal).toHaveLength(5);
        expect(out.recentJournal[0]).toEqual({
            id: 'j0',
            type: 'HARVEST',
            title: 'Entry 0',
            occurredAt: '2026-06-01T00:00:00.000Z',
        });
        // Low-stock is the lowStock:true subset only.
        expect(out.lowStock.map((l) => l.id)).toEqual(['a', 'c']);
        expect(out.lowStock[0]).toEqual({ id: 'a', name: 'Item a', quantityOnHand: 3, unitSymbol: 'kg' });
        // Tasks sliced 6 → 5.
        expect(out.myTasks).toHaveLength(5);
        expect(out.myTasks[0]).toEqual({ id: 't0', title: 'Task 0', status: 'TODO', dueAt: '2026-06-10T00:00:00.000Z' });
        // Certification is deliberately NULL. This used to run `listSchemes`
        // `AgDashboardStrip`, the only consumer of this payload, never
        // rendered the value. Two queries per load, one of them the whole
        // coverage walk, for a field nothing displayed.
        //
        // It also picked the "top" scheme ALPHABETICALLY, so a farm certified
        // against GlobalG.A.P. would have seen a figure for whatever key
        // sorted first — the same wrong-scheme selection the certifier pack
        // had. Readiness now lives where it can be attributed to a scheme the
        // reader chose: the scheme detail page.
        expect(out.certification).toBeNull();
        // And the queries are not made at all — the point is not just that the
        // value is null, it is that the dashboard stopped paying for it.
        expect(listSchemes).not.toHaveBeenCalled();
    });

    it('CERTIFICATION on but no scheme exists → certification is null', async () => {
        getEnabledModules.mockResolvedValue(['JOURNAL', 'CERTIFICATION']);
        listLogEntries.mockResolvedValue([]);
        listLots.mockResolvedValue([]);
        listMyFarmTasks.mockResolvedValue([]);
        listSchemes.mockResolvedValue([]); // explicit — no AG_SCHEME

        const out = await getAgDashboard(ctx);

        expect(out.certification).toBeNull();
        // No scheme → no readiness query.
    });

    it('pure-GRC tenant (no ag modules) short-circuits journal + inventory fetches', async () => {
        getEnabledModules.mockResolvedValue(['CERTIFICATION', 'RISK']);
        listMyFarmTasks.mockResolvedValue([task(0)]);

        const out = await getAgDashboard(ctx);

        // The two ag lists are never fetched when their module is off.
        expect(listLogEntries).not.toHaveBeenCalled();
        expect(listLots).not.toHaveBeenCalled();
        expect(out.recentJournal).toEqual([]);
        expect(out.lowStock).toEqual([]);
        // Farm tasks are always fetched — Tasks is not module-gated.
        expect(listMyFarmTasks).toHaveBeenCalledTimes(1);
        expect(out.myTasks).toHaveLength(1);
    });

    it('CERTIFICATION off → certification is null and listSchemes is never called', async () => {
        getEnabledModules.mockResolvedValue(['JOURNAL']);
        listLogEntries.mockResolvedValue([]);
        listLots.mockResolvedValue([]);
        listMyFarmTasks.mockResolvedValue([]);

        const out = await getAgDashboard(ctx);

        expect(out.certification).toBeNull();
        expect(listSchemes).not.toHaveBeenCalled();
    });

    it('handles null occurredAt / dueAt as null in the payload', async () => {
        getEnabledModules.mockResolvedValue(['JOURNAL']);
        listLogEntries.mockResolvedValue([{ id: 'j', type: 'NOTE', title: 'x', occurredAt: null }]);
        listLots.mockResolvedValue([]);
        listMyFarmTasks.mockResolvedValue([{ id: 't', title: 'y', status: 'TODO', dueAt: null }]);

        const out = await getAgDashboard(ctx);
        expect(out.recentJournal[0].occurredAt).toBeNull();
        expect(out.myTasks[0].dueAt).toBeNull();
    });
});
