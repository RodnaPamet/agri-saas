/**
 * Unit Test: Automation repository query shapes.
 *
 * Uses a mocked Prisma client to pin the *shape* of every query this
 * foundation layer issues. Two invariants matter most:
 *
 *  1. Every call filters by `ctx.tenantId`. Tenant isolation at the
 *     repo layer is load-bearing (no DB-level RLS fallback for app
 *     bugs outside Prisma).
 *  2. The dispatcher hot path (`findEnabledForEvent`) always excludes
 *     soft-deleted rules and sorts by priority desc, creation asc.
 *
 * Ratchets here defend both invariants without needing a live Postgres.
 */
import { AutomationRuleRepository } from '@/app-layer/automation/AutomationRuleRepository';
import { AutomationExecutionRepository } from '@/app-layer/automation/AutomationExecutionRepository';
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

function makeCtx(): RequestContext {
    return {
        requestId: 'req-repo',
        userId: 'user-1',
        tenantId: 'tenant-xyz',
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

type MockFn = jest.Mock;
function makeDb(): {
    db: PrismaTx;
    automationRule: Record<string, MockFn>;
    automationExecution: Record<string, MockFn>;
} {
    const automationRule = {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'rule-1' }),
        update: jest.fn().mockResolvedValue({ id: 'rule-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const automationExecution = {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'exec-1' }),
        update: jest.fn().mockResolvedValue({ id: 'exec-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: { automationRule, automationExecution } as any,
        automationRule,
        automationExecution,
    };
}

describe('AutomationRuleRepository — tenant scoping + query shape', () => {
    it('list() filters by tenantId and excludes soft-deleted by default', async () => {
        const { db, automationRule } = makeDb();
        const ctx = makeCtx();

        await AutomationRuleRepository.list(db, ctx);

        const call = automationRule.findMany.mock.calls[0][0];
        expect(call.where.tenantId).toBe(ctx.tenantId);
        expect(call.where.deletedAt).toBeNull();
        expect(call.orderBy).toEqual([
            { priority: 'desc' },
            { createdAt: 'desc' },
        ]);
    });

    it('list() with includeDeleted=true drops the deletedAt guard', async () => {
        const { db, automationRule } = makeDb();
        await AutomationRuleRepository.list(db, makeCtx(), {
            includeDeleted: true,
        });

        const call = automationRule.findMany.mock.calls[0][0];
        expect(call.where.deletedAt).toBeUndefined();
    });

    it('list() forwards status, triggerEvent, and actionType filters', async () => {
        const { db, automationRule } = makeDb();
        await AutomationRuleRepository.list(db, makeCtx(), {
            status: 'ENABLED',
            triggerEvent: 'RISK_CREATED',
            actionType: 'CREATE_TASK',
        });

        const call = automationRule.findMany.mock.calls[0][0];
        expect(call.where).toMatchObject({
            tenantId: 'tenant-xyz',
            status: 'ENABLED',
            triggerEvent: 'RISK_CREATED',
            actionType: 'CREATE_TASK',
        });
    });

    it('getById() requires tenantId match', async () => {
        const { db, automationRule } = makeDb();
        await AutomationRuleRepository.getById(db, makeCtx(), 'rule-42');

        expect(automationRule.findFirst).toHaveBeenCalledWith({
            where: { id: 'rule-42', tenantId: 'tenant-xyz' },
        });
    });

    it('findEnabledForEvent() restricts to ENABLED and non-deleted, priority-sorted', async () => {
        const { db, automationRule } = makeDb();
        await AutomationRuleRepository.findEnabledForEvent(
            db,
            makeCtx(),
            'RISK_STATUS_CHANGED'
        );

        const call = automationRule.findMany.mock.calls[0][0];
        expect(call.where).toEqual({
            tenantId: 'tenant-xyz',
            triggerEvent: 'RISK_STATUS_CHANGED',
            status: 'ENABLED',
            deletedAt: null,
        });
        expect(call.orderBy).toEqual([
            { priority: 'desc' },
            { createdAt: 'asc' },
        ]);
    });

    it('create() stamps tenantId + createdByUserId + updatedByUserId from ctx', async () => {
        const { db, automationRule } = makeDb();
        await AutomationRuleRepository.create(db, makeCtx(), {
            name: 'Notify owners of critical risks',
            triggerEvent: 'RISK_CREATED',
            actionType: 'NOTIFY_USER',
            actionConfig: { userIds: ['u-1'], message: 'hi' },
        });

        const call = automationRule.create.mock.calls[0][0];
        expect(call.data.tenantId).toBe('tenant-xyz');
        expect(call.data.createdByUserId).toBe('user-1');
        expect(call.data.updatedByUserId).toBe('user-1');
        expect(call.data.status).toBe('DRAFT'); // default
        expect(call.data.priority).toBe(0); // default
    });

    it('create() accepts explicit status + priority overrides', async () => {
        const { db, automationRule } = makeDb();
        await AutomationRuleRepository.create(db, makeCtx(), {
            name: 'High-priority rule',
            triggerEvent: 'TASK_CREATED',
            actionType: 'CREATE_TASK',
            actionConfig: { title: 'Investigate' },
            status: 'ENABLED',
            priority: 10,
        });
        const call = automationRule.create.mock.calls[0][0];
        expect(call.data.status).toBe('ENABLED');
        expect(call.data.priority).toBe(10);
    });

    it('update() short-circuits and returns null when rule does not exist in tenant', async () => {
        const { db, automationRule } = makeDb();
        automationRule.findFirst.mockResolvedValueOnce(null);

        const result = await AutomationRuleRepository.update(
            db,
            makeCtx(),
            'rule-x',
            { name: 'new' }
        );
        expect(result).toBeNull();
        expect(automationRule.update).not.toHaveBeenCalled();
    });

    it('update() stamps updatedByUserId on every mutation', async () => {
        const { db, automationRule } = makeDb();
        automationRule.findFirst.mockResolvedValueOnce({ id: 'rule-1' });

        await AutomationRuleRepository.update(db, makeCtx(), 'rule-1', {
            name: 'renamed',
        });
        const call = automationRule.update.mock.calls[0][0];
        expect(call.data.updatedByUserId).toBe('user-1');
        expect(call.data.name).toBe('renamed');
    });

    it('archive() sets ARCHIVED status + deletedAt timestamp', async () => {
        const { db, automationRule } = makeDb();
        automationRule.findFirst.mockResolvedValueOnce({ id: 'rule-1' });

        await AutomationRuleRepository.archive(db, makeCtx(), 'rule-1');
        const call = automationRule.update.mock.calls[0][0];
        expect(call.data.status).toBe('ARCHIVED');
        expect(call.data.deletedAt).toBeInstanceOf(Date);
        expect(call.data.updatedByUserId).toBe('user-1');
    });

    it('archive() ignores already-archived rules', async () => {
        const { db, automationRule } = makeDb();
        automationRule.findFirst.mockResolvedValueOnce(null); // deletedAt:null filter → no match

        const result = await AutomationRuleRepository.archive(
            db,
            makeCtx(),
            'rule-gone'
        );
        expect(result).toBeNull();
        expect(automationRule.update).not.toHaveBeenCalled();
    });

    it('recordFired() increments counter without touching updatedByUserId', async () => {
        const { db, automationRule } = makeDb();
        await AutomationRuleRepository.recordFired(db, makeCtx(), 'rule-1');

        const call = automationRule.updateMany.mock.calls[0][0];
        expect(call.where).toEqual({ id: 'rule-1', tenantId: 'tenant-xyz' });
        expect(call.data.executionCount).toEqual({ increment: 1 });
        expect(call.data.lastTriggeredAt).toBeInstanceOf(Date);
        expect(call.data.updatedByUserId).toBeUndefined();
    });
});

describe('AutomationExecutionRepository — tenant scoping + append-only', () => {
    it('list() filters by tenantId and orders newest-first', async () => {
        const { db, automationExecution } = makeDb();
        await AutomationExecutionRepository.list(db, makeCtx());

        const call = automationExecution.findMany.mock.calls[0][0];
        expect(call.where.tenantId).toBe('tenant-xyz');
        expect(call.orderBy).toEqual({ createdAt: 'desc' });
        expect(call.take).toBe(100);
    });

    it('findByIdempotencyKey() is tenant-scoped', async () => {
        const { db, automationExecution } = makeDb();
        await AutomationExecutionRepository.findByIdempotencyKey(
            db,
            makeCtx(),
            'key-1'
        );

        expect(automationExecution.findFirst).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-xyz', idempotencyKey: 'key-1' },
        });
    });

    it('recordStart() creates PENDING row with tenantId + startedAt + default triggeredBy=event', async () => {
        const { db, automationExecution } = makeDb();
        await AutomationExecutionRepository.recordStart(db, makeCtx(), {
            ruleId: 'rule-1',
            triggerEvent: 'RISK_CREATED',
            triggerPayload: { riskId: 'r-1' },
            idempotencyKey: 'idem-1',
        });

        const call = automationExecution.create.mock.calls[0][0];
        expect(call.data).toMatchObject({
            tenantId: 'tenant-xyz',
            ruleId: 'rule-1',
            triggerEvent: 'RISK_CREATED',
            status: 'PENDING',
            idempotencyKey: 'idem-1',
            triggeredBy: 'event',
        });
        expect(call.data.startedAt).toBeInstanceOf(Date);
    });

    it('recordStart() allows overriding triggeredBy for manual replays', async () => {
        const { db, automationExecution } = makeDb();
        await AutomationExecutionRepository.recordStart(db, makeCtx(), {
            ruleId: 'rule-1',
            triggerEvent: 'RISK_CREATED',
            triggerPayload: {},
            triggeredBy: 'manual',
        });
        expect(
            automationExecution.create.mock.calls[0][0].data.triggeredBy
        ).toBe('manual');
    });

    it('markRunning() only flips PENDING rows (prevents double-dispatch)', async () => {
        const { db, automationExecution } = makeDb();
        await AutomationExecutionRepository.markRunning(
            db,
            makeCtx(),
            'exec-1',
            'job-abc'
        );

        const call = automationExecution.updateMany.mock.calls[0][0];
        expect(call.where).toEqual({
            id: 'exec-1',
            tenantId: 'tenant-xyz',
            status: 'PENDING',
        });
        expect(call.data.status).toBe('RUNNING');
        expect(call.data.jobRunId).toBe('job-abc');
    });

    it('recordCompletion() returns null when execution not found in tenant', async () => {
        const { db, automationExecution } = makeDb();
        automationExecution.findFirst.mockResolvedValueOnce(null);

        const res = await AutomationExecutionRepository.recordCompletion(
            db,
            makeCtx(),
            'missing',
            { status: 'SUCCEEDED' }
        );
        expect(res).toBeNull();
        expect(automationExecution.update).not.toHaveBeenCalled();
    });

    it('recordCompletion() stamps completedAt and terminal status', async () => {
        const { db, automationExecution } = makeDb();
        automationExecution.findFirst.mockResolvedValueOnce({ id: 'exec-1' });

        await AutomationExecutionRepository.recordCompletion(
            db,
            makeCtx(),
            'exec-1',
            {
                status: 'SUCCEEDED',
                outcome: { taskId: 't-1' },
                durationMs: 42,
            }
        );

        const call = automationExecution.update.mock.calls[0][0];
        expect(call.where).toEqual({ id: 'exec-1' });
        expect(call.data.status).toBe('SUCCEEDED');
        expect(call.data.durationMs).toBe(42);
        expect(call.data.completedAt).toBeInstanceOf(Date);
    });

    it('listForRule() is tenant+rule scoped', async () => {
        const { db, automationExecution } = makeDb();
        await AutomationExecutionRepository.listForRule(
            db,
            makeCtx(),
            'rule-1',
            25
        );

        const call = automationExecution.findMany.mock.calls[0][0];
        expect(call.where).toEqual({
            tenantId: 'tenant-xyz',
            ruleId: 'rule-1',
        });
        expect(call.take).toBe(25);
    });
});
