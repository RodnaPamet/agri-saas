/**
 * 2026-05-27 — Unit coverage for the notification bus (PR-C), locking the
 * (tenant, user) routing contract + the subscriber-cleanup invariant.
 *
 * These run against the IN-PROCESS fallback, which is what the bus uses when
 * `REDIS_URL` is unset — the normal case in unit tests. That is deliberate and
 * is also why `getNotificationBusMode()` exists: a suite that could not tell
 * which backing it exercised would report the Redis path green without ever
 * touching it. The Redis path has its own coverage (#1990).
 */

import {
    subscribeToNotifications,
    publishNotificationEvent,
    getNotificationSubscriberCount,
    __resetNotificationBusForTests,
    type NotificationEvent,
} from '@/lib/notifications/notification-bus';

/**
 * IDs only as of #1990. The fixture used to carry `type`, `title`, `message`,
 * `read`, `linkUrl` and `createdAt`; the event carries an id and the client
 * refetches the body over REST with ETag.
 */
const sampleEvent: NotificationEvent = { id: 'evt-1' };

beforeEach(() => {
    __resetNotificationBusForTests();
});

describe('notification bus', () => {
    it('publishes to subscribers matching (tenant, user)', () => {
        const received: NotificationEvent[] = [];
        const unsubscribe = subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => received.push(e),
        });

        publishNotificationEvent('tenant-1', 'user-1', sampleEvent);
        expect(received).toHaveLength(1);
        expect(received[0]).toEqual(sampleEvent);

        unsubscribe();
    });

    it('does NOT publish to subscribers in a different tenant', () => {
        const received: NotificationEvent[] = [];
        const unsub = subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => received.push(e),
        });
        // Same user id but different tenant — must NOT fan out.
        publishNotificationEvent('tenant-OTHER', 'user-1', sampleEvent);
        expect(received).toHaveLength(0);
        unsub();
    });

    it('does NOT publish to subscribers in the same tenant but different user', () => {
        const received: NotificationEvent[] = [];
        const unsub = subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => received.push(e),
        });
        publishNotificationEvent('tenant-1', 'user-OTHER', sampleEvent);
        expect(received).toHaveLength(0);
        unsub();
    });

    it('publishes to multiple subscribers for the same (tenant, user)', () => {
        // Two tabs open by the same user — both should see the event.
        const r1: NotificationEvent[] = [];
        const r2: NotificationEvent[] = [];
        const u1 = subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => r1.push(e),
        });
        const u2 = subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => r2.push(e),
        });

        publishNotificationEvent('tenant-1', 'user-1', sampleEvent);
        expect(r1).toHaveLength(1);
        expect(r2).toHaveLength(1);
        u1();
        u2();
    });

    it('unsubscribe removes the subscriber', () => {
        const received: NotificationEvent[] = [];
        const unsubscribe = subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => received.push(e),
        });
        expect(getNotificationSubscriberCount()).toBe(1);

        unsubscribe();
        expect(getNotificationSubscriberCount()).toBe(0);

        publishNotificationEvent('tenant-1', 'user-1', sampleEvent);
        expect(received).toHaveLength(0);
    });

    it('drops a subscriber whose send() throws (poison-pill recovery)', () => {
        // A crashing subscriber (e.g. controller closed mid-flush)
        // MUST be removed so the bus stays healthy for the rest.
        const surviving: NotificationEvent[] = [];
        const u1 = subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: () => {
                throw new Error('boom');
            },
        });
        const u2 = subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => surviving.push(e),
        });

        publishNotificationEvent('tenant-1', 'user-1', sampleEvent);

        // The healthy subscriber received the event.
        expect(surviving).toHaveLength(1);
        // The crashing one was dropped.
        expect(getNotificationSubscriberCount()).toBe(1);

        u1();
        u2();
    });
});
