/**
 * Unit coverage for the assignment notification module (PR-A
 * 2026-05-27). The structural ratchet locks the wiring in task.ts
 * and asset.ts; this file pins the behavioural contract of the
 * helper:
 *
 *   1. dedupeKey shape: `{tenantId}:{TYPE}:{entityId}:{userId}:{YYYY-MM-DD}`.
 *   2. duplicate calls within one day collapse (skipDuplicates).
 *   3. TASK_ASSIGNED and ASSET_ASSIGNED point at the right
 *      tenant-scoped detail-page URL.
 *
 * GRC teardown phase 3 removed PRACTICE_ASSIGNED and RISK_ASSIGNED
 * from the kind union — the deep links they carried pointed at
 * `/practices` and `/risks`, which no longer exist. Cases that named
 * them are re-pointed at ASSET_ASSIGNED rather than deleted: the
 * property under test (two kinds produce different dedupe keys; the
 * bus fans out to the right subscriber) is about the mechanism, not
 * about which kinds happen to exist.
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

    it('different KIND produces different key (so TASK + PRACTICE of the same id don\'t collide)', () => {
        const taskKey = buildAssignmentDedupeKey(
            'tenant-1',
            'TASK_ASSIGNED',
            'entity-1',
            'user-1',
            new Date('2026-05-27T10:30:00Z'),
        );
        const assetKey = buildAssignmentDedupeKey(
            'tenant-1',
            'ASSET_ASSIGNED',
            'entity-1',
            'user-1',
            new Date('2026-05-27T10:30:00Z'),
        );
        expect(taskKey).not.toBe(assetKey);
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
            findMany: jest.Mock;
        };
    };

    beforeEach(() => {
        createManyMock = jest.fn();
        // `findMany` is the read-back seam #2142 added — the helper resolves
        // the row id by dedupeKey so the bus frame carries something a
        // reconnect can look up. These cases do not assert on the frame, but a
        // double missing the seam fails them all.
        db = {
            notification: {
                createMany: createManyMock,
                findMany: jest.fn().mockResolvedValue([{ id: 'row-1', dedupeKey: 'k' }]),
            },
        };
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
    let findFirstMock: jest.Mock;
    let db: { notification: { createMany: jest.Mock; findMany: jest.Mock } };

    beforeEach(() => {
        __resetNotificationBusForTests();
        createManyMock = jest.fn();
        // The read-back seam added by #2142. Two things this double has to
        // get right, both learned by getting them wrong:
        //
        //  1. It must EXIST. Without it every case here failed on
        //     `findMany is not a function` — loud, which is the good version
        //     of this problem.
        //  2. It must answer the key it was ASKED for. A canned row carrying
        //     one fixed dedupeKey made the ASSET_ASSIGNED case resolve
        //     nothing, so the helper skipped the publish and the test read an
        //     empty subscriber — a double that cannot express the behaviour it
        //     stands in for.
        //
        // So it echoes the requested keys back, one row each, numbered.
        findFirstMock = jest.fn(async ({ where }: { where: { dedupeKey: { in: string[] } } }) =>
            where.dedupeKey.in.map((dedupeKey, i) => ({ id: `notif-row-${i + 1}`, dedupeKey })),
        );
        db = { notification: { createMany: createManyMock, findMany: findFirstMock } };
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
        // `type` and `linkUrl` left the event in #1990 (ids only); the row
        // still carries them and the client refetches it. The id is what
        // remains assertable — and it is the ROW id.
        //
        // ── this case used to assert the opposite (#2142) ──
        //
        // It read:
        //
        //   // The publish uses the dedupeKey as the event id (the helper
        //   // doesn't have the DB-assigned id from createMany).
        //   expect(received[0].id).toBe('tenant-1:TASK_ASSIGNED:task-1:user-1:2026-05-28');
        //
        // under a comment calling that "the contract worth locking because the
        // helper has no DB-assigned id to use instead". The premise was true —
        // `createMany` returns no ids — and the conclusion was the bug: since
        // P7.2 a frame's id is the client's `Last-Event-ID`, which
        // `replayNotificationIdsAfter` resolves as a `Notification.id`. A
        // dedupeKey matches no row, so a client whose newest frame came from
        // here replayed NOTHING on its next reconnect.
        //
        // So the test was locking a defect as a contract, which is the most
        // expensive kind of green. The helper reads the row back by its
        // dedupeKey; the key is now how the id is FOUND, never what is sent.
        expect(received[0].id).toBe('notif-row-1');
        expect(received[0].id).not.toContain('TASK_ASSIGNED');
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
            'ASSET_ASSIGNED',
            {
                tenantId: 'tenant-1',
                assigneeUserId: 'user-1',
                entityId: 'asset-1',
                entityLabel: 'Some asset',
                entityKey: 'A-1',
                tenantSlug: 'acme',
            },
        );

        expect(correctSubscriber).toHaveLength(1);
        expect(wrongTenantSubscriber).toHaveLength(0);
        expect(wrongUserSubscriber).toHaveLength(0);
    });
});
