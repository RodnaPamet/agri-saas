/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks + fake DB. */
/**
 * Unit tests for `src/app-layer/usecases/practice/queries.ts` —
 * the practice read + dashboard + consistency-check surface.
 *
 * Wave-8b / stage-3f branch coverage (paired with
 * framework-coverage in the same PR). Branch matrix:
 *
 *   listPractices / listPracticesPaginated: cache wrapper passthroughs
 *   getPractice:        notFound vs happy
 *   getPracticeHeader:  notFound + donePracticeTasks computed +
 *                      header decorated with the count
 *   getPracticeActivity: practice not-found vs happy (audit log read)
 *   getPracticeDashboard:
 *     - statusDistribution fold
 *     - applicabilityOf default 0 when group missing
 *     - implementationProgress 0-guard when applicableCount === 0
 *     - topOwners top-5 sort + owner-skip when c.owner null
 *     - openByPractice null-key skip
 *   runConsistencyCheck:
 *     - RBAC: OWNER + ADMIN allowed
 *     - RBAC: AUDITOR rejected
 *     - missingCode filter + duplicateCodes grouping
 *     - overdueTasks reshape
 *   listPracticesWithDeleted: assertCanAdmin gate
 */

const policyCalls: string[] = [];

jest.mock('@/app-layer/policies/practice.policies', () => ({
    assertCanReadPractices: jest.fn(() => policyCalls.push('read')),
}));

jest.mock('@/app-layer/policies/common', () => ({
    assertCanAdmin: jest.fn(() => policyCalls.push('admin')),
}));

jest.mock('@/app-layer/repositories/PracticeRepository', () => ({
    PracticeRepository: {
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
    practice: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
    practiceTask: { count: jest.fn(), groupBy: jest.fn(), findMany: jest.fn() },
    auditLog: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, cb: any) => cb(tenantDb)),
    };
});

// getPracticeHeader now derives the Tasks-tab badge + progress from the
// unified-task count (matching LinkedTasksPanel) via this repo method.
jest.mock('@/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: {
        countLinkedToPractice: jest.fn(),
        countLinkedToPractices: jest.fn(),
    },
}));

import {
    listPractices,
    listPracticesPaginated,
    getPractice,
    getPracticeHeader,
    getPracticeActivity,
    getPracticeDashboard,
    runConsistencyCheck,
    listPracticesWithDeleted,
} from '@/app-layer/usecases/practice/queries';
import { PracticeRepository } from '@/app-layer/repositories/PracticeRepository';
import { WorkItemRepository } from '@/app-layer/repositories/WorkItemRepository';
import { assertCanReadPractices } from '@/app-layer/policies/practice.policies';
import { assertCanAdmin } from '@/app-layer/policies/common';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    policyCalls.length = 0;
    [
        PracticeRepository.list, PracticeRepository.listPaginated,
        PracticeRepository.getById, PracticeRepository.getHeaderById,
        tenantDb.practice.findMany, tenantDb.practice.count, tenantDb.practice.groupBy,
        tenantDb.practiceTask.count, tenantDb.practiceTask.groupBy, tenantDb.practiceTask.findMany,
        tenantDb.auditLog.findMany,
        WorkItemRepository.countLinkedToPractice as jest.Mock,
        WorkItemRepository.countLinkedToPractices as jest.Mock,
        assertCanReadPractices as jest.Mock,
        assertCanAdmin as jest.Mock,
    ].forEach((m: any) => m.mockReset && m.mockReset());
    (assertCanReadPractices as jest.Mock).mockImplementation(() => policyCalls.push('read'));
    (assertCanAdmin as jest.Mock).mockImplementation(() => policyCalls.push('admin'));
});

// `practiceTask.count` (getPracticeHeader's legacy done count, unused
// now) + `countLinkedToPractices` (listPractices' unified per-practice
// counts) need addressable defaults so the cache passthrough tests
// don't NPE on the merge.
beforeEach(() => {
    tenantDb.practiceTask.count.mockResolvedValue(0);
    (WorkItemRepository.countLinkedToPractices as jest.Mock).mockResolvedValue(
        new Map(),
    );
});

const ctx = makeRequestContext('ADMIN');

// ──────────────────────────────────────────────────────────────────────
// listPractices / listPracticesPaginated — cache passthrough
// ──────────────────────────────────────────────────────────────────────
describe('listPractices', () => {
    it('asserts read permission BEFORE the repo call', async () => {
        (PracticeRepository.list as jest.Mock).mockResolvedValueOnce([]);
        await listPractices(ctx, { status: ['IMPLEMENTED'] });
        expect(policyCalls).toEqual(['read']);
    });

    it('threads filters through + merges unified per-practice task counts', async () => {
        (PracticeRepository.list as jest.Mock).mockResolvedValueOnce([
            { id: 'c-1' },
            { id: 'c-2' },
        ]);
        (
            WorkItemRepository.countLinkedToPractices as jest.Mock
        ).mockResolvedValueOnce(
            new Map([['c-1', { total: 4, done: 1 }]]),
        );
        const result = await listPractices(ctx, { q: 'test' }, { take: 50 });
        // c-1 gets its unified counts; c-2 (absent from the map) → 0/0.
        expect(result).toEqual([
            { id: 'c-1', taskTotal: 4, taskDone: 1 },
            { id: 'c-2', taskTotal: 0, taskDone: 0 },
        ]);
        expect(WorkItemRepository.countLinkedToPractices).toHaveBeenCalledWith(
            tenantDb,
            ctx,
            ['c-1', 'c-2'],
        );
    });
});

describe('listPracticesPaginated', () => {
    it('threads limit + cursor through to the repo', async () => {
        (PracticeRepository.listPaginated as jest.Mock).mockResolvedValueOnce({ rows: [], cursor: null });
        const result = await listPracticesPaginated(ctx, { limit: 10, cursor: 'abc' });
        expect(result).toEqual({ rows: [], cursor: null });
    });
});

// ──────────────────────────────────────────────────────────────────────
// getPractice / getPracticeHeader / getPracticeActivity
// ──────────────────────────────────────────────────────────────────────
describe('getPractice', () => {
    it('throws notFound for a missing practice', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValueOnce(null);
        await expect(getPractice(ctx, 'c-foreign')).rejects.toThrow(/practice not found/i);
    });

    it('returns the practice on happy-path', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValueOnce({ id: 'c-1', code: 'CC1' });
        const result = await getPractice(ctx, 'c-1');
        expect(result).toEqual({ id: 'c-1', code: 'CC1' });
    });
});

describe('getPracticeHeader', () => {
    it('throws notFound for a missing practice', async () => {
        (PracticeRepository.getHeaderById as jest.Mock).mockResolvedValueOnce(null);
        await expect(getPracticeHeader(ctx, 'c-foreign')).rejects.toThrow(/practice not found/i);
    });

    it('derives the Tasks badge + progress from the unified linked-task count', async () => {
        (PracticeRepository.getHeaderById as jest.Mock).mockResolvedValueOnce({
            id: 'c-1',
            code: 'CC1',
            _count: { practiceTasks: 0, evidenceLinks: 1, evidence: 2, frameworkMappings: 3 },
        });
        (WorkItemRepository.countLinkedToPractice as jest.Mock).mockResolvedValueOnce({
            total: 5,
            done: 2,
        });

        const result = await getPracticeHeader(ctx, 'c-1');

        // Tab badge reads `_count.practiceTasks` — overridden to the
        // unified total (5), NOT the stale legacy relation count (0).
        // Other `_count` entries are preserved. Progress = done (2).
        expect(result).toEqual({
            id: 'c-1',
            code: 'CC1',
            _count: { practiceTasks: 5, evidenceLinks: 1, evidence: 2, frameworkMappings: 3 },
            donePracticeTasks: 2,
        });
        expect(WorkItemRepository.countLinkedToPractice).toHaveBeenCalledWith(
            tenantDb,
            ctx,
            'c-1',
        );
    });
});

describe('getPracticeActivity', () => {
    it('throws notFound when the practice is missing', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValueOnce(null);
        await expect(getPracticeActivity(ctx, 'c-foreign')).rejects.toThrow(/practice not found/i);
    });

    it('returns the audit log scoped to (tenant, Practice, practiceId) limit 50', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValueOnce({ id: 'c-1' });
        tenantDb.auditLog.findMany.mockResolvedValueOnce([{ id: 'a-1' }]);

        const result = await getPracticeActivity(ctx, 'c-1');

        expect(result).toEqual([{ id: 'a-1' }]);
        const args = tenantDb.auditLog.findMany.mock.calls[0][0];
        expect(args.where).toMatchObject({ tenantId: 'tenant-1', entity: 'Practice', entityId: 'c-1' });
        expect(args.take).toBe(50);
    });
});

// ──────────────────────────────────────────────────────────────────────
// getPracticeDashboard — branch-heavy aggregator
// ──────────────────────────────────────────────────────────────────────
describe('getPracticeDashboard', () => {
    function setupBaseline(opts: {
        statusGroups?: any[];
        applicabilityGroups?: any[];
        implementedCount?: number;
        dueSoonCount?: number;
        overdueTasks?: number;
        openTasksByPractice?: any[];
        practiceOwners?: any[];
    }) {
        tenantDb.practice.groupBy
            .mockResolvedValueOnce(opts.statusGroups ?? [])
            .mockResolvedValueOnce(opts.applicabilityGroups ?? []);
        tenantDb.practice.count
            .mockResolvedValueOnce(opts.implementedCount ?? 0)
            .mockResolvedValueOnce(opts.dueSoonCount ?? 0);
        tenantDb.practiceTask.count.mockResolvedValueOnce(opts.overdueTasks ?? 0);
        tenantDb.practiceTask.groupBy.mockResolvedValueOnce(opts.openTasksByPractice ?? []);
        tenantDb.practice.findMany.mockResolvedValueOnce(opts.practiceOwners ?? []);
    }

    it('returns implementationProgress=0 when applicableCount === 0 (NaN guard)', async () => {
        setupBaseline({ implementedCount: 0, applicabilityGroups: [] });
        const result = await getPracticeDashboard(ctx);
        expect(result.implementationProgress).toBe(0);
    });

    it('rounds implementationProgress: implemented/applicable × 100', async () => {
        setupBaseline({
            applicabilityGroups: [{ applicability: 'APPLICABLE', _count: { _all: 10 } }],
            implementedCount: 7,
        });
        const result = await getPracticeDashboard(ctx);
        expect(result.implementationProgress).toBe(70);
        expect(result.applicableCount).toBe(10);
    });

    it('applicabilityOf defaults to 0 when the group is missing', async () => {
        setupBaseline({
            applicabilityGroups: [{ applicability: 'APPLICABLE', _count: { _all: 5 } }],
        });
        const result = await getPracticeDashboard(ctx);
        expect(result.applicabilityDistribution.notApplicable).toBe(0);
        expect(result.applicabilityDistribution.applicable).toBe(5);
    });

    it('folds statusGroups into a Record + computes totalPractices', async () => {
        setupBaseline({
            statusGroups: [
                { status: 'IMPLEMENTED', _count: { _all: 4 } },
                { status: 'NOT_STARTED', _count: { _all: 6 } },
            ],
        });
        const result = await getPracticeDashboard(ctx);
        expect(result.totalPractices).toBe(10);
        expect(result.statusDistribution).toEqual({ IMPLEMENTED: 4, NOT_STARTED: 6 });
    });

    it('topOwners: top 5 by openTasks, descending; skips practices with null owner', async () => {
        setupBaseline({
            openTasksByPractice: [
                { practiceId: 'c-1', _count: { _all: 10 } },
                { practiceId: 'c-2', _count: { _all: 5 } },
                { practiceId: 'c-3', _count: { _all: 100 } },
                { practiceId: null, _count: { _all: 999 } }, // null key — skipped
            ],
            practiceOwners: [
                { id: 'c-1', owner: { id: 'u-A', name: 'Alice' } },
                { id: 'c-2', owner: { id: 'u-A', name: 'Alice' } }, // same owner, accumulates
                { id: 'c-3', owner: { id: 'u-B', name: 'Bob' } },
                { id: 'c-noowner', owner: null }, // owner-skip branch
            ],
        });

        const result = await getPracticeDashboard(ctx);

        expect(result.topOwners).toEqual([
            { id: 'u-B', name: 'Bob', openTasks: 100 },
            { id: 'u-A', name: 'Alice', openTasks: 15 },
        ]);
    });

    it('owner with no name displays as "Unknown"', async () => {
        setupBaseline({
            openTasksByPractice: [{ practiceId: 'c-1', _count: { _all: 3 } }],
            practiceOwners: [{ id: 'c-1', owner: { id: 'u-X', name: null } }],
        });
        const result = await getPracticeDashboard(ctx);
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
        tenantDb.practice.findMany.mockResolvedValueOnce([
            { id: 'c-1', code: '', name: 'No Code' },              // missingCode
            { id: 'c-2', code: 'CC1', name: 'A' },                 // duplicate of c-3
            { id: 'c-3', code: 'CC1', name: 'B' },                 // duplicate of c-2
            { id: 'c-4', code: 'CC2', name: 'Unique' },
        ]);
        tenantDb.practice.count.mockResolvedValueOnce(4);
        tenantDb.practiceTask.findMany.mockResolvedValueOnce([
            { id: 't-1', title: 'Late', status: 'OPEN', dueAt: new Date('2020-01-01'),
              practiceId: 'c-2', practice: { code: 'CC1' } },
        ]);

        const result = await runConsistencyCheck(ctx);

        expect(result.totalPractices).toBe(4);
        expect(result.summary).toEqual({
            missingCodeCount: 1,
            duplicateCodeCount: 1,
            overdueTaskCount: 1,
        });
        expect(result.issues.missingCode).toEqual([{ id: 'c-1', name: 'No Code' }]);
        expect(result.issues.duplicateCodes).toEqual([{ code: 'CC1', practiceIds: ['c-2', 'c-3'] }]);
        expect(result.issues.overdueTasks[0]).toMatchObject({
            practiceId: 'c-2', practiceCode: 'CC1', taskTitle: 'Late',
        });
    });

    it('OWNER allowed (Epic 1 — OWNER is a superset of ADMIN)', async () => {
        tenantDb.practice.findMany.mockResolvedValueOnce([]);
        tenantDb.practice.count.mockResolvedValueOnce(0);
        tenantDb.practiceTask.findMany.mockResolvedValueOnce([]);

        const result = await runConsistencyCheck(makeRequestContext('OWNER'));

        expect(result.summary.missingCodeCount).toBe(0);
    });

    it('empty inputs produce zero-counts shape (no NaN / no exception)', async () => {
        tenantDb.practice.findMany.mockResolvedValueOnce([]);
        tenantDb.practice.count.mockResolvedValueOnce(0);
        tenantDb.practiceTask.findMany.mockResolvedValueOnce([]);

        const result = await runConsistencyCheck(ctx);

        expect(result.summary).toEqual({
            missingCodeCount: 0,
            duplicateCodeCount: 0,
            overdueTaskCount: 0,
        });
    });

    it('overdueTask with null practice.code is preserved (defensive null pass-through)', async () => {
        tenantDb.practice.findMany.mockResolvedValueOnce([]);
        tenantDb.practice.count.mockResolvedValueOnce(1);
        tenantDb.practiceTask.findMany.mockResolvedValueOnce([
            { id: 't-1', title: 'X', status: 'OPEN', dueAt: new Date('2020-01-01'),
              practiceId: 'c-orphan', practice: null },
        ]);

        const result = await runConsistencyCheck(ctx);

        expect(result.issues.overdueTasks[0].practiceCode).toBeNull();
    });
});

// ──────────────────────────────────────────────────────────────────────
// listPracticesWithDeleted — admin-only gate
// ──────────────────────────────────────────────────────────────────────
describe('listPracticesWithDeleted', () => {
    it('asserts admin permission', async () => {
        tenantDb.practice.findMany.mockResolvedValueOnce([]);
        await listPracticesWithDeleted(ctx);
        expect(policyCalls).toEqual(['admin']);
    });

    it('includes soft-deleted rows via withDeleted wrapper', async () => {
        tenantDb.practice.findMany.mockResolvedValueOnce([{ id: 'c-1' }]);
        await listPracticesWithDeleted(ctx);

        // The withDeleted mock decorates the query with includeDeleted:true.
        const args = tenantDb.practice.findMany.mock.calls[0][0];
        expect(args.includeDeleted).toBe(true);
    });
});
