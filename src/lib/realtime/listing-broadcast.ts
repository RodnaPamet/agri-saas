/**
 * A coalesced "the market changed" tick for every connected client — #2123.
 *
 * ## Why this is not on the notification bus
 *
 * `notification-bus.ts` publishes to `notif:<tenantId>:<userId>` — one channel
 * per (farm, person), so Redis does the routing and a process receives only
 * what its own subscribers asked for. That is exactly right for a
 * notification, which is addressed to somebody.
 *
 * A listing is not addressed to anybody. `listActiveListings` says so in its
 * own words — "Browse ACTIVE listings across ALL tenants" — so a new listing
 * is interesting to every connected client, whichever farm they belong to.
 * There is no (tenant, user) pair to publish to, and enumerating every
 * connected person is the thing the channel scheme exists to avoid.
 *
 * ## Why it COALESCES rather than publishing per listing
 *
 * A client does not act on which listing changed: it refetches the list over
 * REST with ETag, because the payload carries ids and the row is
 * authoritative. So one event per listing buys nothing a single event does
 * not, and costs a refetch per listing per connected client — a thundering
 * refetch where a bounded one does the same job.
 *
 * So a change marks the window dirty and at most one tick is published per
 * {@link COALESCE_WINDOW_MS}. Ten listings created in a burst produce one
 * tick; a listing created in a quiet minute produces one tick immediately.
 * The tick is therefore a nudge with no payload of consequence, which is why
 * the frame carries a sentinel id rather than a listing id — see
 * {@link LISTING_TICK_ID}.
 *
 * ## The frame's `id` is a sentinel, and that is deliberate
 *
 * `StreamFrame` requires an `id`, and for a notification that is the row to
 * refetch. A coalesced tick refers to no single row — it says "the market
 * moved", and naming one of the several listings that moved would invite a
 * client to refetch that one and miss the rest. A constant makes the frame
 * well-formed without implying a row, and it means a client cannot
 * accidentally treat the value as a handle.
 *
 * The `tenantId` on a listing tick is the same sentinel for the same reason:
 * a coalesced tick spans farms, so there is no one seller to name. The field's
 * per-kind meaning is documented in `stream-frame.ts` — for `listing` it names
 * the seller and is NOT a relevance filter, and a tick that spans sellers has
 * no seller at all.
 *
 * ## No retention, by decision
 *
 * Owner ruling, 2026-10-21: listing events are live-only. A reconnecting
 * client replays its missed notifications from `Notification` and refetches
 * Борса over REST, which it does on a cold open anyway. Adding a second event
 * log to store what the listing rows already say is what P7.2's replay design
 * avoided, and a tick that said "something changed at some point while you
 * were away" is exactly what a cold-open refetch already covers.
 */
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';

/**
 * The channel every stream subscribes to. One, globally — not per farm.
 *
 * `agrent:` rather than `notif:` because it is not a notification and must not
 * collide with a per-person channel. The `no-legacy-brand` ratchet also wants
 * the current brand on anything new.
 */
export const LISTING_CHANNEL = 'agrent:listings';

/**
 * How long a tick suppresses the next one.
 *
 * Five seconds, chosen against what a client does with it: a refetch of the
 * first page of Борса. Faster than that and a burst of listings costs several
 * refetches for one user-visible change; much slower and the market stops
 * feeling live, which is the point of the feature. It is not a rate limit —
 * the window is per PROCESS and a multi-pod deployment can emit one tick per
 * pod per window, which is bounded by pod count and accepted.
 */
export const COALESCE_WINDOW_MS = 5_000;

/**
 * The `id` and `tenantId` a listing tick carries.
 *
 * A sentinel rather than a listing id or a seller: the tick refers to no
 * single row and spans farms, so naming one would invite a client to refetch
 * that one and miss the rest. Exported so a consumer can assert it rather
 * than pattern-match a magic string.
 */
export const LISTING_TICK_ID = 'listings';

/**
 * When this process last published, or null for never.
 *
 * `null` and not `0`, and a test caught why. With `0` standing in for "never",
 * the guard below computes `now - 0` and compares it as an ELAPSED interval —
 * which is only ever large enough because a real `Date.now()` is. Under an
 * injected clock the first tick of a process is suppressed, and the same would
 * be true of any clock near its own epoch.
 *
 * A sentinel that works because one of its inputs happens to be big is not a
 * sentinel; `null` says "never" and is checked for rather than subtracted from.
 *
 * Worth knowing: this INITIALISER is not reachable from a test, because
 * `_resetListingBroadcastForTesting` defines the "never" state that every case
 * starts from — mutating `null` to `0` here changes nothing any test can see,
 * and in production it is read once with a real `Date.now()`, which is far
 * larger than the window. What the tests DO prove is the reachable half: the
 * reset's own value, and that the guard CHECKS the sentinel rather than
 * subtracting from it. Both of those mutations fail nine cases.
 */
let lastPublishedAt: number | null = null;

/** Set by a subscriber so a process can deliver to its own clients. */
type TickListener = () => void;
const localListeners = new Set<TickListener>();

/**
 * Subscribe this process's streams to the market tick.
 *
 * Returns the unsubscribe, which the caller MUST invoke — the same contract as
 * `subscribeToNotifications`, and for the same reason: a set that grows under
 * tab churn is the leak P7.10's "10k connect/abort cycles leave 0 subscribers"
 * criterion exists to catch.
 */
export function subscribeToListings(listener: TickListener): () => void {
    localListeners.add(listener);

    // First subscriber in this process → SUBSCRIBE. Redis delivers to every
    // process, and each then fans out to its own clients in memory.
    if (localListeners.size === 1) {
        const redis = getRedis();
        if (redis) {
            const client = redis.duplicate();
            void client.subscribe(LISTING_CHANNEL).catch((err: Error) => {
                logger.error('listings.subscribe_failed', {
                    component: 'listings',
                    error: err.message,
                });
            });
            client.on('message', (channel: string) => {
                if (channel !== LISTING_CHANNEL) return;
                deliverLocally();
            });
            subscriberClient = client;
        }
    }

    let released = false;
    return () => {
        // Idempotent, for the reason `subscribeToNotifications` records: a
        // stream can reach cleanup from both an abort and a cancel, and a
        // second call must not unsubscribe a channel another tab is using.
        if (released) return;
        released = true;
        localListeners.delete(listener);
        if (localListeners.size === 0 && subscriberClient) {
            void subscriberClient.unsubscribe(LISTING_CHANNEL).catch(() => {
                // Costs an ignored channel rather than a leak.
            });
            subscriberClient.disconnect();
            subscriberClient = null;
        }
    };
}

let subscriberClient: ReturnType<NonNullable<ReturnType<typeof getRedis>>['duplicate']> | null =
    null;

function deliverLocally(): void {
    for (const l of localListeners) {
        try {
            l();
        } catch (err) {
            // One throwing listener must not cost the others their tick —
            // same poison-pill posture as the notification bus.
            logger.warn('listings.listener_threw', {
                component: 'listings',
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

/**
 * Mark the market changed. At most one tick leaves per window.
 *
 * Synchronous and never throws: callers are listing writes, and a notification
 * failure must not roll back or fail the write that caused it.
 *
 * Returns whether a tick was published, for tests and for the caller's log.
 */
export function publishListingChange(now: number = Date.now()): boolean {
    if (lastPublishedAt !== null && now - lastPublishedAt < COALESCE_WINDOW_MS) return false;
    lastPublishedAt = now;

    const redis = getRedis();
    if (!redis) {
        // No Redis: deliver in-process only, which is what a single-process
        // deployment needs and what every test gets. The notification bus
        // makes the same choice for the same reason.
        deliverLocally();
        return true;
    }

    void redis.publish(LISTING_CHANNEL, '1').catch((err: Error) => {
        logger.warn('listings.publish_failed', {
            component: 'listings',
            error: err.message,
        });
    });
    return true;
}

/** Test-only: forget the window and every subscriber. @internal */
export function _resetListingBroadcastForTesting(): void {
    lastPublishedAt = null;
    localListeners.clear();
    if (subscriberClient) {
        subscriberClient.disconnect();
        subscriberClient = null;
    }
}

/** Test-only: how many streams this process holds. @internal */
export function _listingSubscriberCountForTesting(): number {
    return localListeners.size;
}
