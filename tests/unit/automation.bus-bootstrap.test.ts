/**
 * Unit Test: bus → BullMQ wiring.
 *
 * After `installAutomationBusDispatcher()`, emitting on the bus
 * must:
 *   - enqueue an `automation-event-dispatch` job
 *   - serialize `emittedAt` to an ISO string (JSON-safe)
 *   - preserve all tenant-safe metadata from the event
 *   - carry top-level `tenantId` matching the event (the mismatch
 *     guard in the executor depends on this)
 */

// Mock the queue before importing the bootstrap — binds the import.
const enqueue = jest.fn().mockResolvedValue({ id: 'job-1' });
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (...args: unknown[]) => enqueue(...args),
}));

import {
    installAutomationBusDispatcher,
    bullmqAutomationDispatcher,
    toDispatchPayload,
    resetAutomationBus,
    emitAutomationEvent,
    getAutomationBus,
} from '@/app-layer/automation';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

function makeCtx(): RequestContext {
    return {
        requestId: 'req-1',
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

/**
 * Shared TASK_CREATED payload. These tests are about the bus
 * bootstrap + dispatch envelope, not any one domain — the payload
 * used to be RISK_CREATED until the risk register was removed, and
 * every assertion below is unchanged.
 */
const TASK_CREATED_DATA = {
    key: 'TSK-1',
    title: 't',
    type: 'CORRECTIVE',
    severity: 'MEDIUM',
    priority: 'NORMAL',
    assigneeUserId: null,
    controlId: null,
} as const;

describe('bus-bootstrap', () => {
    beforeEach(() => {
        enqueue.mockClear();
        resetAutomationBus();
    });

    describe('toDispatchPayload', () => {
        it('serializes emittedAt to ISO string', () => {
            const now = new Date('2026-04-22T10:00:00.000Z');
            const payload = toDispatchPayload({
                event: 'TASK_CREATED',
                tenantId: 'tenant-A',
                entityType: 'Task',
                entityId: 'r-1',
                actorUserId: 'user-1',
                emittedAt: now,
                data: TASK_CREATED_DATA,
            });
            expect(payload.tenantId).toBe('tenant-A');
            expect(payload.event.emittedAt).toBe('2026-04-22T10:00:00.000Z');
            expect(payload.event.tenantId).toBe('tenant-A');
        });

        it('top-level tenantId always matches event.tenantId (mismatch guard)', () => {
            const p = toDispatchPayload({
                event: 'TASK_CREATED',
                tenantId: 'tenant-X',
                entityType: 'Task',
                entityId: 'r-1',
                actorUserId: null,
                emittedAt: new Date(),
                data: TASK_CREATED_DATA,
            });
            expect(p.tenantId).toBe(p.event.tenantId);
        });
    });

    describe('bullmqAutomationDispatcher', () => {
        it('enqueues automation-event-dispatch with serialized payload', async () => {
            await bullmqAutomationDispatcher({
                event: 'TASK_CREATED',
                tenantId: 'tenant-A',
                entityType: 'Task',
                entityId: 'r-1',
                actorUserId: 'user-1',
                emittedAt: new Date('2026-04-22T10:00:00.000Z'),
                data: TASK_CREATED_DATA,
            });

            expect(enqueue).toHaveBeenCalledWith(
                'automation-event-dispatch',
                expect.objectContaining({
                    tenantId: 'tenant-A',
                    event: expect.objectContaining({
                        event: 'TASK_CREATED',
                        tenantId: 'tenant-A',
                        emittedAt: '2026-04-22T10:00:00.000Z',
                    }),
                })
            );
        });

        it('propagates enqueue failures so the bus logs them', async () => {
            enqueue.mockRejectedValueOnce(new Error('redis down'));
            await expect(
                bullmqAutomationDispatcher({
                    event: 'TASK_CREATED',
                    tenantId: 'tenant-A',
                    entityType: 'Task',
                    entityId: 'r-1',
                    actorUserId: null,
                    emittedAt: new Date(),
                    data: TASK_CREATED_DATA,
                })
            ).rejects.toThrow('redis down');
        });
    });

    describe('installAutomationBusDispatcher', () => {
        it('after install, emit() triggers queue.enqueue once per event', async () => {
            installAutomationBusDispatcher();

            await emitAutomationEvent(makeCtx(), {
                event: 'TASK_CREATED',
                entityType: 'Task',
                entityId: 'r-1',
                actorUserId: 'user-1',
                data: TASK_CREATED_DATA,
            });

            expect(enqueue).toHaveBeenCalledTimes(1);
            const [jobName, payload] = enqueue.mock.calls[0];
            expect(jobName).toBe('automation-event-dispatch');
            expect(payload.tenantId).toBe('tenant-A');
            expect(payload.event.event).toBe('TASK_CREATED');
            // emittedAt serialized to string for Redis.
            expect(typeof payload.event.emittedAt).toBe('string');
        });

        it('surviving subscribers still fire alongside queue enqueue', async () => {
            const observed: string[] = [];
            getAutomationBus().subscribe('TASK_CREATED', (e) => {
                observed.push(e.event);
            });
            installAutomationBusDispatcher();

            await emitAutomationEvent(makeCtx(), {
                event: 'TASK_CREATED',
                entityType: 'Task',
                entityId: 'r-1',
                actorUserId: null,
                data: TASK_CREATED_DATA,
            });

            expect(observed).toEqual(['TASK_CREATED']);
            expect(enqueue).toHaveBeenCalledTimes(1);
        });

        it('is idempotent — repeated install does not multiply dispatch', async () => {
            installAutomationBusDispatcher();
            installAutomationBusDispatcher();
            installAutomationBusDispatcher();

            await emitAutomationEvent(makeCtx(), {
                event: 'TASK_CREATED',
                entityType: 'Task',
                entityId: 'r-1',
                actorUserId: null,
                data: TASK_CREATED_DATA,
            });

            expect(enqueue).toHaveBeenCalledTimes(1);
        });

        it('enqueue failure does not throw out of emit (bus swallows)', async () => {
            enqueue.mockRejectedValueOnce(new Error('redis down'));
            installAutomationBusDispatcher();

            await expect(
                emitAutomationEvent(makeCtx(), {
                    event: 'TASK_CREATED',
                    entityType: 'Task',
                    entityId: 'r-1',
                    actorUserId: null,
                    data: TASK_CREATED_DATA,
                })
            ).resolves.toBeUndefined();
        });
    });
});
