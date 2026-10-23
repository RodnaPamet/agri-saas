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
 *      (removed) AUDIT_FINDING / PRACTICE_GAP without practiceId and without a
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

// The push queue. `enqueue` comes from `jobs/queue`, NOT from
// `notifications/enqueue` mocked above — a partial mock of the wrong module
// would leave `enqueue` undefined, and the bulk emit's own try/catch would
// swallow the TypeError, so the test would observe "no push" and pass for the
// wrong reason.
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: jest.fn().mockResolvedValue(undefined),
}));

// The summary helper is mocked so this file can assert WHO gets told WHAT
// about WHICH tasks. Its own behaviour — copy, dedupe key, link, bus frame —
// is pinned in `tests/unit/notifications/bulk-task-summary.test.ts`.
jest.mock('@/app-layer/notifications/bulk-task-summary', () => ({
    createBulkTaskSummaryNotification: jest.fn().mockResolvedValue({ status: 'created' }),
}));

import {
    createTask,
    setTaskStatus,
    assignTask,
    addTaskComment,
    bulkSetTaskStatus,
    bulkAssignTasks,
    bulkSetTaskDueDate,
    deleteTask,
    bulkDeleteTask,
} from '@/app-layer/usecases/task';
import { createBulkTaskSummaryNotification } from '@/app-layer/notifications/bulk-task-summary';
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

// Every tenant transaction now carries `$executeRaw`: setTaskStatus takes a
// transaction-scoped advisory lock before reading, to serialise the concurrent
// outbox drains that were writing two TASK_STATUS_CHANGED rows for one
// operator action. A bare `{}` is a double too SMALL for the code under test.
const TX = { $executeRaw: async () => 1 };
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
const mockSummary = createBulkTaskSummaryNotification as jest.MockedFunction<
    typeof createBulkTaskSummaryNotification
>;

/**
 * The transaction double the BULK emit paths need.
 *
 * Both read back what they wrote — the ids that carry the new assignee, or the
 * assignee of every affected row — because `updateMany` returns a count and
 * can match fewer rows than the caller asked for (#2103). And the summary
 * resolves the recipient's language, so `user.findUnique` is on the path too.
 */
function bulkTx(opts: {
    tasks?: Array<{ id: string; assigneeUserId?: string | null }>;
    uiLanguage?: string | null;
}) {
    return {
        ...TX,
        task: { findMany: jest.fn().mockResolvedValue(opts.tasks ?? []) },
        user: { findUnique: jest.fn().mockResolvedValue({ uiLanguage: opts.uiLanguage ?? 'bg' }) },
    };
}

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
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({ ...TX } as never));

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
                ...TX,
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
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({ ...TX } as never));
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
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({ ...TX } as never));
        mockGetById.mockResolvedValueOnce(null as never);

        await expect(
            setTaskStatus(makeRequestContext('EDITOR'), 'missing', 'CLOSED'),
        ).rejects.toThrow(/Task not found/);
    });

    // 'blocks RESOLVED for AUDIT_FINDING without practiceId AND without
    // PRACTICE/FRAMEWORK link' lived here. It drove `validateTypeRelevance`,
    // which the GRC teardown deleted (operator decision A6): AUDIT_FINDING /
    // PRACTICE_GAP / INCIDENT are no longer creatable task types, and
    // Practice / FrameworkRequirement are KILL models, so the gate returned
    // on its first line for every surviving type. There is no traceability
    // link left to enforce.

    it('allows RESOLVED for INCIDENT when an ASSET link is present', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({ ...TX } as never));
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
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({ ...TX } as never));
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
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({ ...TX } as never));
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
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({ ...TX } as never));
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
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({ ...TX } as never));

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
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({ ...TX } as never));
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

// ── #2103: the two bulk mutators used to notify nobody ──
//
// Five usecases here can change `assigneeUserId` or `dueAt`. Three notified
// and these two did not, so being assigned twenty tasks at once was silent
// while being assigned one was not. The ruling was ONE summary per bulk
// action; what this block pins is who receives it and what it is about.

describe('bulkAssignTasks — the summary', () => {
    const mockBulkAssign = WorkItemRepository.bulkAssign as jest.MockedFunction<
        typeof WorkItemRepository.bulkAssign
    >;

    it('tells the new assignee, counting the rows ACTUALLY written', async () => {
        // Three ids requested, two written — an id that does not exist or
        // belongs to another tenant drops out of the `updateMany` filter
        // silently. A summary saying "3" would misreport the thing it exists
        // to report.
        const tx = bulkTx({ tasks: [{ id: 't1' }, { id: 't2' }] });
        // `mockImplementation`, NOT `mockImplementationOnce`: the emit opens a
        // SECOND transaction frame of its own. Stubbing only the first leaves
        // the summary's frame returning undefined, which throws inside the
        // emit's own swallowing try/catch — so the test observes "no summary"
        // and passes whatever the code does. That is how the self-assignment
        // case below first passed with its refusal deleted.
        mockRunInTx.mockImplementation(async (_ctx, fn) => fn(tx as never));
        mockBulkAssign.mockResolvedValueOnce({ count: 2 } as never);

        await bulkAssignTasks(makeRequestContext('EDITOR', { userId: 'actor' }), ['t1', 't2', 't3'], 'u-9');

        expect(mockSummary).toHaveBeenCalledTimes(1);
        const [, kind, target] = mockSummary.mock.calls[0];
        expect(kind).toBe('assigned');
        expect(target.recipientUserId).toBe('u-9');
        expect(target.taskIds).toEqual(['t1', 't2']);
    });

    it('says nothing on an UNASSIGN — there is no recipient', async () => {
        const tx = bulkTx({});
        mockRunInTx.mockImplementation(async (_ctx, fn) => fn(tx as never));
        mockBulkAssign.mockResolvedValueOnce({ count: 2 } as never);

        await bulkAssignTasks(makeRequestContext('EDITOR', { userId: 'actor' }), ['t1', 't2'], null);

        expect(mockSummary).not.toHaveBeenCalled();
    });

    it('says nothing when you assign to YOURSELF', async () => {
        // #1755's reasoning, and the bell is the sharper case: it appears on
        // the screen the person is already looking at, one action after they
        // caused it.
        const tx = bulkTx({ tasks: [{ id: 't1' }] });
        mockRunInTx.mockImplementation(async (_ctx, fn) => fn(tx as never));
        mockBulkAssign.mockResolvedValueOnce({ count: 1 } as never);

        await bulkAssignTasks(makeRequestContext('EDITOR', { userId: 'actor' }), ['t1'], 'actor');

        expect(mockSummary).not.toHaveBeenCalled();
    });

    it('CONTROL: the harness CAN see a summary for the same shape of call', async () => {
        // The two refusals above assert an absence, and an absence is what a
        // mis-stubbed harness produces for free — the self-assignment case
        // passed with its refusal deleted because the summary's own
        // transaction frame was unstubbed and the emit swallowed the error.
        // This is the same call with a different assignee, so "not called"
        // above can only mean the refusal fired.
        const tx = bulkTx({ tasks: [{ id: 't1' }] });
        mockRunInTx.mockImplementation(async (_ctx, fn) => fn(tx as never));
        mockBulkAssign.mockResolvedValueOnce({ count: 1 } as never);

        await bulkAssignTasks(makeRequestContext('EDITOR', { userId: 'actor' }), ['t1'], 'someone-else');

        expect(mockSummary).toHaveBeenCalledTimes(1);
    });
});

describe('bulkSetTaskDueDate — the summary', () => {
    const mockBulkDue = WorkItemRepository.bulkSetDueDate as jest.MockedFunction<
        typeof WorkItemRepository.bulkSetDueDate
    >;

    it('tells each affected assignee about their OWN tasks only', async () => {
        // A reschedule has no single recipient: twenty tasks can belong to
        // five people. Telling everyone about all twenty would leak who else
        // is working on what, and would also be wrong.
        const tx = bulkTx({
            tasks: [
                { id: 't1', assigneeUserId: 'u-1' },
                { id: 't2', assigneeUserId: 'u-2' },
                { id: 't3', assigneeUserId: 'u-1' },
            ],
        });
        mockRunInTx.mockImplementation(async (_ctx, fn) => fn(tx as never));
        mockBulkDue.mockResolvedValueOnce({ count: 3 } as never);

        await bulkSetTaskDueDate(
            makeRequestContext('EDITOR', { userId: 'actor' }),
            ['t1', 't2', 't3'],
            '2026-11-01',
        );

        expect(mockSummary).toHaveBeenCalledTimes(2);
        const byRecipient = new Map(
            mockSummary.mock.calls.map(([, , t]) => [t.recipientUserId, t.taskIds]),
        );
        expect(byRecipient.get('u-1')).toEqual(['t1', 't3']);
        expect(byRecipient.get('u-2')).toEqual(['t2']);
        for (const [, kind] of mockSummary.mock.calls) expect(kind).toBe('rescheduled');
    });

    it('skips unassigned tasks and the actor’s own', async () => {
        const tx = bulkTx({
            tasks: [
                { id: 't1', assigneeUserId: null },
                { id: 't2', assigneeUserId: 'actor' },
                { id: 't3', assigneeUserId: 'u-7' },
            ],
        });
        mockRunInTx.mockImplementation(async (_ctx, fn) => fn(tx as never));
        mockBulkDue.mockResolvedValueOnce({ count: 3 } as never);

        await bulkSetTaskDueDate(
            makeRequestContext('EDITOR', { userId: 'actor' }),
            ['t1', 't2', 't3'],
            null,
        );

        expect(mockSummary).toHaveBeenCalledTimes(1);
        expect(mockSummary.mock.calls[0][2].recipientUserId).toBe('u-7');
    });

    it('tells nobody when every affected task is unassigned — the control', async () => {
        // Without this, the grouping above would pass on an implementation
        // that notified a hardcoded recipient.
        const tx = bulkTx({ tasks: [{ id: 't1', assigneeUserId: null }] });
        mockRunInTx.mockImplementation(async (_ctx, fn) => fn(tx as never));
        mockBulkDue.mockResolvedValueOnce({ count: 1 } as never);

        await bulkSetTaskDueDate(makeRequestContext('EDITOR', { userId: 'actor' }), ['t1'], null);

        expect(mockSummary).not.toHaveBeenCalled();
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
            fn({ ...TX, task: { delete: del } } as never),
        );
        // `createdByUserId` added by #2187: the delete is creator-or-admin now,
        // and this fixture predates the rule. An EDITOR is write-but-not-admin,
        // so without it the row belongs to nobody and the gate refuses — which
        // is the gate working, not a regression.
        mockGetById.mockResolvedValueOnce({
            id: 't1', title: 'My task', type: 'TASK', status: 'OPEN', practiceId: null,
            createdByUserId: 'user-1',
            // #2220: stated, not omitted. `assertTaskIsNotTreatmentShare`
            // permits ONLY an explicit null — `undefined` refuses, which is
            // the fail-safe direction for a delete that cascades register
            // lines. A fixture silent on this has not considered it.
            treatmentGroupId: null,
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
            fn({ ...TX, task: { delete: del } } as never),
        );
        mockGetById.mockResolvedValueOnce(null as never);

        await expect(
            deleteTask(makeRequestContext('EDITOR'), 'missing'),
        ).rejects.toThrow();
        expect(del).not.toHaveBeenCalled();
    });
});

describe('deleteTask — creator-or-admin (#2187)', () => {
    /**
     * The asymmetry this closes: #2169 gated EDIT on creator-or-admin and left
     * DELETE on any-writer, so the rule read "you may not change my task, but
     * you may delete it" — the weaker permission guarding the more destructive
     * verb. And the delete is HARD: the sibling test above is named "deletes
     * the row (children cascade)".
     *
     * EDITOR is the persona that makes these cases mean anything — `canWrite`
     * true, `canAdmin` false — because every OWNER/ADMIN case passes through
     * the admin arm and says nothing about the creator arm.
     */
    const txWith = (del: jest.Mock) =>
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ ...TX, task: { delete: del } } as never),
        );

    it('the CREATOR may delete without being an admin', async () => {
        const del = jest.fn().mockResolvedValue({});
        txWith(del);
        mockGetById.mockResolvedValueOnce({
            id: 't1', title: 'Mine', type: 'TASK', status: 'OPEN', practiceId: null,
            createdByUserId: 'user-1',
            // #2220: stated, not omitted. `assertTaskIsNotTreatmentShare`
            // permits ONLY an explicit null — `undefined` refuses, which is
            // the fail-safe direction for a delete that cascades register
            // lines. A fixture silent on this has not considered it.
            treatmentGroupId: null,
        } as never);

        await deleteTask(makeRequestContext('EDITOR'), 't1');
        expect(del).toHaveBeenCalledWith({ where: { id: 't1' } });
    });

    it('a WRITER who did not create it is REFUSED, and nothing is deleted', async () => {
        const del = jest.fn();
        txWith(del);
        mockGetById.mockResolvedValueOnce({
            id: 't1', title: 'Theirs', type: 'TASK', status: 'OPEN', practiceId: null,
            createdByUserId: 'somebody-else',
        } as never);

        await expect(
            deleteTask(makeRequestContext('EDITOR'), 't1'),
        ).rejects.toMatchObject({ code: 'TASK_DELETE_NOT_PERMITTED' });
        // The assertion that matters: the refusal lands BEFORE the write.
        expect(del).not.toHaveBeenCalled();
    });

    it('an ADMIN may delete a task somebody else created', async () => {
        // The release valve. Without it a farm whose only admin is away cannot
        // clear anybody's mistake, which is the cost the owner accepted.
        const del = jest.fn().mockResolvedValue({});
        txWith(del);
        mockGetById.mockResolvedValueOnce({
            id: 't1', title: 'Theirs', type: 'TASK', status: 'OPEN', practiceId: null,
            createdByUserId: 'somebody-else',
            treatmentGroupId: null,
        } as never);

        await deleteTask(makeRequestContext('ADMIN'), 't1');
        expect(del).toHaveBeenCalled();
    });

    it('refuses a code DISTINCT from the role refusal', async () => {
        // A READER is stopped one gate earlier, by `assertCanWriteTasks`. What
        // matters here is that the two refusals are DISTINGUISHABLE: telling a
        // farmer "you lack permission" when the truth is "this is not yours"
        // points them at the wrong remedy.
        //
        // Note the role refusal is an UNCODED `forbidden()` — plain
        // `FORBIDDEN` — unlike the treatment path's `WRITE_FORBIDDEN_FOR_ROLE`.
        // I expected the coded one here and was wrong. So the pair is
        // distinguishable, but only because the NEW code is specific; the old
        // one still says nothing a client can switch on. Out of scope to
        // change, and asserted as it IS rather than as it should be.
        await expect(
            deleteTask(makeRequestContext('READER'), 't1'),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
});

describe('bulkDeleteTask — all-or-nothing (#2187)', () => {
    /**
     * The first tests this usecase has had. It was written with no authorship
     * check at all, and nothing covered it — which is how the asymmetry
     * survived #2169.
     */
    const txWith = (findMany: jest.Mock, deleteMany: jest.Mock) =>
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ ...TX, task: { findMany, deleteMany } } as never),
        );

    const row = (id: string, by: string) => ({
        id, title: id, type: 'TASK', createdByUserId: by,
        // #2220 — the bulk refusal reads this; see the note above.
        treatmentGroupId: null,
    });

    it('deletes every row when they are all the caller\'s own', async () => {
        const deleteMany = jest.fn().mockResolvedValue({ count: 2 });
        txWith(jest.fn().mockResolvedValue([row('a', 'user-1'), row('b', 'user-1')]), deleteMany);

        const result = await bulkDeleteTask(makeRequestContext('EDITOR'), ['a', 'b']);
        expect(result).toEqual({ deleted: 2 });
        expect(deleteMany).toHaveBeenCalled();
    });

    it('refuses the WHOLE call when ONE row belongs to somebody else', async () => {
        // The owner's ruling, and the case worth the strongest assertion: the
        // two the caller owns must NOT go. A partial success would leave them
        // reconciling an outcome against their own selection.
        const deleteMany = jest.fn();
        txWith(
            jest.fn().mockResolvedValue([
                row('a', 'user-1'),
                row('b', 'somebody-else'),
                row('c', 'user-1'),
            ]),
            deleteMany,
        );

        await expect(
            bulkDeleteTask(makeRequestContext('EDITOR'), ['a', 'b', 'c']),
        ).rejects.toMatchObject({
            code: 'TASK_DELETE_NOT_PERMITTED',
            params: { refused: 1, selected: 3 },
        });
        expect(deleteMany).not.toHaveBeenCalled();
    });

    it('reports the counts a client needs to phrase the refusal', async () => {
        const deleteMany = jest.fn();
        txWith(
            jest.fn().mockResolvedValue([
                row('a', 'other-1'),
                row('b', 'other-2'),
                row('c', 'user-1'),
            ]),
            deleteMany,
        );

        await expect(
            bulkDeleteTask(makeRequestContext('EDITOR'), ['a', 'b', 'c']),
        ).rejects.toMatchObject({ params: { refused: 2, selected: 3 } });
    });

    it('an ADMIN deletes the selection whatever its authorship', async () => {
        const deleteMany = jest.fn().mockResolvedValue({ count: 2 });
        txWith(jest.fn().mockResolvedValue([row('a', 'other'), row('b', 'other')]), deleteMany);

        const result = await bulkDeleteTask(makeRequestContext('ADMIN'), ['a', 'b']);
        expect(result).toEqual({ deleted: 2 });
    });

    it('an empty selection is 0 deleted, not a refusal', async () => {
        // The rows that EXIST are what the check runs on, and an id this
        // tenant does not own was filtered out by the query rather than being
        // something to refuse over.
        const deleteMany = jest.fn();
        txWith(jest.fn().mockResolvedValue([]), deleteMany);

        const result = await bulkDeleteTask(makeRequestContext('EDITOR'), ['nope']);
        expect(result).toEqual({ deleted: 0 });
        expect(deleteMany).not.toHaveBeenCalled();
    });
});

/**
 * A treatment's task is not deletable through the TASK route (#2220).
 *
 * The defect: four child models cascade on this delete and `OperationParcel`
 * is one of them — those rows ARE the lines the БАБХ ДНЕВНИК prints. So this
 * route destroyed register lines from a filed regulatory document while
 * `deleteDiaryTreatment`, for the same intent, flags them reversibly.
 *
 * Authorisation was never the gap: both paths are creator-or-admin, so nobody
 * reached it who could not already withdraw the treatment. The OUTCOME
 * differed, and nothing said which one you were getting.
 */
describe('deleteTask — a treatment share is refused (#2220)', () => {
    const txWith = (del: jest.Mock) =>
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ ...TX, task: { delete: del } } as never),
        );

    const row = (over: Record<string, unknown> = {}) => ({
        id: 't1', title: 'Spraying — block A', type: 'FIELD_OPERATION',
        status: 'RESOLVED', practiceId: null, createdByUserId: 'user-1',
        treatmentGroupId: null, ...over,
    });

    it('REFUSES a task carrying a treatmentGroupId, and deletes nothing', async () => {
        const del = jest.fn();
        txWith(del);
        mockGetById.mockResolvedValueOnce(row({ treatmentGroupId: 'grp-1' }) as never);

        await expect(
            deleteTask(makeRequestContext('OWNER'), 't1'),
        ).rejects.toMatchObject({ code: 'TASK_BELONGS_TO_TREATMENT', status: 409 });
        expect(del).not.toHaveBeenCalled();
    });

    it('names the field a client needs to build the withdrawal call', async () => {
        // Without `reference` the client knows it may not delete here and has
        // nothing to call instead. The handle IS the path parameter of
        // `DELETE /journal/treatments/{treatmentGroupId}`.
        txWith(jest.fn());
        mockGetById.mockResolvedValueOnce(row({ treatmentGroupId: 'grp-1' }) as never);

        await expect(
            deleteTask(makeRequestContext('OWNER'), 't1'),
        ).rejects.toMatchObject({ params: { reference: 'treatmentGroupId' } });
    });

    it('still deletes a FIELD_OPERATION that is NOT part of a treatment', async () => {
        // The positive control, and the reason the check reads
        // `treatmentGroupId` rather than `type`: an operation planned through
        // POST /locations/{id}/operations leaves the column null, and the
        // withdrawal route keys on a group it does not have — so refusing by
        // type would stran it with no alternative.
        const del = jest.fn().mockResolvedValue({});
        txWith(del);
        mockGetById.mockResolvedValueOnce(row() as never);

        await deleteTask(makeRequestContext('OWNER'), 't1');
        expect(del).toHaveBeenCalledWith({ where: { id: 't1' } });
    });

    it('the PERMISSION refusal wins when both apply', async () => {
        // Ordering, asserted because it is a choice: a non-creator deleting a
        // treatment share breaks two rules. They get the permission answer,
        // which is the one true of them regardless of the row — telling them
        // "use the withdrawal route" when they may not withdraw it either
        // would send them somewhere that also refuses.
        const del = jest.fn();
        txWith(del);
        mockGetById.mockResolvedValueOnce(
            row({ createdByUserId: 'somebody-else', treatmentGroupId: 'grp-1' }) as never,
        );

        await expect(
            deleteTask(makeRequestContext('EDITOR'), 't1'),
        ).rejects.toMatchObject({ code: 'TASK_DELETE_NOT_PERMITTED' });
        expect(del).not.toHaveBeenCalled();
    });

    it('an ABSENT treatmentGroupId refuses — fail-safe, and deliberate', async () => {
        // `=== null` permits, so `undefined` refuses. Pinned because the
        // obvious "simplification" is `if (!task.treatmentGroupId) return`,
        // which would permit a caller that had selected the column away.
        //
        // The asymmetry is the point: refusing wrongly blocks a delete, which
        // is annoying and recoverable. Permitting wrongly destroys register
        // lines from a filed document, which is not. Prisma always returns the
        // column, so this costs nothing in production.
        const del = jest.fn();
        txWith(del);
        const { treatmentGroupId: _omitted, ...withoutTheField } = row();
        mockGetById.mockResolvedValueOnce(withoutTheField as never);

        await expect(
            deleteTask(makeRequestContext('OWNER'), 't1'),
        ).rejects.toMatchObject({ code: 'TASK_BELONGS_TO_TREATMENT' });
        expect(del).not.toHaveBeenCalled();
    });
});

describe('bulkDeleteTask — treatment shares refuse the WHOLE call (#2220)', () => {
    const txWith = (findMany: jest.Mock, deleteMany: jest.Mock) =>
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ ...TX, task: { findMany, deleteMany } } as never),
        );

    const row = (id: string, grp: string | null) => ({
        id, title: id, type: 'FIELD_OPERATION', createdByUserId: 'user-1',
        treatmentGroupId: grp,
    });

    it('refuses the whole selection when ANY row is a share', async () => {
        const deleteMany = jest.fn();
        txWith(jest.fn().mockResolvedValue([row('a', null), row('b', 'grp-1')]), deleteMany);

        await expect(
            bulkDeleteTask(makeRequestContext('OWNER'), ['a', 'b']),
        ).rejects.toMatchObject({
            code: 'TASK_BELONGS_TO_TREATMENT',
            params: { refused: 1, selected: 2 },
        });
        // All-or-nothing, same as #2187: the refusal lands BEFORE the write, so
        // "none were deleted" is true rather than hopeful.
        expect(deleteMany).not.toHaveBeenCalled();
    });

    it('deletes the selection when none of them are shares', async () => {
        const deleteMany = jest.fn().mockResolvedValue({ count: 2 });
        txWith(jest.fn().mockResolvedValue([row('a', null), row('b', null)]), deleteMany);

        const out = await bulkDeleteTask(makeRequestContext('OWNER'), ['a', 'b']);
        expect(out).toEqual({ deleted: 2 });
        expect(deleteMany).toHaveBeenCalled();
    });
});
