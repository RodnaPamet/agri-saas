/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/task.ts
 *
 * Wave 4 of GAP-02. Tasks/work-items are the primary day-to-day
 * mutation surface for compliance teams. The load-bearing behaviours:
 *
 *   1. assertCanWriteTasks gate on every mutation; assertCanCommentOnTasks
 *      gate on comment add.
 *   2. addTaskComment sanitises body via sanitizePlainText BEFORE
 *      repository write (Epic C.5 — comments are plaintext today but
 *      a future renderer change must not re-enable stored XSS).
 *   3. setTaskStatus pre-fetches existing row to capture fromStatus
 *      for emitAutomationEvent — without this the automation payload
 *      can't drive transition-aware rules (e.g. "OPEN → IN_PROGRESS").
 *   4. validateTypeRelevance fires on RESOLVED/CLOSED transitions:
 *      AUDIT_FINDING / PRACTICE_GAP without practiceId AND without a
 *      PRACTICE / FRAMEWORK_REQUIREMENT link must be blocked.
 *   5. createTask + assignTask enqueue an assignment notification
 *      (best-effort try/catch — never breaks the task op).
 *   6. Audit emit on every state change.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: {
        list: jest.fn(),
        listPaginated: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        setStatus: jest.fn(),
        assign: jest.fn(),
        bulkAssign: jest.fn(),
        bulkSetStatus: jest.fn(),
        bulkSetDueDate: jest.fn(),
        // S8 — pre-fetch in bulkSetStatus path.
        listByIds: jest.fn(),
        metrics: jest.fn(),
    },
    TaskLinkRepository: {
        listByTask: jest.fn().mockResolvedValue([]),
        link: jest.fn(),
        unlink: jest.fn(),
    },
    TaskCommentRepository: {
        listByTask: jest.fn(),
        add: jest.fn(),
    },
    TaskWatcherRepository: {
        listByTask: jest.fn(),
        add: jest.fn(),
        remove: jest.fn(),
    },
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string | null | undefined) => `SANITISED(${s})`),
}));

jest.mock('@/app-layer/schemas/json-columns.schemas', () => ({
    validateTaskMetadata: jest.fn((m: unknown) => m),
}));

jest.mock('@/app-layer/automation', () => ({
    emitAutomationEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    createTask,
    setTaskStatus,
    assignTask,
    addTaskComment,
    bulkSetTaskStatus,
    deleteTask,
} from '@/app-layer/usecases/task';
import { runInTenantContext } from '@/lib/db-context';
import {
    WorkItemRepository,
    TaskLinkRepository,
    TaskCommentRepository,
} from '@/app-layer/repositories/WorkItemRepository';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { emitAutomationEvent } from '@/app-layer/automation';
import { enqueueEmail } from '@/app-layer/notifications/enqueue';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockGetById = WorkItemRepository.getById as jest.MockedFunction<typeof WorkItemRepository.getById>;
const mockCreate = WorkItemRepository.create as jest.MockedFunction<typeof WorkItemRepository.create>;
const mockSetStatus = WorkItemRepository.setStatus as jest.MockedFunction<typeof WorkItemRepository.setStatus>;
const mockAssign = WorkItemRepository.assign as jest.MockedFunction<typeof WorkItemRepository.assign>;
const mockBulkSetStatus = WorkItemRepository.bulkSetStatus as jest.MockedFunction<typeof WorkItemRepository.bulkSetStatus>;
const mockListByIds = WorkItemRepository.listByIds as jest.MockedFunction<typeof WorkItemRepository.listByIds>;
const mockLinkList = TaskLinkRepository.listByTask as jest.MockedFunction<typeof TaskLinkRepository.listByTask>;
const mockCommentAdd = TaskCommentRepository.add as jest.MockedFunction<typeof TaskCommentRepository.add>;
const mockSanitize = sanitizePlainText as jest.MockedFunction<typeof sanitizePlainText>;
const mockEmitEvent = emitAutomationEvent as jest.MockedFunction<typeof emitAutomationEvent>;
const mockEnqueueEmail = enqueueEmail as jest.MockedFunction<typeof enqueueEmail>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
    mockSanitize.mockImplementation((s: string | null | undefined) => `SANITISED(${s})`);
    mockCreate.mockResolvedValue({
        id: 't1', key: 'TASK-1', title: 'New', type: 'TASK',
        severity: null, priority: null, status: 'OPEN',
        assigneeUserId: null, practiceId: null,
    } as never);
    mockSetStatus.mockResolvedValue({ id: 't1', status: 'RESOLVED' } as never);
    mockAssign.mockResolvedValue({ id: 't1', title: 'X', key: 'T1', type: 'TASK' } as never);
    mockCommentAdd.mockResolvedValue({ id: 'comment-1' } as never);
    mockGetById.mockResolvedValue({ id: 't1', status: 'OPEN', type: 'TASK', practiceId: null } as never);
});

describe('createTask', () => {
    it('rejects READER (no canWrite)', async () => {
        await expect(
            createTask(makeRequestContext('READER'), { title: 'x' }),
        ).rejects.toThrow();
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('emits TASK_CREATED audit AND fires emitAutomationEvent', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));

        await createTask(makeRequestContext('EDITOR'), { title: 'x' });

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'TASK_CREATED' }),
        );
        // Regression: the automation backbone (Epic 60) routes off this
        // event. A miss here breaks every rule that reacts to new
        // tasks (notifications, escalations, SLA timers).
        expect(mockEmitEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ event: 'TASK_CREATED' }),
        );
    });

    it('enqueues TASK_ASSIGNED email when an assignee is set on create', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                user: {
                    findUnique: jest.fn()
                        .mockResolvedValueOnce({ email: 'a@b.com', name: 'A' }) // assignee
                        .mockResolvedValueOnce({ name: 'CreatorName' }), // assigner
                },
            } as never),
        );

        await createTask(makeRequestContext('EDITOR'), {
            title: 'x', assigneeUserId: 'user-2',
        });

        expect(mockEnqueueEmail).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                type: 'TASK_ASSIGNED',
                toEmail: 'a@b.com',
            }),
        );
    });
});

describe('setTaskStatus — fromStatus capture + validateTypeRelevance', () => {
    it('passes fromStatus from the pre-fetch into the automation event payload', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValueOnce({
            id: 't1', status: 'OPEN', type: 'TASK', practiceId: null,
        } as never);

        await setTaskStatus(makeRequestContext('EDITOR'), 't1', 'IN_PROGRESS');

        const eventCall = mockEmitEvent.mock.calls.find(
            c => (c[1] as any).event === 'TASK_STATUS_CHANGED',
        );
        const payload = (eventCall as any[])[1];
        // Regression: a refactor that read fromStatus AFTER setStatus
        // would always see the new value — the transition becomes
        // "X → X" and rules that fire on specific transitions misfire.
        expect(payload.data.fromStatus).toBe('OPEN');
        expect(payload.data.toStatus).toBe('IN_PROGRESS');
        expect(payload.stableKey).toBe('t1:OPEN:IN_PROGRESS');
    });

    it('throws notFound when the task does not exist', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValueOnce(null as never);

        await expect(
            setTaskStatus(makeRequestContext('EDITOR'), 'missing', 'CLOSED'),
        ).rejects.toThrow(/Task not found/);
    });

    it('blocks RESOLVED for AUDIT_FINDING without practiceId AND without PRACTICE/FRAMEWORK link', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValueOnce({
            id: 't1', status: 'OPEN', type: 'AUDIT_FINDING', practiceId: null,
        } as never);
        mockLinkList.mockResolvedValueOnce([
            { entityType: 'POLICY' }, // wrong type — not PRACTICE / FRAMEWORK_REQUIREMENT
        ] as never);

        await expect(
            // S8 — resolution required on terminal transitions.
            // Supply one so the type-relevance gate is the rejection
            // path under test, not the resolution-required gate.
            setTaskStatus(makeRequestContext('EDITOR'), 't1', 'RESOLVED', 'fix shipped'),
        ).rejects.toThrow(/AUDIT_FINDING tasks must have a practiceId/);
        // Regression: a refactor that skipped validateTypeRelevance
        // would let an audit finding be marked "resolved" without
        // pointing at WHICH practice was remediated — the audit-pack
        // export downstream loses the traceability link.
    });

    it('allows RESOLVED for INCIDENT when an ASSET link is present', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValueOnce({
            id: 't1', status: 'OPEN', type: 'INCIDENT', practiceId: null,
        } as never);
        mockLinkList.mockResolvedValueOnce([
            { entityType: 'ASSET' },
        ] as never);

        await expect(
            setTaskStatus(makeRequestContext('EDITOR'), 't1', 'RESOLVED', 'fix shipped'),
        ).resolves.toBeDefined();
    });
});

describe('setTaskStatus — assignee self-serve (operator completion)', () => {
    it('lets the ASSIGNEE change status without general write (MECHANISATOR)', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        // ctx.userId defaults to 'user-1'; the task is assigned to them.
        mockGetById.mockResolvedValueOnce({
            id: 't1', status: 'OPEN', type: 'FARM_TASK', practiceId: null,
            assigneeUserId: 'user-1',
        } as never);

        await setTaskStatus(makeRequestContext('MECHANISATOR'), 't1', 'IN_PROGRESS');

        // The assignee bypass let the write through despite canWrite=false.
        expect(mockSetStatus).toHaveBeenCalled();
    });

    it('blocks a MECHANISATOR who is NOT the assignee', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockGetById.mockResolvedValueOnce({
            id: 't1', status: 'OPEN', type: 'FARM_TASK', practiceId: null,
            assigneeUserId: 'someone-else',
        } as never);

        await expect(
            setTaskStatus(makeRequestContext('MECHANISATOR'), 't1', 'IN_PROGRESS'),
        ).rejects.toThrow();
        expect(mockSetStatus).not.toHaveBeenCalled();
    });
});

describe('assignTask', () => {
    it('rejects READER on assign (canWrite gate)', async () => {
        await expect(
            assignTask(makeRequestContext('READER'), 't1', 'user-2'),
        ).rejects.toThrow();
    });

    it('throws notFound when repo returns null (cross-tenant id)', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockAssign.mockResolvedValueOnce(null as never);

        await expect(
            assignTask(makeRequestContext('EDITOR'), 'missing', 'u2'),
        ).rejects.toThrow(/Task not found/);
    });
});

describe('addTaskComment — Epic C.5 sanitisation', () => {
    it('rejects READER (canCommentOnTasks gate)', async () => {
        await expect(
            addTaskComment(makeRequestContext('READER'), 't1', 'hi'),
        ).rejects.toThrow();
    });

    it('sanitises body BEFORE the repository write', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));

        await addTaskComment(
            makeRequestContext('EDITOR'),
            't1',
            '<script>alert(1)</script>hello',
        );

        // sanitizePlainText was called once with the raw input
        expect(mockSanitize).toHaveBeenCalledWith('<script>alert(1)</script>hello');
        // and the SANITISED value (not the raw) was passed to the repo.
        const addCall = mockCommentAdd.mock.calls[0];
        // signature: (db, ctx, taskId, body)
        expect(addCall[3]).toBe('SANITISED(<script>alert(1)</script>hello)');
        // Regression: a refactor that sanitised at render time only
        // (bypassing the persistence boundary) would leave the
        // original HTML in the DB — readable by SDK consumers, PDF
        // generators, audit-pack share links.
    });
});

describe('bulkSetTaskStatus', () => {
    it('emits one TASK_STATUS_CHANGED audit per id (not one summary row)', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        // S8 — bulk path pre-fetches every row's current status so
        // the all-or-nothing transition gate can run before the
        // bulk update. Each id resolves to a legal RESOLVED→CLOSED.
        mockListByIds.mockResolvedValueOnce([
            { id: 't1', status: 'RESOLVED' },
            { id: 't2', status: 'RESOLVED' },
            { id: 't3', status: 'RESOLVED' },
        ] as never);
        mockBulkSetStatus.mockResolvedValueOnce({ count: 3 } as never);

        await bulkSetTaskStatus(
            makeRequestContext('EDITOR'),
            ['t1', 't2', 't3'],
            'CLOSED',
            // S8 — terminal transitions require a resolution.
            'archived after Q1 review',
        );

        const calls = mockLog.mock.calls.filter(
            c => (c[2] as any).action === 'TASK_STATUS_CHANGED',
        );
        // Regression: a refactor that emitted one summary row would
        // break per-task audit-trail completeness (an external auditor
        // searching by entityId would miss the bulk event entirely).
        expect(calls).toHaveLength(3);
    });
});

describe('deleteTask', () => {
    it('rejects READER (no canWrite)', async () => {
        await expect(
            deleteTask(makeRequestContext('READER'), 't1'),
        ).rejects.toThrow();
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('deletes the row (children cascade) and emits TASK_DELETED audit', async () => {
        const del = jest.fn().mockResolvedValue({});
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ task: { delete: del } } as never),
        );
        mockGetById.mockResolvedValueOnce({
            id: 't1', title: 'My task', type: 'TASK', status: 'OPEN', practiceId: null,
        } as never);

        await deleteTask(makeRequestContext('EDITOR'), 't1');

        expect(del).toHaveBeenCalledWith({ where: { id: 't1' } });
        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'TASK_DELETED' }),
        );
    });

    it('throws notFound and never deletes when the task is missing', async () => {
        const del = jest.fn();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ task: { delete: del } } as never),
        );
        mockGetById.mockResolvedValueOnce(null as never);

        await expect(
            deleteTask(makeRequestContext('EDITOR'), 'missing'),
        ).rejects.toThrow();
        expect(del).not.toHaveBeenCalled();
    });
});
