/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Action Execution Engine — proves each action type produces a REAL side
 * effect (the gap this PR closes: the engine used to record intent and do
 * nothing).
 */
const enqueueMock = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: (...a: unknown[]) => enqueueMock(...a) }));
const lookupMock = jest.fn((..._a: unknown[]) =>
    Promise.resolve({ address: '93.184.216.34', family: 4 }),
);
jest.mock('node:dns/promises', () => ({ lookup: (...a: unknown[]) => lookupMock(...a) }));

import { executeAction } from '@/app-layer/automation/action-executor';

const baseEvent = {
    tenantId: 't1',
    event: 'TASK_CREATED',
    entityType: 'Task',
    entityId: 'task-1',
    actorUserId: 'u1',
    data: { taskId: 'task-1' },
};

function makeDb() {
    return {
        // membership filter: echo back whatever userIds were requested as members
        tenantMembership: {
            findMany: jest.fn(async (args: any) =>
                (args.where.userId.in as string[]).map((userId: string) => ({ userId })),
            ),
        },
        tenantNotificationSettings: { findUnique: jest.fn().mockResolvedValue({ enabled: true }) },
        notification: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
        task: {
            create: jest.fn().mockResolvedValue({ id: 'task-1' }),
            findFirst: jest.fn().mockResolvedValue(null),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
    } as any;
}

beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as any) = jest.fn().mockResolvedValue({ ok: true, status: 200 });
});

describe('executeAction', () => {
    it('NOTIFY_USER creates a notification row per recipient', async () => {
        const db = makeDb();
        const res = await executeAction(db, {
            id: 'r1', name: 'Alert', actionType: 'NOTIFY_USER', createdByUserId: 'u1',
            actionConfigJson: { userIds: ['a', 'b'], message: 'heads up' },
        }, baseEvent);
        expect(res.ok).toBe(true);
        const arg = db.notification.createMany.mock.calls[0][0];
        expect(arg.data).toHaveLength(2);
        expect(arg.data[0]).toMatchObject({ tenantId: 't1', userId: 'a', message: 'heads up' });
    });

    it('CREATE_TASK creates a task owned by the actor', async () => {
        const db = makeDb();
        const res = await executeAction(db, {
            id: 'r1', name: 'Remediate', actionType: 'CREATE_TASK', createdByUserId: 'u9',
            actionConfigJson: { title: 'Fix it', severity: 'HIGH' },
        }, baseEvent);
        expect(res.ok).toBe(true);
        expect(res.detail).toEqual({ taskId: 'task-1' });
        expect(db.task.create.mock.calls[0][0].data).toMatchObject({
            tenantId: 't1', title: 'Fix it', severity: 'HIGH', createdByUserId: 'u1', source: 'INTEGRATION',
        });
    });

    it('UPDATE_STATUS writes the field on the event entity', async () => {
        const db = makeDb();
        const res = await executeAction(db, {
            id: 'r1', name: 'Close', actionType: 'UPDATE_STATUS', createdByUserId: 'u1',
            actionConfigJson: { entityType: 'Task', field: 'status', toStatus: 'RESOLVED' },
        }, baseEvent);
        expect(res.ok).toBe(true);
        expect(db.task.updateMany).toHaveBeenCalledWith({
            where: { id: 'task-1', tenantId: 't1' },
            // A terminal Task status also stamps completedAt — the
            // dedicated lockstep test below owns that rule; here we only
            // need the status write itself to land.
            data: { status: 'RESOLVED', completedAt: expect.any(Date) },
        });
    });

    it('UPDATE_STATUS keeps a Task completedAt in lockstep with the status it writes', async () => {
        // This path bypasses WorkItemRepository entirely, so it has to
        // reproduce the repository's completedAt rule itself. Break:
        // writing bare `{ status }` — a rule-driven close then counts as
        // completed work with no timestamp (missing from the dashboard
        // trend), and a rule-driven re-open leaves the old timestamp on a
        // visibly-open task (still counted as completed). The allowlist
        // permits both terminal and active targets, so both are live.
        const db = makeDb();
        const taskEvent = { ...baseEvent, entityId: 'task-9' };

        await executeAction(db, {
            id: 'r1', name: 'Close', actionType: 'UPDATE_STATUS', createdByUserId: 'u1',
            actionConfigJson: { entityType: 'Task', field: 'status', toStatus: 'CLOSED' },
        }, taskEvent);
        await executeAction(db, {
            id: 'r2', name: 'Reopen', actionType: 'UPDATE_STATUS', createdByUserId: 'u1',
            actionConfigJson: { entityType: 'Task', field: 'status', toStatus: 'IN_PROGRESS' },
        }, taskEvent);
        await executeAction(db, {
            id: 'r3', name: 'Cancel', actionType: 'UPDATE_STATUS', createdByUserId: 'u1',
            actionConfigJson: { entityType: 'Task', field: 'status', toStatus: 'CANCELED' },
        }, taskEvent);

        const dataAt = (i: number) => db.task.updateMany.mock.calls[i][0].data;
        expect(dataAt(0).status).toBe('CLOSED');
        expect(dataAt(0).completedAt).toBeInstanceOf(Date);
        expect(dataAt(1)).toEqual({ status: 'IN_PROGRESS', completedAt: null });
        // CANCELED is terminal but NOT completed — same rule the
        // repository applies. See work-item-status.ts.
        expect(dataAt(2)).toEqual({ status: 'CANCELED', completedAt: null });
    });

    it('WEBHOOK fires a real signed HTTP POST', async () => {
        const db = makeDb();
        const res = await executeAction(db, {
            id: 'r1', name: 'Push', actionType: 'WEBHOOK', createdByUserId: 'u1',
            actionConfigJson: { url: 'https://example.com/hook', secretRef: 'shh' },
        }, baseEvent);
        expect(res.ok).toBe(true);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = (global.fetch as any).mock.calls[0];
        expect(url).toBe('https://example.com/hook');
        expect(init.method).toBe('POST');
        expect(init.headers['X-Inflect-Signature']).toMatch(/^sha256=/);
        // Dual-emit (Roadmap-5 PR3): canonical X-Agrent-Signature carries the
        // identical value, routed through the shared buildOutboundHeaders.
        expect(init.headers['X-Agrent-Signature']).toBe(init.headers['X-Inflect-Signature']);
        expect(init.headers['User-Agent']).toBe('Agrent-Automation/1');
    });

    it('INVOKE_SUBFLOW enqueues the sub-flow dispatch', async () => {
        const db = makeDb();
        const res = await executeAction(db, {
            id: 'r1', name: 'Branch', actionType: 'INVOKE_SUBFLOW', createdByUserId: 'u1',
            actionConfigJson: { targetGroupId: 'g1' },
        }, baseEvent);
        expect(res.ok).toBe(true);
        expect(enqueueMock).toHaveBeenCalledWith('subflow-dispatch', expect.objectContaining({ targetGroupId: 'g1' }));
    });

    it('returns ok:false (never throws) when a handler errors', async () => {
        const db = makeDb();
        db.notification.createMany.mockRejectedValue(new Error('db down'));
        const res = await executeAction(db, {
            id: 'r1', name: 'Alert', actionType: 'NOTIFY_USER', createdByUserId: 'u1',
            actionConfigJson: { userIds: ['a'], message: 'x' },
        }, baseEvent);
        expect(res.ok).toBe(false);
        expect(res.summary).toMatch(/failed/i);
    });
});

describe('PR-D hardening guards', () => {
    const ruleOf = (actionType: string, actionConfigJson: unknown) => ({
        id: 'r1', name: 'R', actionType, createdByUserId: 'u1', actionConfigJson,
    });

    it('UPDATE_STATUS rejects a non-status field', async () => {
        const db = makeDb();
        const res = await executeAction(db, ruleOf('UPDATE_STATUS', {
            entityType: 'Task', field: 'resolution', toStatus: 'pwned',
        }), baseEvent);
        expect(res.ok).toBe(false);
        expect(db.task.updateMany).not.toHaveBeenCalled();
    });

    it('UPDATE_STATUS rejects an illegal target status', async () => {
        const db = makeDb();
        const res = await executeAction(db, ruleOf('UPDATE_STATUS', {
            entityType: 'Task', field: 'status', toStatus: 'banana',
        }), baseEvent);
        expect(res.ok).toBe(false);
        expect(res.summary).toMatch(/illegal/i);
        expect(db.task.updateMany).not.toHaveBeenCalled();
    });

    it('WEBHOOK blocks a non-https URL (no fetch)', async () => {
        const db = makeDb();
        const res = await executeAction(db, ruleOf('WEBHOOK', { url: 'http://example.com/h' }), baseEvent);
        expect(res.ok).toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('WEBHOOK blocks a host that resolves to a private IP (no fetch)', async () => {
        const db = makeDb();
        lookupMock.mockResolvedValueOnce({ address: '10.0.0.5', family: 4 });
        const res = await executeAction(db, ruleOf('WEBHOOK', { url: 'https://evil.example.com/h' }), baseEvent);
        expect(res.ok).toBe(false);
        expect(res.summary).toMatch(/private/i);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('CREATE_TASK dedupes against an existing open task', async () => {
        const db = makeDb();
        db.task.findFirst.mockResolvedValue({ id: 'existing-task' });
        const res = await executeAction(db, ruleOf('CREATE_TASK', { title: 'X' }), baseEvent);
        expect(res.ok).toBe(true);
        expect(res.detail).toMatchObject({ deduped: true });
        expect(db.task.create).not.toHaveBeenCalled();
    });

    it('NOTIFY_USER is suppressed when the tenant disables notifications', async () => {
        const db = makeDb();
        db.tenantNotificationSettings.findUnique.mockResolvedValue({ enabled: false });
        const res = await executeAction(db, ruleOf('NOTIFY_USER', { userIds: ['a'], message: 'x' }), baseEvent);
        expect(res.ok).toBe(true);
        expect(db.notification.createMany).not.toHaveBeenCalled();
    });
});
