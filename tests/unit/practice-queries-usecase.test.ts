/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio
 * (see tests/unit/practice-applicability.test.ts). */

/**
 * Unit tests for `src/app-layer/usecases/practice/queries.ts`.
 *
 * Roadmap Q1 — Compliance core. Mocks PracticeRepository +
 * WorkItemRepository + runInTenantContext + cachedListRead +
 * withDeleted. Exercises:
 *
 *   - listPractices — assertCanReadPractices gate, cachedListRead
 *     wiring, `take` participating in the cache key (SSR poison
 *     prevention), and the linked-task counts attachment.
 *   - listPracticesPaginated — delegation + cache wiring.
 *   - getPractice — happy path + notFound.
 *   - getPracticeHeader — happy + notFound + the `_count.practiceTasks`
 *     OVERRIDE with the unified WorkItem count (so the badge matches
 *     LinkedTasksPanel after #806 unification).
 *   - getPracticeActivity — pre-check on existence + audit log query.
 *   - getPracticeDashboard — the dashboard fan-out (`Promise.all` of 7
 *     queries, top-owner fold across two collections, implementation-
 *     progress math, edge cases at zero).
 *   - runConsistencyCheck — admin/owner gate (Epic 1 OWNER superset),
 *     missingCode/duplicateCode/overdue projections.
 *   - listPracticesWithDeleted — admin gate + withDeleted wrapping.
 */

const mockDb = {
    practice: {
        groupBy: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
    },
    practiceTask: {
        count: jest.fn(),
        groupBy: jest.fn(),
        findMany: jest.fn(),
    },
    auditLog: {
        findMany: jest.fn(),
    },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(async (opts: any) => opts.loader()),
}));

jest.mock('@/app-layer/repositories/PracticeRepository', () => ({
    PracticeRepository: {
        list: jest.fn(),
        listPaginated: jest.fn(),
        getById: jest.fn(),
        getHeaderById: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: {
        countLinkedToPractices: jest.fn(),
        countLinkedToPractice: jest.fn(),
    },
}));

jest.mock('@/lib/soft-delete', () => ({
    withDeleted: jest.fn((args: any) => ({ ...args, _withDeleted: true })),
}));

import { PracticeRepository } from '@/app-layer/repositories/PracticeRepository';
import { WorkItemRepository } from '@/app-layer/repositories/WorkItemRepository';
import { cachedListRead } from '@/lib/cache/list-cache';
// Direct import from queries.ts to skip the barrel — the barrel pulls
// `mutations.ts` which transitively imports the Prisma audit extension
// stack, defeating the mock seam. The structural ratchet in
// `tests/guardrails/usecase-test-coverage.test.ts` already accepts
// direct file imports.
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
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const ownerCtx = makeRequestContext('OWNER');
const adminCtx = makeRequestContext('ADMIN');
const editorCtx = makeRequestContext('EDITOR');
const readerCtx = makeRequestContext('READER');
const auditorCtx = makeRequestContext('AUDITOR');

// ─── listPractices ──────────────────────────────────────────────────

describe('listPractices', () => {
    it('returns repo rows merged with linked-task counts', async () => {
        (PracticeRepository.list as jest.Mock).mockResolvedValue([
            { id: 'c-1', name: 'A' },
            { id: 'c-2', name: 'B' },
        ]);
        (WorkItemRepository.countLinkedToPractices as jest.Mock).mockResolvedValue(
            new Map([
                ['c-1', { total: 3, done: 1 }],
                ['c-2', { total: 0, done: 0 }],
            ]),
        );

        const rows = await listPractices(readerCtx);

        expect(rows).toEqual([
            { id: 'c-1', name: 'A', taskTotal: 3, taskDone: 1 },
            { id: 'c-2', name: 'B', taskTotal: 0, taskDone: 0 },
        ]);
    });

    it('defaults missing counts to zero when a practice has no link rows', async () => {
        (PracticeRepository.list as jest.Mock).mockResolvedValue([{ id: 'c-1' }]);
        (WorkItemRepository.countLinkedToPractices as jest.Mock).mockResolvedValue(new Map());

        const rows = await listPractices(readerCtx);
        expect(rows[0]).toMatchObject({ taskTotal: 0, taskDone: 0 });
    });

    it('puts `take` into the cache key when supplied', async () => {
        (PracticeRepository.list as jest.Mock).mockResolvedValue([]);
        (WorkItemRepository.countLinkedToPractices as jest.Mock).mockResolvedValue(new Map());
        await listPractices(readerCtx, undefined, { take: 25 });
        const cacheArgs = (cachedListRead as jest.Mock).mock.calls[0][0];
        expect(cacheArgs.params).toEqual({ _take: 25 });
    });

    it('forwards filters into the cache key', async () => {
        (PracticeRepository.list as jest.Mock).mockResolvedValue([]);
        (WorkItemRepository.countLinkedToPractices as jest.Mock).mockResolvedValue(new Map());
        await listPractices(readerCtx, { status: ['IMPLEMENTED'], q: 'access' });
        const cacheArgs = (cachedListRead as jest.Mock).mock.calls[0][0];
        expect(cacheArgs.params).toEqual({ status: ['IMPLEMENTED'], q: 'access' });
    });
});

// ─── listPracticesPaginated ─────────────────────────────────────────

describe('listPracticesPaginated', () => {
    it('delegates to the paginated repository under the cache layer', async () => {
        (PracticeRepository.listPaginated as jest.Mock).mockResolvedValue({
            items: [],
            pageInfo: { hasNextPage: false, nextCursor: null },
        });

        const params = { limit: 50, cursor: 'cur', filters: {} };
        const res = await listPracticesPaginated(readerCtx, params);

        expect(res.items).toEqual([]);
        expect(PracticeRepository.listPaginated).toHaveBeenCalledWith(mockDb, readerCtx, params);
    });
});

// ─── getPractice ────────────────────────────────────────────────────

describe('getPractice', () => {
    it('returns the row on hit', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValue({ id: 'c-1', name: 'X' });
        const row = await getPractice(readerCtx, 'c-1');
        expect(row).toEqual({ id: 'c-1', name: 'X' });
    });

    it('throws notFound on miss', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(getPractice(readerCtx, 'missing')).rejects.toThrow(/Practice not found/i);
    });
});

// ─── getPracticeHeader ──────────────────────────────────────────────

describe('getPracticeHeader', () => {
    it('overrides _count.practiceTasks with the unified WorkItem total', async () => {
        (PracticeRepository.getHeaderById as jest.Mock).mockResolvedValue({
            id: 'c-1',
            _count: { practiceTasks: 0, evidenceLinks: 7 }, // legacy "0" — must be overridden
        });
        (WorkItemRepository.countLinkedToPractice as jest.Mock).mockResolvedValue({ total: 4, done: 2 });

        const header = await getPracticeHeader(readerCtx, 'c-1');

        expect(header._count.practiceTasks).toBe(4);
        expect(header._count.evidenceLinks).toBe(7);
        expect(header.donePracticeTasks).toBe(2);
    });

    it('throws notFound when the row does not exist', async () => {
        (PracticeRepository.getHeaderById as jest.Mock).mockResolvedValue(null);
        await expect(getPracticeHeader(readerCtx, 'missing')).rejects.toThrow(/Practice not found/i);
    });
});

// ─── getPracticeActivity ────────────────────────────────────────────

describe('getPracticeActivity', () => {
    it('returns up to 50 audit rows ordered desc with user select', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValue({ id: 'c-1' });
        (mockDb.auditLog.findMany as jest.Mock).mockResolvedValue([{ id: 'a-1' }]);

        const rows = await getPracticeActivity(readerCtx, 'c-1');

        expect(rows).toEqual([{ id: 'a-1' }]);
        const args = (mockDb.auditLog.findMany as jest.Mock).mock.calls[0][0];
        expect(args.where).toMatchObject({ entity: 'Practice', entityId: 'c-1' });
        expect(args.orderBy).toEqual({ createdAt: 'desc' });
        expect(args.take).toBe(50);
        expect(args.include?.user).toEqual({ select: { id: true, name: true } });
    });

    it('throws notFound when the practice does not exist (no audit query fires)', async () => {
        (PracticeRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(getPracticeActivity(readerCtx, 'missing')).rejects.toThrow(/Practice not found/i);
        expect(mockDb.auditLog.findMany).not.toHaveBeenCalled();
    });
});

// ─── getPracticeDashboard ───────────────────────────────────────────

describe('getPracticeDashboard', () => {
    it('aggregates the 7 parallel queries into the dashboard DTO', async () => {
        (mockDb.practice.groupBy as jest.Mock)
            .mockResolvedValueOnce([
                { status: 'IMPLEMENTED', _count: { _all: 4 } },
                { status: 'IN_PROGRESS', _count: { _all: 2 } },
            ])
            .mockResolvedValueOnce([
                { applicability: 'APPLICABLE', _count: { _all: 5 } },
                { applicability: 'NOT_APPLICABLE', _count: { _all: 1 } },
            ]);
        (mockDb.practice.count as jest.Mock)
            .mockResolvedValueOnce(3)  // implementedCount
            .mockResolvedValueOnce(2); // practicesDueSoon
        (mockDb.practiceTask.count as jest.Mock).mockResolvedValueOnce(4); // overdueTasks
        (mockDb.practiceTask.groupBy as jest.Mock).mockResolvedValueOnce([
            { practiceId: 'c-1', _count: { _all: 3 } },
            { practiceId: 'c-2', _count: { _all: 1 } },
        ]);
        (mockDb.practice.findMany as jest.Mock).mockResolvedValueOnce([
            { id: 'c-1', owner: { id: 'u-alice', name: 'Alice' } },
            { id: 'c-2', owner: { id: 'u-bob', name: 'Bob' } },
            { id: 'c-3', owner: null },
        ]);

        const dash = await getPracticeDashboard(readerCtx);

        expect(dash.totalPractices).toBe(6);
        expect(dash.statusDistribution).toEqual({ IMPLEMENTED: 4, IN_PROGRESS: 2 });
        expect(dash.applicabilityDistribution).toEqual({ applicable: 5, notApplicable: 1 });
        expect(dash.implementedCount).toBe(3);
        expect(dash.applicableCount).toBe(5);
        expect(dash.practicesDueSoon).toBe(2);
        expect(dash.overdueTasks).toBe(4);
        // implementation progress = round(3/5 * 100) = 60
        expect(dash.implementationProgress).toBe(60);
        // top owners — Alice 3, Bob 1; null-owner practices skipped
        expect(dash.topOwners).toEqual([
            { id: 'u-alice', name: 'Alice', openTasks: 3 },
            { id: 'u-bob', name: 'Bob', openTasks: 1 },
        ]);
    });

    it('handles zero applicable (no division by zero) — implementation progress is 0', async () => {
        (mockDb.practice.groupBy as jest.Mock)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ applicability: 'NOT_APPLICABLE', _count: { _all: 5 } }]);
        (mockDb.practice.count as jest.Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
        (mockDb.practiceTask.count as jest.Mock).mockResolvedValueOnce(0);
        (mockDb.practiceTask.groupBy as jest.Mock).mockResolvedValueOnce([]);
        (mockDb.practice.findMany as jest.Mock).mockResolvedValueOnce([]);

        const dash = await getPracticeDashboard(readerCtx);

        expect(dash.applicableCount).toBe(0);
        expect(dash.implementationProgress).toBe(0);
        expect(dash.topOwners).toEqual([]);
    });

    it('caps top owners at 5 and sorts descending by open-task count', async () => {
        (mockDb.practice.groupBy as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        (mockDb.practice.count as jest.Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
        (mockDb.practiceTask.count as jest.Mock).mockResolvedValueOnce(0);
        // 7 practices, each with 1 distinct owner, openTasks count 7..1
        const owners = [];
        const ownerProjections = [];
        for (let i = 7; i >= 1; i--) {
            owners.push({ practiceId: `c-${i}`, _count: { _all: i } });
            ownerProjections.push({ id: `c-${i}`, owner: { id: `u-${i}`, name: `User ${i}` } });
        }
        (mockDb.practiceTask.groupBy as jest.Mock).mockResolvedValueOnce(owners);
        (mockDb.practice.findMany as jest.Mock).mockResolvedValueOnce(ownerProjections);

        const dash = await getPracticeDashboard(readerCtx);
        expect(dash.topOwners).toHaveLength(5);
        // Highest first
        expect(dash.topOwners[0]).toEqual({ id: 'u-7', name: 'User 7', openTasks: 7 });
        expect(dash.topOwners[4]).toEqual({ id: 'u-3', name: 'User 3', openTasks: 3 });
    });

    it('owner name falls back to "Unknown" when null', async () => {
        (mockDb.practice.groupBy as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        (mockDb.practice.count as jest.Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
        (mockDb.practiceTask.count as jest.Mock).mockResolvedValueOnce(0);
        (mockDb.practiceTask.groupBy as jest.Mock).mockResolvedValueOnce([
            { practiceId: 'c-1', _count: { _all: 1 } },
        ]);
        (mockDb.practice.findMany as jest.Mock).mockResolvedValueOnce([
            { id: 'c-1', owner: { id: 'u-1', name: null } },
        ]);

        const dash = await getPracticeDashboard(readerCtx);
        expect(dash.topOwners[0].name).toBe('Unknown');
    });
});

// ─── runConsistencyCheck ───────────────────────────────────────────

describe('runConsistencyCheck', () => {
    it('rejects EDITOR (admin-or-owner gate)', async () => {
        await expect(runConsistencyCheck(editorCtx)).rejects.toThrow(/Only admins can run consistency checks/i);
        expect(mockDb.practice.findMany).not.toHaveBeenCalled();
    });

    it('rejects READER', async () => {
        await expect(runConsistencyCheck(readerCtx)).rejects.toThrow(/Only admins/i);
    });

    it('accepts OWNER (Epic 1 — OWNER superset of ADMIN)', async () => {
        (mockDb.practice.findMany as jest.Mock).mockResolvedValueOnce([]);
        (mockDb.practice.count as jest.Mock).mockResolvedValueOnce(0);
        (mockDb.practiceTask.findMany as jest.Mock).mockResolvedValueOnce([]);
        const res = await runConsistencyCheck(ownerCtx);
        expect(res.totalPractices).toBe(0);
    });

    it('accepts ADMIN', async () => {
        (mockDb.practice.findMany as jest.Mock).mockResolvedValueOnce([]);
        (mockDb.practice.count as jest.Mock).mockResolvedValueOnce(0);
        (mockDb.practiceTask.findMany as jest.Mock).mockResolvedValueOnce([]);
        const res = await runConsistencyCheck(adminCtx);
        expect(res.totalPractices).toBe(0);
    });

    it('detects missing-code practices (id, name shape)', async () => {
        (mockDb.practice.findMany as jest.Mock).mockResolvedValueOnce([
            { id: 'c-1', code: null, name: 'No Code' },
            { id: 'c-2', code: 'A.5', name: 'With Code' },
        ]);
        (mockDb.practice.count as jest.Mock).mockResolvedValueOnce(2);
        (mockDb.practiceTask.findMany as jest.Mock).mockResolvedValueOnce([]);

        const res = await runConsistencyCheck(adminCtx);

        expect(res.issues.missingCode).toEqual([{ id: 'c-1', name: 'No Code' }]);
        expect(res.summary.missingCodeCount).toBe(1);
    });

    it('detects duplicate-code practices', async () => {
        (mockDb.practice.findMany as jest.Mock).mockResolvedValueOnce([
            { id: 'c-1', code: 'A.5', name: 'one' },
            { id: 'c-2', code: 'A.5', name: 'two' },
            { id: 'c-3', code: 'A.6', name: 'unique' },
        ]);
        (mockDb.practice.count as jest.Mock).mockResolvedValueOnce(3);
        (mockDb.practiceTask.findMany as jest.Mock).mockResolvedValueOnce([]);

        const res = await runConsistencyCheck(adminCtx);

        expect(res.issues.duplicateCodes).toEqual([
            { code: 'A.5', practiceIds: ['c-1', 'c-2'] },
        ]);
    });

    it('projects overdue tasks into the DTO shape', async () => {
        (mockDb.practice.findMany as jest.Mock).mockResolvedValueOnce([]);
        (mockDb.practice.count as jest.Mock).mockResolvedValueOnce(0);
        (mockDb.practiceTask.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: 't-1',
                title: 'Rotate keys',
                status: 'OPEN',
                dueAt: new Date('2026-01-01'),
                practiceId: 'c-1',
                practice: { code: 'A.5' },
            },
        ]);

        const res = await runConsistencyCheck(adminCtx);

        expect(res.issues.overdueTasks).toEqual([
            {
                practiceId: 'c-1',
                practiceCode: 'A.5',
                taskId: 't-1',
                taskTitle: 'Rotate keys',
                dueAt: new Date('2026-01-01'),
                status: 'OPEN',
            },
        ]);
        expect(res.summary.overdueTaskCount).toBe(1);
    });
});

// ─── listPracticesWithDeleted ───────────────────────────────────────

describe('listPracticesWithDeleted', () => {
    it('returns rows including soft-deleted (withDeleted wrapper) for ADMIN', async () => {
        (mockDb.practice.findMany as jest.Mock).mockResolvedValue([{ id: 'c-1' }]);
        const rows = await listPracticesWithDeleted(adminCtx);
        expect(rows).toEqual([{ id: 'c-1' }]);
        const findManyArgs = (mockDb.practice.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyArgs._withDeleted).toBe(true);
    });

    it('rejects AUDITOR (admin gate, not audit)', async () => {
        await expect(listPracticesWithDeleted(auditorCtx)).rejects.toBeDefined();
        expect(mockDb.practice.findMany).not.toHaveBeenCalled();
    });

    it('rejects READER', async () => {
        await expect(listPracticesWithDeleted(readerCtx)).rejects.toBeDefined();
    });

    it('accepts OWNER (admin superset)', async () => {
        (mockDb.practice.findMany as jest.Mock).mockResolvedValue([]);
        await expect(listPracticesWithDeleted(ownerCtx)).resolves.toEqual([]);
    });
});
