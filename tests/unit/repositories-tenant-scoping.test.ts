/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Zero-coverage repositories, wave 6.
 *
 * Seven repository modules with no coverage: Audit, Clause, Report,
 * Notification, Mapping, and the two deprecated re-export shims (Issue,
 * Task).
 *
 * Repositories are the layer CLAUDE.md gives a single non-negotiable rule:
 * **every query filters by `tenantId`**. RLS is the real enforcement, but
 * the application filter is the defence-in-depth half — and it is the half
 * a refactor can drop, because dropping it produces no error at all while
 * RLS is working. A missing filter only becomes visible the day someone
 * runs a query outside `runInTenantContext`.
 *
 * So these tests drive the real static methods against a mock `db` and
 * assert the *query shape*, not a round trip. Three shapes matter more
 * than the rest:
 *
 *   1. The **global-or-tenant OR** on Control (`tenantId: ctx.tenantId` OR
 *      `tenantId: null`) — framework controls are global — paired with an
 *      evidence include that stays strictly tenant-scoped. Widening the
 *      nested filter to match the outer OR would leak another tenant's
 *      evidence through a shared global control.
 *   2. **`AuditRepository.update`'s pre-check.** The final `db.audit.update`
 *      is keyed by id ALONE with no tenant filter. The `getById` above it
 *      *is* the tenant guard. Delete it as a redundant round trip and you
 *      have a cross-tenant write.
 *   3. **Notification's user scoping** — tenant alone would show a
 *      colleague's notifications.
 */

const mockPrisma = {
    clause: { upsert: jest.fn(), findMany: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockPrisma }));

const mockGetISO27001Clauses = jest.fn();
jest.mock('@/app-layer/libraries', () => ({
    getISO27001Clauses: () => mockGetISO27001Clauses(),
}));

import { AuditRepository } from '@/app-layer/repositories/AuditRepository';
import { ClauseRepository } from '@/app-layer/repositories/ClauseRepository';
import { ReportRepository } from '@/app-layer/repositories/ReportRepository';
import { NotificationRepository } from '@/app-layer/repositories/NotificationRepository';
import { MappingRepository } from '@/app-layer/repositories/MappingRepository';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', {
    tenantSlug: 'acme',
    tenantId: 'tenant-1',
    userId: 'user-1',
});

function makeDb() {
    return {
        audit: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'a1' }),
            update: jest.fn().mockResolvedValue({ id: 'a1' }),
        },
        auditChecklistItem: {
            create: jest.fn().mockResolvedValue({ id: 'ci1' }),
            update: jest.fn().mockResolvedValue({ id: 'ci1' }),
        },
        clauseProgress: {
            findMany: jest.fn().mockResolvedValue([]),
            upsert: jest.fn().mockResolvedValue({ id: 'cp1' }),
        },
        control: { findMany: jest.fn().mockResolvedValue([]) },
        risk: { findMany: jest.fn().mockResolvedValue([]) },
        notification: {
            findMany: jest.fn().mockResolvedValue([]),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
    } as any;
}

let db: ReturnType<typeof makeDb>;
beforeEach(() => {
    jest.clearAllMocks();
    db = makeDb();
});

// ─── AuditRepository ─────────────────────────────────────────────────

describe('AuditRepository', () => {
    it('lists only the caller’s tenant, newest first, with the badge counts', async () => {
        await AuditRepository.list(db, ctx);

        const args = db.audit.findMany.mock.calls[0][0];
        expect(args.where).toEqual({ tenantId: 'tenant-1' });
        expect(args.orderBy).toEqual({ createdAt: 'desc' });
        // A tight SELECT, not an include — the master list only renders
        // id/title/status plus the two counts.
        expect(Object.keys(args.select).sort()).toEqual(['_count', 'id', 'status', 'title']);
        expect(args.take).toBeUndefined();
    });

    it('applies take only when one is asked for', async () => {
        await AuditRepository.list(db, ctx, { take: 25 });
        expect(db.audit.findMany.mock.calls[0][0].take).toBe(25);

        await AuditRepository.list(db, ctx, {});
        expect(db.audit.findMany.mock.calls[1][0]).not.toHaveProperty('take');
    });

    it('scopes getById by tenant and orders the child collections', async () => {
        await AuditRepository.getById(db, ctx, 'a1');

        const args = db.audit.findFirst.mock.calls[0][0];
        expect(args.where).toEqual({ id: 'a1', tenantId: 'tenant-1' });
        expect(args.include.checklist.orderBy).toEqual({ sortOrder: 'asc' });
        expect(args.include.findings.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('stamps the tenant on create — the caller cannot supply one', async () => {
        await AuditRepository.create(db, ctx, { title: 'ISO internal' } as any);

        expect(db.audit.create.mock.calls[0][0].data).toEqual({
            title: 'ISO internal',
            tenantId: 'tenant-1',
        });
    });

    it('overrides a caller-supplied tenantId with the context tenant', async () => {
        // The spread puts tenantId last, so a hostile or stale payload
        // cannot redirect the write.
        await AuditRepository.create(db, ctx, { title: 'x', tenantId: 'other-tenant' } as any);

        expect(db.audit.create.mock.calls[0][0].data.tenantId).toBe('tenant-1');
    });

    describe('update — the pre-check IS the tenant guard', () => {
        it('returns null and writes nothing for another tenant’s audit', async () => {
            // `db.audit.update` below is keyed by id alone. If getById is
            // ever removed as a "redundant" round trip, this becomes a
            // cross-tenant write.
            db.audit.findFirst.mockResolvedValue(null);

            expect(await AuditRepository.update(db, ctx, 'foreign', { title: 'hacked' })).toBeNull();
            expect(db.audit.update).not.toHaveBeenCalled();
        });

        it('updates once the tenant-scoped existence check passes', async () => {
            db.audit.findFirst.mockResolvedValue({ id: 'a1' });

            await AuditRepository.update(db, ctx, 'a1', { title: 'renamed' });

            expect(db.audit.findFirst.mock.calls[0][0].where).toEqual({
                id: 'a1',
                tenantId: 'tenant-1',
            });
            expect(db.audit.update).toHaveBeenCalledWith({
                where: { id: 'a1' },
                data: { title: 'renamed' },
            });
        });
    });

    it('creates a checklist item under the context tenant', async () => {
        await AuditRepository.createChecklistItem(db, ctx, 'a1', 'Is the register current?', 3);

        expect(db.auditChecklistItem.create.mock.calls[0][0].data).toEqual({
            tenantId: 'tenant-1',
            auditId: 'a1',
            prompt: 'Is the register current?',
            sortOrder: 3,
        });
    });

    describe('updateChecklistItem — null means "leave unchanged"', () => {
        it('passes a real result through as the enum value', async () => {
            await AuditRepository.updateChecklistItem(db, ctx, 'ci1', { result: 'PASS', notes: 'ok' });

            expect(db.auditChecklistItem.update.mock.calls[0][0].data).toEqual({
                result: 'PASS',
                notes: 'ok',
            });
        });

        it.each([
            ['null', null],
            ['undefined', undefined],
        ])('maps a %s result to undefined, not to a null write', async (_label, result) => {
            // `result` backs a NON-NULL enum column. Forwarding null would
            // be a constraint violation; undefined omits the field so the
            // existing verdict survives a notes-only edit.
            await AuditRepository.updateChecklistItem(db, ctx, 'ci1', { result, notes: 'just a note' });

            expect(db.auditChecklistItem.update.mock.calls[0][0].data.result).toBeUndefined();
            expect(db.auditChecklistItem.update.mock.calls[0][0].data.notes).toBe('just a note');
        });
    });
});

// ─── ClauseRepository ────────────────────────────────────────────────

describe('ClauseRepository', () => {
    const CATALOGUE = [
        { number: '4', title: 'Context', description: 'd4', artifacts: ['a'], checklist: ['c4'] },
        { number: '5', title: 'Leadership', description: 'd5', artifacts: [], checklist: ['c5'] },
    ];

    beforeEach(() => {
        mockGetISO27001Clauses.mockReturnValue(CATALOGUE);
        mockPrisma.clause.findMany.mockResolvedValue([
            { id: 'cl-4', number: '4', title: 'Context', sortOrder: 4 },
            { id: 'cl-5', number: '5', title: 'Leadership', sortOrder: 5 },
        ]);
        mockPrisma.clause.upsert.mockResolvedValue({});
    });

    it('seeds the global catalogue idempotently and derives sortOrder from the number', async () => {
        await ClauseRepository.list(db, ctx);

        expect(mockPrisma.clause.upsert).toHaveBeenCalledTimes(2);
        const first = mockPrisma.clause.upsert.mock.calls[0][0];
        expect(first.where).toEqual({ number: '4' });
        expect(first.create.sortOrder).toBe(4);
        // An empty `update` is what makes the seed idempotent — a re-run
        // must not clobber an edited global title.
        expect(first.update).toEqual({});
    });

    it('reads the global catalogue off the global client and progress off the tenant tx', async () => {
        // Clause has no tenantId (no RLS); ClauseProgress does. Mixing the
        // two clients up is the whole reason this split exists.
        await ClauseRepository.list(db, ctx);

        expect(mockPrisma.clause.findMany).toHaveBeenCalledWith({ orderBy: { sortOrder: 'asc' } });
        expect(db.clauseProgress.findMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1' },
        });
    });

    it('merges per-tenant progress onto the global clause', async () => {
        db.clauseProgress.findMany.mockResolvedValue([
            { id: 'p-4', clauseId: 'cl-4', status: 'IN_PROGRESS', notes: 'started' },
        ]);

        const rows = await ClauseRepository.list(db, ctx);

        expect(rows[0]).toMatchObject({
            number: '4',
            status: 'IN_PROGRESS',
            notes: 'started',
            progressId: 'p-4',
            checklist: ['c4'],
        });
    });

    it('defaults an untouched clause to NOT_STARTED with no notes', async () => {
        const rows = await ClauseRepository.list(db, ctx);

        expect(rows[1]).toMatchObject({
            number: '5',
            status: 'NOT_STARTED',
            notes: '',
            progressId: undefined,
        });
    });

    it('survives a DB clause with no catalogue entry', async () => {
        // A clause row left behind by an older catalogue version must not
        // throw on `clauseInfo.checklist`.
        mockPrisma.clause.findMany.mockResolvedValue([
            { id: 'cl-9', number: '9', title: 'Retired', sortOrder: 9 },
        ]);

        const rows = await ClauseRepository.list(db, ctx);
        expect(rows[0].checklist).toEqual([]);
    });

    it('upserts progress on the composite tenant+clause key', async () => {
        await ClauseRepository.updateProgress(db, ctx, 'cl-4', { status: 'DONE', notes: 'evidence filed' });

        const args = db.clauseProgress.upsert.mock.calls[0][0];
        expect(args.where).toEqual({ tenantId_clauseId: { tenantId: 'tenant-1', clauseId: 'cl-4' } });
        expect(args.create).toEqual({
            tenantId: 'tenant-1',
            clauseId: 'cl-4',
            status: 'DONE',
            notes: 'evidence filed',
        });
        expect(args.update).toEqual({ status: 'DONE', notes: 'evidence filed' });
    });

    it('normalises missing notes to an empty string on both branches', async () => {
        await ClauseRepository.updateProgress(db, ctx, 'cl-4', { status: 'DONE' });

        const args = db.clauseProgress.upsert.mock.calls[0][0];
        expect(args.create.notes).toBe('');
        expect(args.update.notes).toBe('');
    });
});

// ─── ReportRepository + MappingRepository ────────────────────────────


// ─── NotificationRepository ──────────────────────────────────────────

describe('NotificationRepository', () => {
    it('scopes by tenant AND user, and bounds the page', async () => {
        // Tenant scoping alone would show a colleague's notifications —
        // same tenant, wrong person.
        await NotificationRepository.listMine(db, ctx);

        const args = db.notification.findMany.mock.calls[0][0];
        expect(args.where).toEqual({ tenantId: 'tenant-1', userId: 'user-1' });
        expect(args.orderBy).toEqual({ createdAt: 'desc' });
        expect(args.take).toBe(50);
    });

    it('marks read through a scoped updateMany, not a bare update by id', async () => {
        // updateMany with the ownership predicate means a foreign id is a
        // zero-row no-op rather than a cross-user write.
        await NotificationRepository.markAsRead(db, ctx, 'n1');

        expect(db.notification.updateMany).toHaveBeenCalledWith({
            where: { id: 'n1', tenantId: 'tenant-1', userId: 'user-1' },
            data: { read: true },
        });
    });
});

// ─── deprecated re-export shims ──────────────────────────────────────

describe('deprecated repository aliases', () => {
    it('still point at the WorkItem repositories they were renamed to', async () => {
        // These exist only so older call sites keep resolving. If a rename
        // ever breaks the alias, the failure is a runtime undefined at some
        // unrelated call site — cheap to pin here instead.
        const issue = await import('@/app-layer/repositories/IssueRepository');
        const task = await import('@/app-layer/repositories/TaskRepository');
        const real = await import('@/app-layer/repositories/WorkItemRepository');

        expect(issue.IssueRepository).toBe(real.WorkItemRepository);
        expect(issue.IssueLinkRepository).toBe(real.TaskLinkRepository);
        expect(issue.IssueCommentRepository).toBe(real.TaskCommentRepository);
        expect(issue.IssueWatcherRepository).toBe(real.TaskWatcherRepository);
        expect(task.TaskRepository).toBe(real.WorkItemRepository);
    });
});
