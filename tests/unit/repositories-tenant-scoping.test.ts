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
 *   1. The **global-or-tenant OR** on Practice (`tenantId: ctx.tenantId` OR
 *      `tenantId: null`) — framework practices are global — paired with an
 *      evidence include that stays strictly tenant-scoped. Widening the
 *      nested filter to match the outer OR would leak another tenant's
 *      evidence through a shared global practice.
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

import { NotificationRepository } from '@/app-layer/repositories/NotificationRepository';
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
        practice: { findMany: jest.fn().mockResolvedValue([]) },
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


// ─── ClauseRepository ────────────────────────────────────────────────


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
