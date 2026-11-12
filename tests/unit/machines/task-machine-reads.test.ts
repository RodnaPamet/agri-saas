/**
 * The MECHANISATOR machine reads — #2948 stage 3b.
 *
 * Two properties carry most of the weight here and neither is about a happy
 * path: every refusal is the SAME 404, and the drivers' notice discloses names
 * and types and nothing else.
 */
const mockDb = {} as never;
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));

const MachineRepository = {
    findTaskAuth: jest.fn(),
    listTaskLocatableAssets: jest.fn(),
    earliestTrackerInstall: jest.fn(),
    latestPositions: jest.fn(),
    liveTrackerAssetIds: jest.fn(),
    liveTelematicsProviders: jest.fn(),
    listTrackedMachineNames: jest.fn(),
};
jest.mock('../../../src/app-layer/repositories/MachineRepository', () => ({
    MachineRepository,
}));

import {
    listTaskAssets,
    listTrackedMachines,
    readTaskMachine,
} from '@/app-layer/usecases/task-machines';
import { ALL_ROLES, getPermissionsForRole } from '@/lib/permissions';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('MECHANISATOR');
const ME = ctx.userId;

const TRACTOR = { id: 'a-tractor', name: 'John Deere 6155M', type: 'TRACTOR' as const };
const IMPLEMENT = { id: 'a-implement', name: 'Amazone UX', type: 'IMPLEMENT' as const };

function position(assetId: string) {
    return {
        assetId,
        lat: { toString: () => '43.4120000' },
        lon: { toString: () => '27.8310000' },
        recordedAt: new Date('2026-11-12T08:00:00.000Z'),
        speedKph: { toString: () => '7.5' },
        ignition: true,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    MachineRepository.findTaskAuth.mockResolvedValue({
        id: 't1',
        assigneeUserId: ME,
        status: 'IN_PROGRESS',
    });
    MachineRepository.listTaskLocatableAssets.mockResolvedValue([TRACTOR]);
    MachineRepository.earliestTrackerInstall.mockResolvedValue(new Map());
    MachineRepository.latestPositions.mockResolvedValue([]);
    MachineRepository.liveTrackerAssetIds.mockResolvedValue(new Set<string>());
    MachineRepository.liveTelematicsProviders.mockResolvedValue(new Map());
    MachineRepository.listTrackedMachineNames.mockResolvedValue([]);
});

describe('readTaskMachine — every refusal is the SAME 404', () => {
    // Asserted as a COMPARISON of the observable, not merely as "it threw":
    // the property is that a driver cannot tell these four apart, and four
    // different messages would each be a disclosure.
    const cases: Array<[string, () => void]> = [
        ['the task does not exist (or is another farm\'s)', () => {
            MachineRepository.findTaskAuth.mockResolvedValue(null);
        }],
        ['the task is assigned to somebody else', () => {
            MachineRepository.findTaskAuth.mockResolvedValue({
                id: 't1', assigneeUserId: 'someone-else', status: 'IN_PROGRESS',
            });
        }],
        ['the task is closed', () => {
            MachineRepository.findTaskAuth.mockResolvedValue({
                id: 't1', assigneeUserId: ME, status: 'RESOLVED',
            });
        }],
        ['the task has no locatable machine', () => {
            MachineRepository.listTaskLocatableAssets.mockResolvedValue([]);
        }],
    ];

    it.each(cases)('%s', async (_name, arrange) => {
        arrange();
        await expect(readTaskMachine(ctx, 't1')).rejects.toThrow(/No such task/);
    });

    it('the four refusals are INDISTINGUISHABLE from each other', async () => {
        const messages: string[] = [];
        for (const [, arrange] of cases) {
            jest.clearAllMocks();
            MachineRepository.findTaskAuth.mockResolvedValue({
                id: 't1', assigneeUserId: ME, status: 'IN_PROGRESS',
            });
            MachineRepository.listTaskLocatableAssets.mockResolvedValue([TRACTOR]);
            MachineRepository.earliestTrackerInstall.mockResolvedValue(new Map());
            MachineRepository.latestPositions.mockResolvedValue([]);
            arrange();
            await readTaskMachine(ctx, 't1').catch((e: Error) => messages.push(e.message));
        }
        expect(messages).toHaveLength(4);
        expect(new Set(messages).size).toBe(1);
    });

    it('an UNASSIGNED task is refused, not treated as everyone\'s', async () => {
        MachineRepository.findTaskAuth.mockResolvedValue({
            id: 't1', assigneeUserId: null, status: 'OPEN',
        });
        await expect(readTaskMachine(ctx, 't1')).rejects.toThrow(/No such task/);
    });

    it('accepts every status an operator counts as outstanding', async () => {
        for (const status of ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED']) {
            MachineRepository.findTaskAuth.mockResolvedValue({
                id: 't1', assigneeUserId: ME, status,
            });
            await expect(readTaskMachine(ctx, 't1')).resolves.toMatchObject({
                assetId: 'a-tractor',
            });
        }
    });
});

describe('readTaskMachine — the tie-break is TOTAL', () => {
    it('prefers self-propelled over trailed', async () => {
        // An implement has no engine and sits wherever the tractor pulling it
        // is, so a driver asking "where is my machine" means the tractor. The
        // implement is listed FIRST to prove the order is not insertion order.
        MachineRepository.listTaskLocatableAssets.mockResolvedValue([IMPLEMENT, TRACTOR]);
        const out = await readTaskMachine(ctx, 't1');
        expect(out.assetId).toBe('a-tractor');
        expect(out.locatableCount).toBe(2);
    });

    it('falls to the EARLIEST tracker install between two self-propelled', async () => {
        const older = { id: 'z-older', name: 'Z', type: 'HARVESTER' as const };
        const newer = { id: 'a-newer', name: 'A', type: 'TRACTOR' as const };
        MachineRepository.listTaskLocatableAssets.mockResolvedValue([newer, older]);
        MachineRepository.earliestTrackerInstall.mockResolvedValue(
            new Map([
                ['z-older', new Date('2025-01-01T00:00:00Z')],
                ['a-newer', new Date('2026-01-01T00:00:00Z')],
            ]),
        );
        const out = await readTaskMachine(ctx, 't1');
        // `z-older` wins on install date despite sorting LAST by id, which is
        // what proves rank 2 outranks rank 3.
        expect(out.assetId).toBe('z-older');
    });

    it('falls to assetId last, so the order is deterministic with no installs', async () => {
        const a = { id: 'aaa', name: 'Zed', type: 'TRACTOR' as const };
        const b = { id: 'bbb', name: 'Alpha', type: 'TRACTOR' as const };
        MachineRepository.listTaskLocatableAssets.mockResolvedValue([b, a]);
        const first = await readTaskMachine(ctx, 't1');
        MachineRepository.listTaskLocatableAssets.mockResolvedValue([a, b]);
        const second = await readTaskMachine(ctx, 't1');
        // Same answer whichever order the database returned — the property
        // #2948 exists for, since "the first one with a tracker" names no row.
        expect(first.assetId).toBe('aaa');
        expect(second.assetId).toBe('aaa');
    });

    it('a machine WITHOUT a tracker loses to one with, among equals', async () => {
        const untracked = { id: 'aaa', name: 'A', type: 'TRACTOR' as const };
        const tracked = { id: 'zzz', name: 'Z', type: 'TRACTOR' as const };
        MachineRepository.listTaskLocatableAssets.mockResolvedValue([untracked, tracked]);
        MachineRepository.earliestTrackerInstall.mockResolvedValue(
            new Map([['zzz', new Date('2026-01-01T00:00:00Z')]]),
        );
        const out = await readTaskMachine(ctx, 't1');
        expect(out.assetId).toBe('zzz');
    });

    it('carries the chosen machine\'s position, with coordinates as strings', async () => {
        MachineRepository.listTaskLocatableAssets.mockResolvedValue([IMPLEMENT, TRACTOR]);
        MachineRepository.latestPositions.mockResolvedValue([
            position('a-implement'),
            position('a-tractor'),
        ]);
        const out = await readTaskMachine(ctx, 't1');
        // The TRACTOR's position, not whichever row came back first.
        expect(out.assetId).toBe('a-tractor');
        expect(out.lastPosition).toEqual({
            lat: '43.4120000',
            lon: '27.8310000',
            recordedAt: '2026-11-12T08:00:00.000Z',
            speedKph: 7.5,
            ignition: true,
            moving: true,
        });
    });

    it('reports a machine that has never reported as null, not absent', async () => {
        const out = await readTaskMachine(ctx, 't1');
        expect(out.lastPosition).toBeNull();
        expect(out.locatableCount).toBe(1);
    });
});

describe('listTaskAssets', () => {
    it('always carries the positionSource KEY, null included', async () => {
        MachineRepository.listTaskLocatableAssets.mockResolvedValue([TRACTOR, IMPLEMENT]);
        MachineRepository.liveTrackerAssetIds.mockResolvedValue(new Set(['a-tractor']));

        const out = await listTaskAssets(ctx, 't1');
        expect(out.assets).toEqual([
            {
                assetId: 'a-tractor',
                name: 'John Deere 6155M',
                type: 'TRACTOR',
                positionSource: { kind: 'TRACKER', provider: null },
            },
            {
                assetId: 'a-implement',
                name: 'Amazone UX',
                type: 'IMPLEMENT',
                positionSource: null,
            },
        ]);
        // The client reads key PRESENCE, so omitting it for an unconfigured
        // machine would be a different answer rather than a smaller payload.
        expect(Object.keys(out.assets[1])).toContain('positionSource');
    });

    it('carries NO coordinates — configuration only', async () => {
        MachineRepository.listTaskLocatableAssets.mockResolvedValue([TRACTOR]);
        MachineRepository.liveTrackerAssetIds.mockResolvedValue(new Set(['a-tractor']));
        const out = await listTaskAssets(ctx, 't1');
        const json = JSON.stringify(out);
        expect(json).not.toMatch(/lat|lon|recordedAt|speedKph/);
        // This is what makes the wider audience safe: it says which machines
        // are findable without saying where any of them is.
        expect(MachineRepository.latestPositions).not.toHaveBeenCalled();
    });

    it('404s for a task in another farm, and does not probe its assets', async () => {
        MachineRepository.findTaskAuth.mockResolvedValue(null);
        await expect(listTaskAssets(ctx, 't1')).rejects.toThrow(/No such task/);
        expect(MachineRepository.listTaskLocatableAssets).not.toHaveBeenCalled();
    });

    it('does NOT require assignment — any task reader may call it', async () => {
        // The deliberate difference from the sibling `/machine` read, which
        // refuses exactly this case. Somebody else's task, and CLOSED, and it
        // still answers: the configuration view carries no coordinates, so a
        // wider audience costs nothing.
        MachineRepository.findTaskAuth.mockResolvedValue({
            id: 't1', assigneeUserId: 'someone-else', status: 'RESOLVED',
        });
        MachineRepository.listTaskLocatableAssets.mockResolvedValue([TRACTOR]);
        const out = await listTaskAssets(ctx, 't1');
        expect(out.assets).toHaveLength(1);
        expect(out.assets[0].assetId).toBe('a-tractor');

        // And the contrast is asserted rather than described: the SAME task
        // state is refused by the machine read.
        await expect(readTaskMachine(ctx, 't1')).rejects.toThrow(/No such task/);
    });
});

describe('listTrackedMachines — the drivers notice', () => {
    it('discloses NAME and TYPE and nothing else', async () => {
        MachineRepository.listTrackedMachineNames.mockResolvedValue([
            { name: 'John Deere 6155M', type: 'TRACTOR' },
        ]);
        const out = await listTrackedMachines(ctx);
        expect(out.machines).toEqual([{ name: 'John Deere 6155M', type: 'TRACTOR' }]);
        // The select is the disclosure control. Asserted on the SERIALISED
        // form, because that is what reaches the phone.
        const json = JSON.stringify(out.machines);
        expect(json).not.toMatch(/imei|lat|lon|recordedAt|lastSeen|assetId/i);
    });

    it('DERIVES visibleTo from the permission table rather than listing it', async () => {
        const out = await listTrackedMachines(ctx);
        // Computed independently from the same source of truth. If somebody
        // hardcoded the array, this diverges the moment a role's flag moves —
        // which is the staleness #2948 returns the field to avoid.
        const expected = ALL_ROLES.filter((r) => getPermissionsForRole(r).machines.view);
        expect(out.visibleTo).toEqual(expected);
    });

    it('visibleTo is OWNER + ADMIN today, and the operator is NOT in it', async () => {
        const out = await listTrackedMachines(ctx);
        expect([...out.visibleTo].sort()).toEqual(['ADMIN', 'OWNER']);
        // The caller can read this notice and still not be allowed to see a
        // position — which is the whole shape of a transparency duty.
        expect(out.visibleTo).not.toContain('MECHANISATOR');
    });

    it('answers for the whole tenant, not one task', async () => {
        await listTrackedMachines(ctx);
        expect(MachineRepository.listTrackedMachineNames).toHaveBeenCalledTimes(1);
        // No task id is involved anywhere: a driver is entitled to know which
        // machines are tracked, not merely the one they are on today.
        expect(MachineRepository.findTaskAuth).not.toHaveBeenCalled();
    });

    it('an empty farm reports no machines and still reports visibleTo', async () => {
        const out = await listTrackedMachines(ctx);
        expect(out.machines).toEqual([]);
        expect(out.visibleTo.length).toBeGreaterThan(0);
    });
});
