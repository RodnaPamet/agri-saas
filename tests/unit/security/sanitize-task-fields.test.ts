/**
 * Write-path tests for `Task.description` and `Task.resolution` — the two
 * ENCRYPTED_FIELDS columns that were persisted RAW.
 *
 * Why a separate file from `sanitize-write-paths.test.ts`: that file drives
 * the two comment surfaces and mocks `WorkItemRepository` down to
 * `TaskCommentRepository.add`. These paths need the full work-item repository
 * plus the automation/notification emitters, and widening the other file's
 * mock set would put four passing tests at risk for no gain.
 *
 * The defect. `Task.description` / `Task.resolution` are listed in
 * `ENCRYPTED_FIELDS`, so Epic B encrypts them at rest — and encryption says
 * nothing about the PDF export, audit-pack share link or SDK consumer that
 * decrypts and renders them. The structural guardrail reported the model
 * covered because it asked a FILE-level question ("does task.ts call a
 * sanitiser anywhere?") and `task.ts` did — for a task-link note and a comment
 * body. Both real columns went through untouched. The guardrail now asks per
 * FIELD; this file is the executing half, because a guard that greps source
 * cannot tell you the value that reached the repository was clean.
 *
 * FOUR usecases write these columns and only one of them is `task.ts`:
 * `issue.ts` is the same `Task` row shape, `field-operation.ts` writes
 * `resolution` through `WorkItemRepository.setStatus` DIRECTLY (it never calls
 * `setTaskStatus`), and the retention job interpolates a user-supplied
 * evidence title into `description` with no request context upstream.
 */

// ─── Mocks ─────────────────────────────────────────────────────────

const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockSetStatus = jest.fn();
const mockBulkSetStatus = jest.fn();
const mockGetById = jest.fn();
const mockListByIds = jest.fn();

jest.mock('@/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: {
        create: (...a: unknown[]) => mockCreate(...a),
        update: (...a: unknown[]) => mockUpdate(...a),
        setStatus: (...a: unknown[]) => mockSetStatus(...a),
        bulkSetStatus: (...a: unknown[]) => mockBulkSetStatus(...a),
        getById: (...a: unknown[]) => mockGetById(...a),
        listByIds: (...a: unknown[]) => mockListByIds(...a),
    },
    TaskLinkRepository: {},
    TaskCommentRepository: {},
    TaskWatcherRepository: {},
}));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn({})),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn(async () => undefined) }));
jest.mock('@/app-layer/automation', () => ({ emitAutomationEvent: jest.fn(async () => undefined) }));
jest.mock('@/app-layer/notifications/enqueue', () => ({ enqueueEmail: jest.fn() }));
jest.mock('@/app-layer/notifications/task-due', () => ({ createTaskDueNotification: jest.fn() }));
jest.mock('@/app-layer/notifications/assignment', () => ({ createAssignmentNotification: jest.fn() }));
jest.mock('@/lib/notifications/web-push', () => ({ sendWebPushToUser: jest.fn() }));
jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(),
    bumpEntityCacheVersion: jest.fn(async () => undefined),
}));

jest.mock('@/app-layer/policies/task.policies', () => ({
    assertCanReadTasks: jest.fn(),
    assertCanWriteTasks: jest.fn(),
    assertCanCommentOnTasks: jest.fn(),
}));
jest.mock('@/app-layer/policies/issue.policies', () => ({
    assertCanReadIssues: jest.fn(),
    assertCanCreateIssue: jest.fn(),
    assertCanUpdateIssue: jest.fn(),
    assertCanAssignIssue: jest.fn(),
    assertCanResolveIssue: jest.fn(),
    assertCanComment: jest.fn(),
    assertCanManageLinks: jest.fn(),
    assertCanManageBundles: jest.fn(),
    assertCanFreeze: jest.fn(),
}));

import { createTask, updateTask, setTaskStatus, bulkSetTaskStatus } from '@/app-layer/usecases/task';
import {
    createIssue,
    updateIssue,
    setIssueStatus,
    bulkSetStatus as bulkSetIssueStatus,
} from '@/app-layer/usecases/issue';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

/** The payload every assertion below uses, so one shape describes the threat. */
const HOSTILE = 'before<script>alert(1)</script>after';

/** What a sanitised `HOSTILE` must look like, whichever column it lands in. */
function expectStripped(value: unknown) {
    expect(typeof value).toBe('string');
    const s = value as string;
    expect(s).not.toMatch(/<script/i);
    expect(s).not.toMatch(/alert/);
    // Positive control: stripping everything would also satisfy the two
    // assertions above, and would be a different bug.
    expect(s).toContain('before');
    expect(s).toContain('after');
}

const TASK_ROW = {
    id: 't1',
    key: 'TASK-1',
    title: 'T',
    type: 'TASK',
    status: 'OPEN',
    severity: 'MEDIUM',
    priority: 'P2',
    assigneeUserId: null,
    dueAt: null,
    createdAt: new Date(),
};

beforeEach(() => {
    for (const m of [mockCreate, mockUpdate, mockSetStatus, mockBulkSetStatus, mockGetById, mockListByIds]) {
        m.mockReset();
    }
    mockCreate.mockResolvedValue(TASK_ROW);
    mockUpdate.mockResolvedValue(TASK_ROW);
    mockSetStatus.mockResolvedValue(TASK_ROW);
    mockBulkSetStatus.mockResolvedValue({ count: 1 });
    mockGetById.mockResolvedValue({ ...TASK_ROW, status: 'IN_PROGRESS' });
    mockListByIds.mockResolvedValue([{ id: 't1', status: 'IN_PROGRESS' }, { id: 'i1', status: 'IN_PROGRESS' }]);
});

// ═══════════════════════════════════════════════════════════════════
// Task.description
// ═══════════════════════════════════════════════════════════════════

describe('Task.description is sanitised before the repository write', () => {
    it('createTask strips markup', async () => {
        await createTask(ctx, { title: 'T', description: HOSTILE });
        expect(mockCreate).toHaveBeenCalledTimes(1);
        expectStripped(mockCreate.mock.calls[0][2].description);
    });

    it('updateTask strips markup', async () => {
        await updateTask(ctx, 't1', { description: HOSTILE });
        expect(mockUpdate).toHaveBeenCalledTimes(1);
        expectStripped(mockUpdate.mock.calls[0][3].description);
    });

    it('createIssue strips markup — same Task row, same column', async () => {
        await createIssue(ctx, { title: 'I', type: 'TASK', description: HOSTILE });
        expect(mockCreate).toHaveBeenCalledTimes(1);
        expectStripped(mockCreate.mock.calls[0][2].description);
    });

    it('updateIssue strips markup', async () => {
        await updateIssue(ctx, 'i1', { description: HOSTILE });
        expect(mockUpdate).toHaveBeenCalledTimes(1);
        expectStripped(mockUpdate.mock.calls[0][3].description);
    });

    it('a null description is left null, not coerced to a string', async () => {
        // The column is nullable and the three-state contract matters:
        // `undefined` = leave alone, `null` = clear it.
        await createTask(ctx, { title: 'T', description: null });
        expect(mockCreate.mock.calls[0][2].description).toBeNull();
    });

    it('an absent description stays absent on update (no accidental clear)', async () => {
        await updateTask(ctx, 't1', { title: 'renamed' });
        expect(mockUpdate.mock.calls[0][3]).not.toHaveProperty('description');
    });
});

// ═══════════════════════════════════════════════════════════════════
// Task.resolution
// ═══════════════════════════════════════════════════════════════════

describe('Task.resolution is sanitised before the repository write', () => {
    it('setTaskStatus strips markup on a terminal transition', async () => {
        await setTaskStatus(ctx, 't1', 'RESOLVED', HOSTILE);
        expect(mockSetStatus).toHaveBeenCalledTimes(1);
        expectStripped(mockSetStatus.mock.calls[0][4]);
    });

    it('bulkSetTaskStatus strips markup', async () => {
        await bulkSetTaskStatus(ctx, ['t1'], 'RESOLVED', HOSTILE);
        expect(mockBulkSetStatus).toHaveBeenCalledTimes(1);
        expectStripped(mockBulkSetStatus.mock.calls[0][4]);
    });

    it('setIssueStatus strips markup', async () => {
        await setIssueStatus(ctx, 'i1', 'RESOLVED', HOSTILE);
        expect(mockSetStatus).toHaveBeenCalledTimes(1);
        expectStripped(mockSetStatus.mock.calls[0][4]);
    });

    it('bulkSetIssueStatus strips markup', async () => {
        await bulkSetIssueStatus(ctx, ['i1'], 'RESOLVED', HOSTILE);
        expect(mockBulkSetStatus).toHaveBeenCalledTimes(1);
        expectStripped(mockBulkSetStatus.mock.calls[0][4]);
    });

    it('a markup-ONLY resolution is rejected, not stored as satisfying text', async () => {
        // Ordering matters and this is what pins it. The terminal-status gate
        // requires a non-empty `resolution` because "closed without why" was a
        // recurring audit finding. Sanitising AFTER that gate would let
        // `<script>x</script>` pass as a reason and then render as nothing —
        // a closed task whose stated why is the empty string.
        await expect(
            setTaskStatus(ctx, 't1', 'RESOLVED', '<script>alert(1)</script>'),
        ).rejects.toThrow(/resolution is required/i);
        expect(mockSetStatus).not.toHaveBeenCalled();
    });

    it('the same ordering holds on the bulk path', async () => {
        await expect(
            bulkSetTaskStatus(ctx, ['t1'], 'RESOLVED', '<script>alert(1)</script>'),
        ).rejects.toThrow(/resolution is required/i);
        expect(mockBulkSetStatus).not.toHaveBeenCalled();
    });
});
