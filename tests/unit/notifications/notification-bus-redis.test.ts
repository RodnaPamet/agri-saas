/**
 * The Redis backing of the notification bus — P7.1 (#1990).
 *
 * ## Why a separate file from `notification-bus.test.ts`
 *
 * That suite runs against the in-process fallback, because `REDIS_URL` is
 * unset in unit tests and `getRedis()` returns null. It is good coverage of
 * the routing contract and it cannot touch any of the behaviour this PR adds.
 *
 * Keeping them apart makes which backing is under test a property of the file
 * rather than of a mock somebody might remove — a suite that could not tell
 * the two apart would report the Redis path green without exercising it, which
 * is the shape of defect this whole phase keeps finding.
 *
 * ## What matters here
 *
 * The old bus iterated every subscriber and compared ids. Over Redis that
 * would mean every process receiving every notification in the deployment, so
 * routing moved into the channel name. The reference counting is the other
 * half: without it, one browser tab closing would unsubscribe a channel that
 * another tab for the same user is still reading, and the symptom would be a
 * user who stops receiving events after closing an unrelated tab.
 */
type MessageHandler = (channel: string, payload: string) => void;

const publishMock = jest.fn<Promise<number>, [string, string]>();
const subscribeMock = jest.fn<Promise<unknown>, [string]>();
const unsubscribeMock = jest.fn<Promise<unknown>, [string]>();
const quitMock = jest.fn<Promise<unknown>, []>();
let messageHandler: MessageHandler | null = null;
let redisPresent = true;

/**
 * The publish double LOOPS BACK through the message handler, because a real
 * broker does and the difference is load-bearing.
 *
 * Without it, a routing test has to feed channel strings to the handler by
 * hand — which means the test names the channel instead of the bus naming it,
 * and a bus that dropped the tenant from its channel key would still pass.
 * That is not hypothetical: it was the state of the cross-tenant test below
 * until mutating `channelFor` to `notif:${userId}` left it green.
 */
jest.mock('@/lib/redis', () => ({
    __esModule: true,
    getRedis: () =>
        redisPresent
            ? {
                  publish: (channel: string, payload: string) => {
                      const result = publishMock(channel, payload);
                      messageHandler?.(channel, payload);
                      return result;
                  },
              }
            : null,
    createRedisClient: () => ({
        on: (event: string, cb: MessageHandler) => {
            if (event === 'message') messageHandler = cb;
        },
        subscribe: subscribeMock,
        unsubscribe: unsubscribeMock,
        quit: quitMock,
    }),
}));
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
    subscribeToNotifications,
    publishNotificationEvent,
    getNotificationSubscriberCount,
    getNotificationBusMode,
    __resetNotificationBusForTests,
    type NotificationEvent,
} from '@/lib/notifications/notification-bus';

const CHANNEL = 'notif:tenant-1:user-1';

beforeEach(() => {
    jest.clearAllMocks();
    redisPresent = true;
    messageHandler = null;
    publishMock.mockResolvedValue(1);
    subscribeMock.mockResolvedValue(1);
    unsubscribeMock.mockResolvedValue(1);
    quitMock.mockResolvedValue(undefined);
    __resetNotificationBusForTests();
});

describe('the notification bus over Redis', () => {
    it('reports the redis mode when REDIS_URL resolves, and in-process when it does not', () => {
        // The mode must be observable. A silent fallback in production means
        // every event raised by the worker reaches no browser, with no failing
        // test and no error log to show it.
        expect(getNotificationBusMode()).toBe('redis');
        redisPresent = false;
        expect(getNotificationBusMode()).toBe('in-process');
    });

    it('subscribes to a channel keyed by BOTH tenant and user', () => {
        subscribeToNotifications({ tenantId: 'tenant-1', userId: 'user-1', send: () => {} });

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(subscribeMock).toHaveBeenCalledWith(CHANNEL);
    });

    it('publishes ids only, to the same channel', () => {
        publishNotificationEvent('tenant-1', 'user-1', { id: 'evt-1' });

        expect(publishMock).toHaveBeenCalledWith(CHANNEL, JSON.stringify({ id: 'evt-1' }));
    });

    it('strips anything beyond the id from the wire payload', () => {
        // The type says ids only; this asserts the SERIALISER does too, so a
        // caller passing extra fields through an `as` cast cannot put content
        // on a broadcast channel.
        publishNotificationEvent('tenant-1', 'user-1', {
            id: 'evt-1',
            title: 'secret',
        } as NotificationEvent);

        const [, payload] = publishMock.mock.calls[0];
        expect(JSON.parse(payload)).toEqual({ id: 'evt-1' });
        expect(payload).not.toContain('secret');
    });

    it('delivers a message from Redis to this process subscribers', () => {
        const received: NotificationEvent[] = [];
        subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => received.push(e),
        });

        messageHandler!(CHANNEL, JSON.stringify({ id: 'evt-9' }));

        expect(received).toEqual([{ id: 'evt-9' }]);
    });

    it('does NOT deliver another tenant or user, routed through publish', () => {
        // Routed through `publishNotificationEvent` rather than by handing the
        // handler a channel name, so the BUS decides the channel. Mutating
        // `channelFor` to drop the tenant makes this fail — the earlier
        // hand-fed version stayed green, which is the whole reason it changed.
        const received: NotificationEvent[] = [];
        subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => received.push(e),
        });

        publishNotificationEvent('tenant-2', 'user-1', { id: 'other-tenant' });
        publishNotificationEvent('tenant-1', 'user-2', { id: 'other-user' });

        expect(received).toEqual([]);

        // Positive control: the same path DOES deliver for the right pair, so
        // the empty result above is isolation and not a broken fixture.
        publishNotificationEvent('tenant-1', 'user-1', { id: 'mine' });
        expect(received).toEqual([{ id: 'mine' }]);
    });

    it('drops a malformed payload instead of forwarding it', () => {
        // `send` receiving junk would also take out the subscribers after it
        // in the loop, so this is about blast radius, not tidiness.
        const received: NotificationEvent[] = [];
        subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => received.push(e),
        });

        messageHandler!(CHANNEL, 'not json');
        messageHandler!(CHANNEL, JSON.stringify({ nope: 1 }));
        messageHandler!(CHANNEL, JSON.stringify({ id: 42 }));

        expect(received).toEqual([]);
    });

    it('SUBSCRIBEs once for two subscribers on one channel, and UNSUBSCRIBEs only on the last', () => {
        // Two tabs for one user. Without the reference count the first close
        // would unsubscribe the channel the second is still reading, and the
        // user would simply stop receiving events.
        const a = subscribeToNotifications({ tenantId: 'tenant-1', userId: 'user-1', send: () => {} });
        const b = subscribeToNotifications({ tenantId: 'tenant-1', userId: 'user-1', send: () => {} });

        expect(subscribeMock).toHaveBeenCalledTimes(1);
        expect(getNotificationSubscriberCount()).toBe(2);

        a();
        expect(unsubscribeMock).not.toHaveBeenCalled();
        expect(getNotificationSubscriberCount()).toBe(1);

        b();
        expect(unsubscribeMock).toHaveBeenCalledWith(CHANNEL);
        expect(getNotificationSubscriberCount()).toBe(0);
    });

    it('is idempotent when the same unsubscribe is called twice', () => {
        // The SSE route can reach cleanup from both an abort and a stream
        // cancel (#1984). A second call must not decrement a count it already
        // released, or one tab closing twice would unsubscribe another's
        // channel.
        const a = subscribeToNotifications({ tenantId: 'tenant-1', userId: 'user-1', send: () => {} });
        const b = subscribeToNotifications({ tenantId: 'tenant-1', userId: 'user-1', send: () => {} });

        a();
        a();
        a();

        expect(unsubscribeMock).not.toHaveBeenCalled();
        expect(getNotificationSubscriberCount()).toBe(1);

        b();
        expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    });

    it('leaves 0 subscribers after many connect/disconnect cycles', () => {
        // P7.10's criterion in miniature ("10k connect/abort cycles leave 0
        // subscribers"), at a size a unit test can afford. The leak this
        // guards is the one the route's docblock warns about: an unsubscribe
        // the caller fails to invoke grows the set unboundedly under tab
        // churn.
        for (let i = 0; i < 500; i++) {
            const off = subscribeToNotifications({
                tenantId: 'tenant-1',
                userId: `user-${i % 7}`,
                send: () => {},
            });
            off();
        }

        expect(getNotificationSubscriberCount()).toBe(0);
        expect(subscribeMock).toHaveBeenCalledTimes(500);
        expect(unsubscribeMock).toHaveBeenCalledTimes(500);
    });

    it('removes a subscriber whose send throws, without losing the others', () => {
        const good: NotificationEvent[] = [];
        subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: () => {
                throw new Error('client gone');
            },
        });
        subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => good.push(e),
        });

        messageHandler!(CHANNEL, JSON.stringify({ id: 'evt-1' }));

        expect(good).toEqual([{ id: 'evt-1' }]);
        expect(getNotificationSubscriberCount()).toBe(1);
    });

    it('falls back to in-process delivery with no Redis, without touching the client', () => {
        redisPresent = false;
        const received: NotificationEvent[] = [];
        subscribeToNotifications({
            tenantId: 'tenant-1',
            userId: 'user-1',
            send: (e) => received.push(e),
        });

        publishNotificationEvent('tenant-1', 'user-1', { id: 'evt-local' });

        expect(received).toEqual([{ id: 'evt-local' }]);
        expect(subscribeMock).not.toHaveBeenCalled();
        expect(publishMock).not.toHaveBeenCalled();
    });
});
