/**
 * Unit Test: Task + Issue usecases publish automation events.
 *
 * `task.ts` / `issue.ts` are high-value automation sources (incident
 * detection, SLA escalation, cross-entity auto-close). This test
 * proves the emit sites added alongside their existing audit-log
 * writes fire with the right event + payload, without booting the
 * rest of the app or a real DB.
 */

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

// Stub the tenant transaction context so the usecase's
// `runInTenantContext` wrapper just passes its callback through
// with a fake db that returns our mocked repo results.
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx, callback) => {
            // Callback gets a `db` arg — repos are fully mocked below, so
            // anything truthy satisfies the signature.
            return callback({} as unknown);
        }),
    };
});

jest.mock('@/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: {
        create: jest.fn(),
        update: jest.fn(),
        getById: jest.fn(),
        setStatus: jest.fn(),
    },
    TaskLinkRepository: { listByTask: jest.fn().mockResolvedValue([]) },
    TaskCommentRepository: {},
    TaskWatcherRepository: {},
}));

jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: jest.fn().mockResolvedValue(undefined),
}));

import { createTask, setTaskStatus } from '@/app-layer/usecases/task';
import { createIssue, setIssueStatus } from '@/app-layer/usecases/issue';
import { WorkItemRepository } from '@/app-layer/repositories/WorkItemRepository';
import {
    getAutomationBus,
    resetAutomationBus,
    type AutomationDomainEvent,
} from '@/app-layer/automation';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

function makeCtx(): RequestContext {
    return {
        requestId: 'req-task',
        userId: 'user-1',
        tenantId: 'tenant-A',
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

describe('Task + Issue usecase emission', () => {
    beforeEach(() => {
        resetAutomationBus();
        jest.clearAllMocks();
    });

    test('createTask publishes TASK_CREATED with key + severity + priority', async () => {
        (WorkItemRepository.create as jest.Mock).mockResolvedValue({
            id: 'task-1',
            key: 'TSK-42',
            title: 'Replace the sprayer nozzles',
            type: 'TASK',
            severity: 'CRITICAL',
            priority: 'P0',
            status: 'OPEN',
            assigneeUserId: 'user-2',
            practiceId: null,
        });

        const captured: AutomationDomainEvent[] = [];
        getAutomationBus().subscribe('TASK_CREATED', (e) => {
            captured.push(e);
        });

        await createTask(makeCtx(), {
            title: 'Replace the sprayer nozzles',
            type: 'TASK',
            severity: 'CRITICAL',
            priority: 'P0',
            assigneeUserId: 'user-2',
        });

        expect(captured).toHaveLength(1);
        const evt = captured[0];
        expect(evt.event).toBe('TASK_CREATED');
        expect(evt.tenantId).toBe('tenant-A');
        expect(evt.entityId).toBe('task-1');
        expect(evt.stableKey).toBe('task-1');
        if (evt.event === 'TASK_CREATED') {
            expect(evt.data).toEqual({
                key: 'TSK-42',
                title: 'Replace the sprayer nozzles',
                type: 'TASK',
                severity: 'CRITICAL',
                priority: 'P0',
                assigneeUserId: 'user-2',
            });
        }
    });

    test('setTaskStatus publishes TASK_STATUS_CHANGED with fromStatus→toStatus', async () => {
        // S8 — IN_PROGRESS → CLOSED is now illegal under the work-
        // item state machine; CLOSED must be reached via RESOLVED.
        (WorkItemRepository.getById as jest.Mock).mockResolvedValue({
            id: 'task-1',
            status: 'RESOLVED',
            type: 'TASK',
            practiceId: null,
        });
        (WorkItemRepository.setStatus as jest.Mock).mockResolvedValue({
            id: 'task-1',
            status: 'CLOSED',
        });

        const captured: AutomationDomainEvent[] = [];
        getAutomationBus().subscribe('TASK_STATUS_CHANGED', (e) => {
            captured.push(e);
        });

        await setTaskStatus(makeCtx(), 'task-1', 'CLOSED', 'fixed in rev 42');

        expect(captured).toHaveLength(1);
        const evt = captured[0];
        expect(evt.stableKey).toBe('task-1:RESOLVED:CLOSED');
        if (evt.event === 'TASK_STATUS_CHANGED') {
            expect(evt.data.fromStatus).toBe('RESOLVED');
            expect(evt.data.toStatus).toBe('CLOSED');
            expect(evt.data.resolution).toBe('fixed in rev 42');
        }
    });

    test('createIssue publishes ISSUE_CREATED with ticket metadata', async () => {
        (WorkItemRepository.create as jest.Mock).mockResolvedValue({
            id: 'issue-1',
            key: 'ISS-7',
            title: 'Backup failure',
            severity: 'HIGH',
            status: 'OPEN',
            assigneeUserId: null,
        });

        const captured: AutomationDomainEvent[] = [];
        getAutomationBus().subscribe('ISSUE_CREATED', (e) => {
            captured.push(e);
        });

        await createIssue(makeCtx(), {
            title: 'Backup failure',
            type: 'TASK',
            severity: 'HIGH',
        });

        expect(captured).toHaveLength(1);
        const evt = captured[0];
        expect(evt.stableKey).toBe('issue-1');
        if (evt.event === 'ISSUE_CREATED') {
            expect(evt.data.key).toBe('ISS-7');
            expect(evt.data.severity).toBe('HIGH');
            expect(evt.data.status).toBe('OPEN');
        }
    });

    test('setIssueStatus publishes ISSUE_STATUS_CHANGED with from→to', async () => {
        (WorkItemRepository.getById as jest.Mock).mockResolvedValue({
            id: 'issue-1',
            status: 'OPEN',
        });
        (WorkItemRepository.setStatus as jest.Mock).mockResolvedValue({
            id: 'issue-1',
            status: 'RESOLVED',
        });

        const captured: AutomationDomainEvent[] = [];
        getAutomationBus().subscribe('ISSUE_STATUS_CHANGED', (e) => {
            captured.push(e);
        });

        // S8 — RESOLVED is a terminal status that requires a non-
        // empty resolution. OPEN → RESOLVED is the legal short-
        // circuit transition ("fixed during triage").
        await setIssueStatus(makeCtx(), 'issue-1', 'RESOLVED', 'backup restored');

        expect(captured).toHaveLength(1);
        const evt = captured[0];
        expect(evt.stableKey).toBe('issue-1:OPEN:RESOLVED');
        if (evt.event === 'ISSUE_STATUS_CHANGED') {
            expect(evt.data).toEqual({
                fromStatus: 'OPEN',
                toStatus: 'RESOLVED',
            });
        }
    });
});
