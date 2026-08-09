/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks + fake DB. */
/**
 * Unit tests for `src/app-layer/usecases/control/queries.ts` —
 * the control read + dashboard + consistency-check surface.
 *
 * Wave-8b / stage-3f branch coverage (paired with
 * framework-coverage in the same PR). Branch matrix:
 *
 *   listControls / listControlsPaginated: cache wrapper passthroughs
 *   getControl:        notFound vs happy
 *   getControlHeader:  notFound + doneControlTasks computed +
 *                      header decorated with the count
 *   getControlActivity: control not-found vs happy (audit log read)
 *   getControlDashboard:
 *     - statusDistribution fold
 *     - applicabilityOf default 0 when group missing
 *     - implementationProgress 0-guard when applicableCount === 0
 *     - topOwners top-5 sort + owner-skip when c.owner null
 *     - openByControl null-key skip
 *   runConsistencyCheck:
 *     - RBAC: OWNER + ADMIN allowed
 *     - RBAC: AUDITOR rejected
 *     - missingCode filter + duplicateCodes grouping
 *     - overdueTasks reshape
 *   listControlsWithDeleted: assertCanAdmin gate
 */

const policyCalls: string[] = [];

jest.mock('@/app-layer/policies/control.policies', () => ({
    assertCanReadControls: jest.fn(() => policyCalls.push('read')),
}));

jest.mock('@/app-layer/policies/common', () => ({
    assertCanAdmin: jest.fn(() => policyCalls.push('admin')),
}));

jest.mock('@/app-layer/repositories/ControlRepository', () => ({
    ControlRepository: {
        list: jest.fn(),
        listPaginated: jest.fn(),
        getById: jest.fn(),
        getHeaderById: jest.fn(),
    },
}));

jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(async ({ loader }: any) => loader()),
}));

jest.mock('@/lib/soft-delete', () => {
    const actual = jest.requireActual('@/lib/soft-delete');
    return {
        ...actual,
        withDeleted: (q: any) => ({ ...q, includeDeleted: true }),
    };
});

const tenantDb: any = {
    control: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
    controlTask: { count: jest.fn(), groupBy: jest.fn(), findMany: jest.fn() },
    auditLog: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, cb: any) => cb(tenantDb)),
    };
});

// getControlHeader now derives the Tasks-tab badge + progress from the
// unified-task count (matching LinkedTasksPanel) via this repo method.
jest.mock('@/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: {
        countLinkedToControl: jest.fn(),
        countLinkedToControls: jest.fn(),
    },
}));

import {
    listControls,
    listControlsPaginated,
    getControl,
    getControlHeader,
    getControlActivity,
    getControlDashboard,
    runConsistencyCheck,
    listControlsWithDeleted,
} from '@/app-layer/usecases/control/queries';
import { ControlRepository } from '@/app-layer/repositories/ControlRepository';
import { WorkItemRepository } from '@/app-layer/repositories/WorkItemRepository';
import { assertCanReadControls } from '@/app-layer/policies/control.policies';
import { assertCanAdmin } from '@/app-layer/policies/common';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    policyCalls.length = 0;
    [
        ControlRepository.list, ControlRepository.listPaginated,
        ControlRepository.getById, ControlRepository.getHeaderById,
        tenantDb.control.findMany, tenantDb.control.count, tenantDb.control.groupBy,
        tenantDb.controlTask.count, tenantDb.controlTask.groupBy, tenantDb.controlTask.findMany,
        tenantDb.auditLog.findMany,
        WorkItemRepository.countLinkedToControl as jest.Mock,
        WorkItemRepository.countLinkedToControls as jest.Mock,
        assertCanReadControls as jest.Mock,
        assertCanAdmin as jest.Mock,
    ].forEach((m: any) => m.mockReset && m.mockReset());
    (assertCanReadControls as jest.Mock).mockImplementation(() => policyCalls.push('read'));
    (assertCanAdmin as jest.Mock).mockImplementation(() => policyCalls.push('admin'));
});

// `controlTask.count` (getControlHeader's legacy done count, unused
// now) + `countLinkedToControls` (listControls' unified per-control
// counts) need addressable defaults so the cache passthrough tests
// don't NPE on the merge.
beforeEach(() => {
    tenantDb.controlTask.count.mockResolvedValue(0);
    (WorkItemRepository.countLinkedToControls as jest.Mock).mockResolvedValue(
        new Map(),
    );
});

const ctx = makeRequestContext('ADMIN');

// ──────────────────────────────────────────────────────────────────────
// listControls / listControlsPaginated — cache passthrough
// ──────────────────────────────────────────────────────────────────────
describe('listControls', () => {
    it('asserts read permission BEFORE the repo call', async () => {
        (ControlRepository.list as jest.Mock).mockResolvedValueOnce([]);
        await listControls(ctx, { status: ['IMPLEMENTED'] });
        expect(policyCalls).toEqual(['read']);
    });

    it('threads filters through + merges unified per-control task counts', async () => {
        (ControlRepository.list as jest.Mock).mockResolvedValueOnce([
            { id: 'c-1' },
            { id: 'c-2' },
        ]);
        (
            WorkItemRepository.countLinkedToControls as jest.Mock
        ).mockResolvedValueOnce(
            new Map([['c-1', { total: 4, done: 1 }]]),
        );
        const result = await listControls(ctx, { q: 'test' }, { take: 50 });
        // c-1 gets its unified counts; c-2 (absent from the map) → 0/0.
        expect(result).toEqual([
            { id: 'c-1', taskTotal: 4, taskDone: 1 },
            { id: 'c-2', taskTotal: 0, taskDone: 0 },
        ]);
        expect(WorkItemRepository.countLinkedToControls).toHaveBeenCalledWith(
            tenantDb,
            ctx,
            ['c-1', 'c-2'],
        );
    });
});

describe('listControlsPaginated', () => {
    it('threads limit + cursor through to the repo', async () => {
        (ControlRepository.listPaginated as jest.Mock).mockResolvedValueOnce({ rows: [], cursor: null });
        const result = await listControlsPaginated(ctx, { limit: 10, cursor: 'abc' });
        expect(result).toEqual({ rows: [], cursor: null });
    });
});

// ──────────────────────────────────────────────────────────────────────
// getControl / getControlHeader / getControlActivity
// ──────────────────────────────────────────────────────────────────────
describe('getControl', () => {
    it('throws notFound for a missing control', async () => {
        (ControlRepository.getById as jest.Mock).mockResolvedValueOnce(null);
        await expect(getControl(ctx, 'c-foreign')).rejects.toThrow(/control not found/i);
    });

    it('returns the control on happy-path', async () => {
        (ControlRepository.getById as jest.Mock).mockResolvedValueOnce({ id: 'c-1', code: 'CC1' });
        const result = await getControl(ctx, 'c-1');
        expect(result).toEqual({ id: 'c-1', code: 'CC1' });
    });
});

describe('getControlHeader', () => {
    it('throws notFound for a missing control', async () => {
        (ControlRepository.getHeaderById as jest.Mock).mockResolvedValueOnce(null);
        await expect(getControlHeader(ctx, 'c-foreign')).rejects.toThrow(/control not found/i);
    });

    it('derives the Tasks badge + progress from the unified linked-task count', async () => {
        (ControlRepository.getHeaderById as jest.Mock).mockResolvedValueOnce({
            id: 'c-1',
            code: 'CC1',
            _count: { controlTasks: 0, evidenceLinks: 1, evidence: 2, frameworkMappings: 3 },
        });
        (WorkItemRepository.countLinkedToControl as jest.Mock).mockResolvedValueOnce({
            total: 5,
            done: 2,
        });

        const result = await getControlHeader(ctx, 'c-1');

        // Tab badge reads `_count.controlTasks` — overridden to the
        // unified total (5), NOT the stale legacy relation count (0).
        // Other `_count` entries are preserved. Progress = done (2).
        expect(result).toEqual({
            id: 'c-1',
            code: 'CC1',
            _count: { controlTasks: 5, evidenceLinks: 1, evidence: 2, frameworkMappings: 3 },
            doneControlTasks: 2,
        });
        expect(WorkItemRepository.countLinkedToControl).toHaveBeenCalledWith(
            tenantDb,
            ctx,
            'c-1',
        );
    });
});

describe('getControlActivity', () => {
    it('throws notFound when the control is missing', async () => {
        (ControlRepository.getById as jest.Mock).mockResolvedValueOnce(null);
        await expect(getControlActivity(ctx, 'c-foreign')).rejects.toThrow(/control not found/i);
    });

    it('returns the audit log scoped to (tenant, Control, controlId) limit 50', async () => {
        (ControlRepository.getById as jest.Mock).mockResolvedValueOnce({ id: 'c-1' });
        tenantDb.auditLog.findMany.mockResolvedValueOnce([{ id: 'a-1' }]);

        const result = await getControlActivity(ctx, 'c-1');

        expect(result).toEqual([{ id: 'a-1' }]);
        const args = tenantDb.auditLog.findMany.mock.calls[0][0];
        expect(args.where).toMatchObject({ tenantId: 'tenant-1', entity: 'Control', entityId: 'c-1' });
        expect(args.take).toBe(50);
    });
});

// ──────────────────────────────────────────────────────────────────────
// getControlDashboard — branch-heavy aggregator
// ──────────────────────────────────────────────────────────────────────
describe('getControlDashboard', () => {
    function setupBaseline(opts: {
        statusGroups?: any[];
        applicabilityGroups?: any[];
        implementedCount?: number;
        dueSoonCount?: number;
        overdueTasks?: number;
        openTasksByControl?: any[];
        controlOwners?: any[];
    }) {
        tenantDb.control.groupBy
            .mockResolvedValueOnce(opts.statusGroups ?? [])
            .mockResolvedValueOnce(opts.applicabilityGroups ?? []);
        tenantDb.control.count
            .mockResolvedValueOnce(opts.implementedCount ?? 0)
            .mockResolvedValueOnce(opts.dueSoonCount ?? 0);
        tenantDb.controlTask.count.mockResolvedValueOnce(opts.overdueTasks ?? 0);
        tenantDb.controlTask.groupBy.mockResolvedValueOnce(opts.openTasksByControl ?? []);
        tenantDb.control.findMany.mockResolvedValueOnce(opts.controlOwners ?? []);
    }

    it('returns implementationProgress=0 when applicableCount === 0 (NaN guard)', async () => {
        setupBaseline({ implementedCount: 0, applicabilityGroups: [] });
        const result = await getControlDashboard(ctx);
        expect(result.implementationProgress).toBe(0);
    });

    it('rounds implementationProgress: implemented/applicable × 100', async () => {
        setupBaseline({
            applicabilityGroups: [{ applicability: 'APPLICABLE', _count: { _all: 10 } }],
            implementedCount: 7,
        });
        const result = await getControlDashboard(ctx);
        expect(result.implementationProgress).toBe(70);
        expect(result.applicableCount).toBe(10);
    });

    it('applicabilityOf defaults to 0 when the group is missing', async () => {
        setupBaseline({
            applicabilityGroups: [{ applicability: 'APPLICABLE', _count: { _all: 5 } }],
        });
        const result = await getControlDashboard(ctx);
        expect(result.applicabilityDistribution.notApplicable).toBe(0);
        expect(result.applicabilityDistribution.applicable).toBe(5);
    });

    it('folds statusGroups into a Record + computes totalControls', async () => {
        setupBaseline({
            statusGroups: [
                { status: 'IMPLEMENTED', _count: { _all: 4 } },
                { status: 'NOT_STARTED', _count: { _all: 6 } },
            ],
        });
        const result = await getControlDashboard(ctx);
        expect(result.totalControls).toBe(10);
        expect(result.statusDistribution).toEqual({ IMPLEMENTED: 4, NOT_STARTED: 6 });
    });

    it('topOwners: top 5 by openTasks, descending; skips controls with null owner', async () => {
        setupBaseline({
            openTasksByControl: [
                { controlId: 'c-1', _count: { _all: 10 } },
                { controlId: 'c-2', _count: { _all: 5 } },
                { controlId: 'c-3', _count: { _all: 100 } },
                { controlId: null, _count: { _all: 999 } }, // null key — skipped
            ],
            controlOwners: [
                { id: 'c-1', owner: { id: 'u-A', name: 'Alice' } },
                { id: 'c-2', owner: { id: 'u-A', name: 'Alice' } }, // same owner, accumulates
                { id: 'c-3', owner: { id: 'u-B', name: 'Bob' } },
                { id: 'c-noowner', owner: null }, // owner-skip branch
            ],
        });

        const result = await getControlDashboard(ctx);

        expect(result.topOwners).toEqual([
            { id: 'u-B', name: 'Bob', openTasks: 100 },
            { id: 'u-A', name: 'Alice', openTasks: 15 },
        ]);
    });

    it('owner with no name displays as "Unknown"', async () => {
        setupBaseline({
            openTasksByControl: [{ controlId: 'c-1', _count: { _all: 3 } }],
            controlOwners: [{ id: 'c-1', owner: { id: 'u-X', name: null } }],
        });
        const result = await getControlDashboard(ctx);
        expect(result.topOwners[0].name).toBe('Unknown');
    });
});

// ──────────────────────────────────────────────────────────────────────
// runConsistencyCheck — RBAC + aggregation branches
// ──────────────────────────────────────────────────────────────────────
describe('runConsistencyCheck', () => {
    it('REJECTS AUDITOR (admins-only via inline role check)', async () => {
        await expect(runConsistencyCheck(makeRequestContext('AUDITOR'))).rejects.toThrow(/only admins/i);
    });

    it('REJECTS EDITOR', async () => {
        await expect(runConsistencyCheck(makeRequestContext('EDITOR'))).rejects.toThrow(/only admins/i);
    });

    it('REJECTS READER', async () => {
        await expect(runConsistencyCheck(makeRequestContext('READER'))).rejects.toThrow(/only admins/i);
    });

    it('ADMIN allowed — produces all 3 issue classes (missingCode, duplicateCodes, overdueTasks)', async () => {
        tenantDb.control.findMany.mockResolvedValueOnce([
            { id: 'c-1', code: '', name: 'No Code' },              // missingCode
            { id: 'c-2', code: 'CC1', name: 'A' },                 // duplicate of c-3
            { id: 'c-3', code: 'CC1', name: 'B' },                 // duplicate of c-2
            { id: 'c-4', code: 'CC2', name: 'Unique' },
        ]);
        tenantDb.control.count.mockResolvedValueOnce(4);
        tenantDb.controlTask.findMany.mockResolvedValueOnce([
            { id: 't-1', title: 'Late', status: 'OPEN', dueAt: new Date('2020-01-01'),
              controlId: 'c-2', control: { code: 'CC1' } },
        ]);

        const result = await runConsistencyCheck(ctx);

        expect(result.totalControls).toBe(4);
        expect(result.summary).toEqual({
            missingCodeCount: 1,
            duplicateCodeCount: 1,
            overdueTaskCount: 1,
        });
        expect(result.issues.missingCode).toEqual([{ id: 'c-1', name: 'No Code' }]);
        expect(result.issues.duplicateCodes).toEqual([{ code: 'CC1', controlIds: ['c-2', 'c-3'] }]);
        expect(result.issues.overdueTasks[0]).toMatchObject({
            controlId: 'c-2', controlCode: 'CC1', taskTitle: 'Late',
        });
    });

    it('OWNER allowed (Epic 1 — OWNER is a superset of ADMIN)', async () => {
        tenantDb.control.findMany.mockResolvedValueOnce([]);
        tenantDb.control.count.mockResolvedValueOnce(0);
        tenantDb.controlTask.findMany.mockResolvedValueOnce([]);

        const result = await runConsistencyCheck(makeRequestContext('OWNER'));

        expect(result.summary.missingCodeCount).toBe(0);
    });

    it('empty inputs produce zero-counts shape (no NaN / no exception)', async () => {
        tenantDb.control.findMany.mockResolvedValueOnce([]);
        tenantDb.control.count.mockResolvedValueOnce(0);
        tenantDb.controlTask.findMany.mockResolvedValueOnce([]);

        const result = await runConsistencyCheck(ctx);

        expect(result.summary).toEqual({
            missingCodeCount: 0,
            duplicateCodeCount: 0,
            overdueTaskCount: 0,
        });
    });

    it('overdueTask with null control.code is preserved (defensive null pass-through)', async () => {
        tenantDb.control.findMany.mockResolvedValueOnce([]);
        tenantDb.control.count.mockResolvedValueOnce(1);
        tenantDb.controlTask.findMany.mockResolvedValueOnce([
            { id: 't-1', title: 'X', status: 'OPEN', dueAt: new Date('2020-01-01'),
              controlId: 'c-orphan', control: null },
        ]);

        const result = await runConsistencyCheck(ctx);

        expect(result.issues.overdueTasks[0].controlCode).toBeNull();
    });
});

// ──────────────────────────────────────────────────────────────────────
// listControlsWithDeleted — admin-only gate
// ──────────────────────────────────────────────────────────────────────
describe('listControlsWithDeleted', () => {
    it('asserts admin permission', async () => {
        tenantDb.control.findMany.mockResolvedValueOnce([]);
        await listControlsWithDeleted(ctx);
        expect(policyCalls).toEqual(['admin']);
    });

    it('includes soft-deleted rows via withDeleted wrapper', async () => {
        tenantDb.control.findMany.mockResolvedValueOnce([{ id: 'c-1' }]);
        await listControlsWithDeleted(ctx);

        // The withDeleted mock decorates the query with includeDeleted:true.
        const args = tenantDb.control.findMany.mock.calls[0][0];
        expect(args.includeDeleted).toBe(true);
    });
});
