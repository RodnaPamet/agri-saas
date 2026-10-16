/**
 * Notification bus — Redis pub/sub across app and worker. P7.1 (#1990).
 *
 * Per-(tenant, user) pub/sub backing the SSE endpoint at
 * `src/app/api/notifications/stream/route.ts`. Subscribers register a
 * `send(event)` callback; publishers (the helpers in
 * `src/app-layer/notifications/` and several sweep jobs) fan events out to
 * every matching subscriber, now including subscribers in other processes.
 *
 * ## What this replaces, and why the seam was already here
 *
 * This was a module-level `Set<Subscriber>`, and its own docblock named the
 * limit: "a notification created on pod A won't push to a subscriber on pod
 * B... When cross-pod fanout becomes load-bearing, this module is the natural
 * seam to back with Redis pub/sub." It is load-bearing now, because the app
 * and `scripts/worker.ts` are separate processes: five of the eight publish
 * call sites are sweep jobs that run in the worker, so under the in-process
 * bus their events could never reach any browser at all.
 *
 * That is worth stating plainly: the old bus did not merely fail to scale
 * across pods, it dropped every event raised by a background job on a
 * single-VM deployment.
 *
 * ## IDs ONLY
 *
 * `NotificationEvent` carried `title`, `message`, `linkUrl` and `read`. It now
 * carries an id and nothing else, per the phase rule that payloads carry ids
 * and clients fetch bodies over REST with ETag (#1198).
 *
 * Three reasons, in order of how much they matter:
 *
 *   1. A broadcast channel carrying content is a channel whose contents are a
 *      question. An id is not sensitive on its own; a notification title can
 *      be.
 *   2. The row is authoritative and the event is a hint. Shipping content
 *      means a client can render a notification that was since edited or
 *      deleted, and there is no version to compare.
 *   3. `Last-Event-ID` replay (P7.2, #1991) has to re-send events after a
 *      reconnect. Replaying ids is cheap and idempotent; replaying bodies
 *      means deciding whether a body from five minutes ago is still true.
 *
 * This is safe to change now and would not have been at any other time: the
 * SSE channel is gated OFF (#1984 — the `notifications.sse` flag row does not
 * exist), so no client is receiving these events today.
 *
 * ## Channel per (tenant, user), not one channel plus a filter
 *
 * The old bus iterated every subscriber and compared ids. Keeping that shape
 * over Redis would mean every pod receiving every notification in the
 * deployment and discarding almost all of them — O(pods x events) delivered
 * to do O(1) useful work, and every pod seeing every tenant's traffic.
 *
 * `notif:<tenantId>:<userId>` lets Redis do the routing, so a process receives
 * only what its own subscribers asked for. The tenant id is in the channel
 * name rather than only the payload so that cross-tenant delivery is not
 * something a filter has to get right.
 *
 * ## One subscriber connection per process, reference-counted
 *
 * A Redis connection in subscriber mode cannot issue ordinary commands, so the
 * shared client from `getRedis()` cannot be used to subscribe — hence
 * `createRedisClient()`, which already exists for exactly this kind of extra
 * connection.
 *
 * One such connection is created lazily and shared, with a per-channel
 * reference count: the first subscriber on a channel issues SUBSCRIBE, the
 * last issues UNSUBSCRIBE. Without the count, two browser tabs for one user
 * would unsubscribe each other on the first disconnect.
 *
 * ## The fallback is EXPLICIT, because a silent one would be a lie
 *
 * `getRedis()` returns null when `REDIS_URL` is unset, which is the normal
 * case in unit tests. The bus then keeps the old in-process behaviour so tests
 * and a bare `next dev` work.
 *
 * It must never be silent in production. A deployment that lost Redis would
 * otherwise degrade to exactly the defect this PR exists to remove — worker
 * events reaching nobody — while every log line and every test stayed green.
 * So the mode is logged once on first use and exposed by
 * `getNotificationBusMode()` for health surfaces and tests to assert on.
 */
import { getRedis, createRedisClient } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';
import type Redis from 'ioredis';

/**
 * Public event shape. IDs ONLY — see the docblock.
 *
 * `id` is the notification's row id OR its `dedupeKey`; the publishers choose,
 * and the bell treats either as the dedup handle. Deliberately not a union of
 * the two: a consumer that needed to tell them apart would be reconstructing
 * state the row already has.
 */
export interface NotificationEvent {
    id: string;
}

interface Subscriber {
    tenantId: string;
    userId: string;
    send: (event: NotificationEvent) => void;
}

export type NotificationBusMode = 'redis' | 'in-process';

/** Subscribers held by THIS process, keyed by channel. */
const byChannel = new Map<string, Set<Subscriber>>();

let subscriberClient: Redis | null = null;
let modeLogged = false;

function channelFor(tenantId: string, userId: string): string {
    return `notif:${tenantId}:${userId}`;
}

/**
 * Which backing the bus is using right now.
 *
 * Resolved per call rather than captured once: `REDIS_URL` is read through
 * `getRedis()`, and a module-level constant would freeze the answer for the
 * life of the process — the same reason `flagsForcedOff()` is read per call.
 */
export function getNotificationBusMode(): NotificationBusMode {
    return getRedis() ? 'redis' : 'in-process';
}

function logModeOnce(mode: NotificationBusMode): void {
    if (modeLogged) return;
    modeLogged = true;
    if (mode === 'redis') {
        logger.info('notification-bus.mode', { component: 'notification-bus', mode });
        return;
    }
    // WARN, not info. In production this means every event raised by the
    // worker reaches no browser, and the symptom is silence.
    logger.warn('notification-bus.in_process_fallback', {
        component: 'notification-bus',
        mode,
        reason: 'REDIS_URL absent — cross-process fanout is DISABLED',
    });
}

/** The lazily-created subscriber connection, or null without Redis. */
function ensureSubscriberClient(): Redis | null {
    if (subscriberClient) return subscriberClient;
    if (!getRedis()) return null;

    const client = createRedisClient();
    client.on('message', (channel: string, payload: string) => {
        const subs = byChannel.get(channel);
        if (!subs || subs.size === 0) return;

        let event: NotificationEvent;
        try {
            const parsed = JSON.parse(payload) as unknown;
            if (
                typeof parsed !== 'object' ||
                parsed === null ||
                typeof (parsed as { id?: unknown }).id !== 'string'
            ) {
                throw new Error('payload is not { id: string }');
            }
            event = { id: (parsed as { id: string }).id };
        } catch {
            // A malformed payload is dropped rather than forwarded. The
            // client's recovery path is a refetch, and an event it cannot
            // parse would trigger that anyway — but forwarding junk into
            // `send` would also take out the subscribers that follow it.
            logger.warn('notification-bus.malformed_payload', {
                component: 'notification-bus',
            });
            return;
        }

        for (const sub of [...subs]) {
            try {
                sub.send(event);
            } catch {
                subs.delete(sub);
            }
        }
    });
    client.on('error', (err: Error) => {
        // Logged, never thrown: a subscriber connection error must not take
        // down a request. ioredis reconnects on its own and re-issues its
        // subscriptions.
        logger.error('notification-bus.subscriber_error', {
            component: 'notification-bus',
            error: err.message,
        });
    });

    subscriberClient = client;
    return client;
}

/**
 * Register a subscriber. Returns an unsubscribe function the caller MUST
 * invoke on disconnect — otherwise the per-channel set grows unboundedly
 * under tab churn, which is the leak P7.10's "10k connect/abort cycles leave
 * 0 subscribers" criterion exists to catch.
 */
export function subscribeToNotifications(sub: Subscriber): () => void {
    const mode = getNotificationBusMode();
    logModeOnce(mode);

    const channel = channelFor(sub.tenantId, sub.userId);
    let subs = byChannel.get(channel);
    if (!subs) {
        subs = new Set();
        byChannel.set(channel, subs);
    }
    subs.add(sub);

    // First subscriber on this channel in this process → SUBSCRIBE.
    if (subs.size === 1) {
        const client = ensureSubscriberClient();
        void client?.subscribe(channel).catch((err: Error) => {
            logger.error('notification-bus.subscribe_failed', {
                component: 'notification-bus',
                error: err.message,
            });
        });
    }

    let released = false;
    return () => {
        // Idempotent. The SSE route can reach cleanup from both an abort and a
        // stream cancel (#1984), and a second call must not decrement twice
        // and unsubscribe a channel another tab is still using.
        if (released) return;
        released = true;

        const current = byChannel.get(channel);
        if (!current) return;
        current.delete(sub);
        if (current.size > 0) return;

        byChannel.delete(channel);
        void subscriberClient?.unsubscribe(channel).catch(() => {
            // Nothing to do: the local set is already gone, so a failed
            // UNSUBSCRIBE costs a channel we ignore rather than a leak that
            // delivers.
        });
    };
}

/**
 * Publish one event to every subscriber of (tenantId, userId), in this process
 * and every other.
 *
 * ## Still `void`, deliberately
 *
 * Eight call sites invoke this without awaiting. Returning a promise would
 * turn each of them into a new unhandled-rejection path, and for no benefit:
 * the caller's row is already committed by the time this runs, so there is
 * nothing it could usefully do with a failure. A lost event degrades to the
 * bell's REST poll, which is the designed fallback.
 *
 * ## Published AFTER commit — a property of the callers, asserted separately
 *
 * No call site publishes inside a `$transaction` today (checked across all
 * eight). Published inside one, a rollback would emit an event for a
 * notification that does not exist, and the client would refetch and find
 * nothing. `tests/guards/notification-publish-after-commit.test.ts` holds that
 * property so it stays true by design rather than by luck.
 */
export function publishNotificationEvent(
    tenantId: string,
    userId: string,
    event: NotificationEvent,
): void {
    const mode = getNotificationBusMode();
    logModeOnce(mode);

    const channel = channelFor(tenantId, userId);

    if (mode === 'in-process') {
        deliverLocally(channel, event);
        return;
    }

    // The ordinary client publishes; only the subscriber connection is in
    // subscriber mode and therefore unable to.
    const redis = getRedis();
    void redis?.publish(channel, JSON.stringify({ id: event.id })).catch((err: Error) => {
        logger.error('notification-bus.publish_failed', {
            component: 'notification-bus',
            error: err.message,
        });
    });
}

/**
 * Deliver to this process's subscribers without going through Redis.
 *
 * Only the in-process fallback uses this. Under Redis the loopback arrives via
 * the subscriber connection like any other message, which is what keeps the
 * two paths from diverging: a local subscriber is not a special case.
 */
function deliverLocally(channel: string, event: NotificationEvent): void {
    const subs = byChannel.get(channel);
    if (!subs) return;
    for (const sub of [...subs]) {
        try {
            sub.send(event);
        } catch {
            subs.delete(sub);
        }
    }
}

/**
 * Test-only. Production subscribers come and go via the SSE route's lifetime.
 */
export function __resetNotificationBusForTests(): void {
    byChannel.clear();
    modeLogged = false;
    const client = subscriberClient;
    subscriberClient = null;
    if (client) void client.quit().catch(() => {});
}

/**
 * Diagnostic — subscribers held by THIS process.
 *
 * Process-local by definition, and the name says so: with Redis the
 * deployment-wide count is not knowable from here, and a function that implied
 * otherwise would be the more useful-sounding lie. P7.10's leak criterion is
 * about this number returning to zero.
 */
export function getNotificationSubscriberCount(): number {
    let total = 0;
    for (const subs of byChannel.values()) total += subs.size;
    return total;
}
