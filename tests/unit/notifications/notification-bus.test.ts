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
    subscribeToPersonEvents,
    publishNotificationEvent,
    publishPersonEvent,
    getNotificationSubscriberCount,
    __resetNotificationBusForTests,
    PERSON_CHANNEL_PREFIX,
    PERSON_SCOPE_SENTINEL,
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

describe('the PERSON channel — a third address, not a fourth farm (#2809)', () => {
    /**
     * A direct message has no tenant: P8.1's four DM tables carry none,
     * because two people in a conversation may share no farm. So these events
     * cannot ride `notif:<tenantId>:<userId>` — the two alternatives on #2809
     * both fail, and the tests below are what hold the chosen one.
     */
    it('reaches the addressed person', () => {
        const got: NotificationEvent[] = [];
        subscribeToPersonEvents({ userId: 'u-alice', send: (e) => got.push(e) });

        publishPersonEvent('u-alice', { id: 'conv-1' });

        // The positive control every zero below needs: a bus bound to nothing
        // also delivers nothing.
        expect(got).toEqual([{ id: 'conv-1' }]);
    });

    it('does NOT reach a different person', () => {
        const mine: NotificationEvent[] = [];
        const theirs: NotificationEvent[] = [];
        subscribeToPersonEvents({ userId: 'u-alice', send: (e) => mine.push(e) });
        subscribeToPersonEvents({ userId: 'u-boris', send: (e) => theirs.push(e) });

        publishPersonEvent('u-alice', { id: 'conv-1' });

        expect(mine).toHaveLength(1);
        expect(theirs).toHaveLength(0);
    });

    it('is a SEPARATE namespace from the tenant channels, in both directions', () => {
        const person: NotificationEvent[] = [];
        const farm: NotificationEvent[] = [];
        subscribeToPersonEvents({ userId: 'u-alice', send: (e) => person.push(e) });
        subscribeToNotifications({
            tenantId: 't-acme',
            userId: 'u-alice',
            send: (e) => farm.push(e),
        });

        publishPersonEvent('u-alice', { id: 'conv-1' });
        expect(person).toHaveLength(1);
        // A person event must not spill into a farm channel: a DM is not a
        // notification row, has nothing to refetch under a tenant, and would
        // make a client refetch a list that cannot contain it.
        expect(farm).toHaveLength(0);

        publishNotificationEvent('t-acme', 'u-alice', { id: 'notif-1' });
        expect(farm).toHaveLength(1);
        // And the converse, which is the half that would break a bell: a
        // notification must not arrive as a `dm` frame.
        expect(person).toHaveLength(1);
    });

    it('cannot be impersonated by a tenant whose id is the sentinel word', () => {
        // The two namespaces are disjoint BY PREFIX: a person channel is
        // `person:<userId>` and every tenant channel starts `notif:`, so no
        // value of `tenantId` can reach a person's subscribers.
        //
        // The first draft shared the prefix (`notif:person:<userId>`), which a
        // tenant whose id was literally `person` would collide with — and the
        // only assertion available was "zero or one", which is vacuously true
        // and therefore no test at all. Making the prefixes disjoint is what
        // turned this into something that can fail.
        const person: NotificationEvent[] = [];
        const impostor: NotificationEvent[] = [];
        subscribeToPersonEvents({ userId: 'u-alice', send: (e) => person.push(e) });
        subscribeToNotifications({
            tenantId: PERSON_SCOPE_SENTINEL,
            userId: 'u-alice',
            send: (e) => impostor.push(e),
        });

        publishPersonEvent('u-alice', { id: 'conv-1' });

        expect(person).toHaveLength(1);
        expect(impostor).toHaveLength(0);
        expect(PERSON_CHANNEL_PREFIX).toBe('person:');
        expect(PERSON_CHANNEL_PREFIX.startsWith('notif:')).toBe(false);
    });

    it('unsubscribes cleanly, leaving no subscriber behind', () => {
        const release = subscribeToPersonEvents({ userId: 'u-alice', send: () => {} });
        expect(getNotificationSubscriberCount()).toBe(1);
        release();
        expect(getNotificationSubscriberCount()).toBe(0);
        // Idempotent, like its sibling: the SSE route can reach cleanup from
        // both an abort and a stream cancel (#1984).
        release();
        expect(getNotificationSubscriberCount()).toBe(0);
    });
});
