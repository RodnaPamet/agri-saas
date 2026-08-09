/**
 * Unit coverage for the assignment notification module (PR-A
 * 2026-05-27). The structural ratchet locks the wiring in task.ts
 * and practice/mutations.ts; this file pins the behavioural
 * contract of the helper:
 *
 *   1. dedupeKey shape: `{tenantId}:{TYPE}:{entityId}:{userId}:{YYYY-MM-DD}`.
 *   2. duplicate calls within one day collapse (skipDuplicates).
 *   3. TASK_ASSIGNED and CONTROL_ASSIGNED point at the right
 *      tenant-scoped detail-page URL.
 */

import {
    buildAssignmentDedupeKey,
    createAssignmentNotification,
    type AssignmentTarget,
} from '@/app-layer/notifications/assignment';
import {
    publishNotificationEvent,
    __resetNotificationBusForTests,
    subscribeToNotifications,
    type NotificationEvent,
} from '@/lib/notifications/notification-bus';

// publishNotificationEvent is the real module here; the bus is
// reset between tests so subscriber state doesn't leak.
void publishNotificationEvent;

describe('buildAssignmentDedupeKey', () => {
    it('formats as tenantId:TYPE:entityId:userId:YYYY-MM-DD', () => {
        const key = buildAssignmentDedupeKey(
            'tenant-1',
            'TASK_ASSIGNED',
            'task-1',
            'user-1',
            new Date('2026-05-27T10:30:00Z'),
        );
        expect(key).toBe(
            'tenant-1:TASK_ASSIGNED:task-1:user-1:2026-05-27',
        );
    });

    it('different KIND produces different key (so TASK + CONTROL of the same id don\'t collide)', () => {
        const taskKey = buildAssignmentDedupeKey(
            'tenant-1',
            'TASK_ASSIGNED',
            'entity-1',
            'user-1',
            new Date('2026-05-27T10:30:00Z'),
        );
        const practiceKey = buildAssignmentDedupeKey(
            'tenant-1',
            'CONTROL_ASSIGNED',
            'entity-1',
            'user-1',
            new Date('2026-05-27T10:30:00Z'),
        );
        expect(taskKey).not.toBe(practiceKey);
    });
});

function makeTarget(overrides: Partial<AssignmentTarget> = {}): AssignmentTarget {
    return {
        tenantId: 'tenant-1',
        assigneeUserId: 'user-1',
        entityId: 'task-1',
        entityLabel: 'Patch the firewall',
        entityKey: 'T-42',
        tenantSlug: 'acme',
        ...overrides,
    };
}

describe('createAssignmentNotification', () => {
    let createManyMock: jest.Mock;
    let db: {
        notification: {
            createMany: jest.Mock;
        };
    };

    beforeEach(() => {
        createManyMock = jest.fn();
        db = { notification: { createMany: createManyMock } };
    });

    it('returns "created" when a new row is inserted', async () => {
        createManyMock.mockResolvedValueOnce({ count: 1 });
        const result = await createAssignmentNotification(
            db as never,
            'TASK_ASSIGNED',
            makeTarget(),
        );
        expect(result.status).toBe('created');
    });

    it('returns "duplicate" when skipDuplicates collapses the insert', async () => {
        createManyMock.mockResolvedValueOnce({ count: 0 });
        const result = await createAssignmentNotification(
            db as never,
            'TASK_ASSIGNED',
            makeTarget(),
        );
        expect(result.status).toBe('duplicate');
    });

    it('writes type=TASK_ASSIGNED with the tenant-scoped /tasks deep link', async () => {
        createManyMock.mockResolvedValueOnce({ count: 1 });
        await createAssignmentNotification(
            db as never,
            'TASK_ASSIGNED',
            makeTarget({ entityId: 'task-X', tenantSlug: 'acme' }),
        );
        const args = createManyMock.mock.calls[0][0];
        const row = args.data[0];
        expect(row.type).toBe('TASK_ASSIGNED');
        expect(row.linkUrl).toBe('/t/acme/farm-tasks/task-X');
        expect(args.skipDuplicates).toBe(true);
    });

    it('writes type=CONTROL_ASSIGNED with the tenant-scoped /practices deep link', async () => {
        createManyMock.mockResolvedValueOnce({ count: 1 });
        await createAssignmentNotification(
            db as never,
            'CONTROL_ASSIGNED',
            makeTarget({ entityId: 'ctrl-X', tenantSlug: 'acme' }),
        );
        const args = createManyMock.mock.calls[0][0];
        const row = args.data[0];
        expect(row.type).toBe('CONTROL_ASSIGNED');
        expect(row.linkUrl).toBe('/t/acme/practices/ctrl-X');
    });

    it('writes type=RISK_ASSIGNED with the tenant-scoped /risks deep link', async () => {
        createManyMock.mockResolvedValueOnce({ count: 1 });
        await createAssignmentNotification(
            db as never,
            'RISK_ASSIGNED',
            makeTarget({ entityId: 'risk-X', tenantSlug: 'acme' }),
        );
        const row = createManyMock.mock.calls[0][0].data[0];
        expect(row.type).toBe('RISK_ASSIGNED');
        expect(row.linkUrl).toBe('/t/acme/risks/risk-X');
    });

    it('writes type=ASSET_ASSIGNED with the tenant-scoped /assets deep link', async () => {
        createManyMock.mockResolvedValueOnce({ count: 1 });
        await createAssignmentNotification(
            db as never,
            'ASSET_ASSIGNED',
            makeTarget({ entityId: 'asset-X', tenantSlug: 'acme' }),
        );
        const row = createManyMock.mock.calls[0][0].data[0];
        expect(row.type).toBe('ASSET_ASSIGNED');
        expect(row.linkUrl).toBe('/t/acme/assets/asset-X');
    });

    it('routes the notification to the assignee user (NOT the actor)', async () => {
        // The recipient of an assignment alert is the NEW assignee,
        // never the actor who made the change — locked here so a
        // future refactor can't accidentally swap to `ctx.userId`.
        createManyMock.mockResolvedValueOnce({ count: 1 });
        await createAssignmentNotification(
            db as never,
            'TASK_ASSIGNED',
            makeTarget({ assigneeUserId: 'recipient-1' }),
        );
        const row = createManyMock.mock.calls[0][0].data[0];
        expect(row.userId).toBe('recipient-1');
    });

    it('uses `entityKey "entityLabel"` body shape when key is present', async () => {
        createManyMock.mockResolvedValueOnce({ count: 1 });
        await createAssignmentNotification(
            db as never,
            'TASK_ASSIGNED',
            makeTarget({ entityKey: 'T-42', entityLabel: 'Patch firewall' }),
        );
        const row = createManyMock.mock.calls[0][0].data[0];
        expect(row.message).toContain('T-42');
        expect(row.message).toContain('"Patch firewall"');
    });

    it('falls back to just `"entityLabel"` when key is null', async () => {
        createManyMock.mockResolvedValueOnce({ count: 1 });
        await createAssignmentNotification(
            db as never,
            'TASK_ASSIGNED',
            makeTarget({ entityKey: null, entityLabel: 'Unkeyed task' }),
        );
        const row = createManyMock.mock.calls[0][0].data[0];
        expect(row.message).toContain('"Unkeyed task"');
    });
});

describe('createAssignmentNotification — SSE publish (2026-05-28 follow-up)', () => {
    let createManyMock: jest.Mock;
    let db: { notification: { createMany: jest.Mock } };

    beforeEach(() => {
        __resetNotificationBusForTests();
        createManyMock = jest.fn();
        db = { notification: { createMany: createManyMock } };
    });

    it('fans the event to the SSE bus when the row inserts (count > 0)', async () => {
        const received: NotificationEvent[] = [];
        subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => received.push(e),
        });

        createManyMock.mockResolvedValueOnce({ count: 1 });
        await createAssignmentNotification(
            db as never,
            'TASK_ASSIGNED',
            {
                tenantId: 'tenant-1',
                assigneeUserId: 'user-1',
                entityId: 'task-1',
                entityLabel: 'Test task',
                entityKey: 'T-1',
                tenantSlug: 'acme',
            },
            new Date('2026-05-28T12:00:00Z'),
        );

        expect(received).toHaveLength(1);
        expect(received[0].type).toBe('TASK_ASSIGNED');
        expect(received[0].linkUrl).toBe('/t/acme/farm-tasks/task-1');
        // The publish uses the dedupeKey as the event id (the
        // helper doesn't have the DB-assigned id from createMany).
        expect(received[0].id).toBe(
            'tenant-1:TASK_ASSIGNED:task-1:user-1:2026-05-28',
        );
    });

    it('SKIPS the bus publish when skipDuplicates collapses the insert', async () => {
        // Same-day re-assign — the dedupeKey already exists, so
        // `count === 0`. The original publish already fired when
        // the row was first inserted; publishing again would
        // double-prepend in the bell.
        const received: NotificationEvent[] = [];
        subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => received.push(e),
        });

        createManyMock.mockResolvedValueOnce({ count: 0 });
        const result = await createAssignmentNotification(
            db as never,
            'TASK_ASSIGNED',
            {
                tenantId: 'tenant-1',
                assigneeUserId: 'user-1',
                entityId: 'task-1',
                entityLabel: 'Test',
                entityKey: null,
                tenantSlug: 'acme',
            },
        );
        expect(result.status).toBe('duplicate');
        expect(received).toHaveLength(0);
    });

    it('does NOT publish to a subscriber on a different (tenant, user)', async () => {
        // Cross-tenant isolation: a publish for tenant-1/user-1
        // must NOT leak to a subscriber on tenant-2/user-1 (the
        // bus filters; this is the helper's end-to-end test).
        const wrongTenantSubscriber: NotificationEvent[] = [];
        const wrongUserSubscriber: NotificationEvent[] = [];
        const correctSubscriber: NotificationEvent[] = [];

        subscribeToNotifications({
            tenantId: 'tenant-2',
            userId: 'user-1',
            send: (e) => wrongTenantSubscriber.push(e),
        });
        subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-OTHER',
            send: (e) => wrongUserSubscriber.push(e),
        });
        subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => correctSubscriber.push(e),
        });

        createManyMock.mockResolvedValueOnce({ count: 1 });
        await createAssignmentNotification(
            db as never,
            'CONTROL_ASSIGNED',
            {
                tenantId: 'tenant-1',
                assigneeUserId: 'user-1',
                entityId: 'ctrl-1',
                entityLabel: 'Some practice',
                entityKey: 'C-1',
                tenantSlug: 'acme',
            },
        );

        expect(correctSubscriber).toHaveLength(1);
        expect(wrongTenantSubscriber).toHaveLength(0);
        expect(wrongUserSubscriber).toHaveLength(0);
    });
});
