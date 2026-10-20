/**
 * A bounded number of live SSE streams per person — P7.2 (#1991).
 *
 * ## Why a cap at all
 *
 * Each stream holds a bus subscription and a heartbeat timer for as long as a
 * tab stays open. A person with fifteen tabs is fifteen subscriptions, and
 * nothing today stops that: the cost is linear in tabs and paid on the server.
 * #1991 sets the cap at three, which covers a laptop, a phone and a
 * second-monitor tab.
 *
 * ## Why Redis rather than a module-level counter
 *
 * A process-local count is wrong in two directions. It over-counts after a
 * restart, because a count of streams that died with the process is still
 * positive until something reaps it; and it under-counts across pods, because
 * a person's three tabs can land on three processes and each sees one. The
 * number has to live where every process can read it.
 *
 * ## Expiry is the leak defence, not a nicety
 *
 * A slot is a Redis key with a TTL, refreshed while the stream lives and
 * deleted on release. A crashed process releases nothing — so without a TTL
 * its slots would be held for ever and a person would lock themselves out of
 * their own notifications by having a pod die. The TTL is the only mechanism
 * that survives a process that cannot run its own cleanup, which is why it is
 * generous relative to the heartbeat but finite.
 *
 * P7.10's (#1999) criterion for this is "10k connect/abort cycles leave 0
 * subscribers". That is a statement about release, and the test below asserts
 * the same property at a size a unit test can run.
 *
 * ## The fourth stream is REFUSED, not evicted
 *
 * #1991 leaves the choice open ("refuse, or evict the oldest"). Refusing, for
 * a reason that is mechanical rather than a preference: `EventSource`
 * reconnects by itself when a stream it holds is closed. Evicting the oldest
 * would close a tab's stream, that tab would reconnect, its reconnection would
 * evict another, and four tabs would produce a reconnect storm that costs more
 * than the subscriptions the cap exists to bound.
 *
 * Refusal is announced as 204, which is the status the route already uses for
 * the flag-off case — and per the EventSource specification a non-200 response
 * fails the connection WITHOUT a reconnect, so a refused tab stops asking
 * rather than retrying into the same wall. That property is taken from the
 * spec rather than measured here, the same caveat the existing route records,
 * because jsdom implements no EventSource.
 */
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';

/** Streams one person may hold at once. */
export const MAX_STREAMS_PER_USER = 3;

/**
 * How long a slot survives without a refresh.
 *
 * Longer than the stream's heartbeat so an ordinary live stream never expires
 * mid-flight, and short enough that a pod dying does not hold its slots for a
 * shift. The refresh cadence is the caller's business; this is the ceiling.
 */
export const SLOT_TTL_SECONDS = 120;

export interface StreamSlot {
    /** Extend this slot's TTL. Call on the same cadence as the heartbeat. */
    refresh: () => Promise<void>;
    /** Give the slot back. Idempotent. */
    release: () => Promise<void>;
}

/** Why an acquire failed, for the caller to turn into a response. */
export type AcquireResult =
    | { ok: true; slot: StreamSlot }
    | { ok: false; reason: 'at-capacity' };

/**
 * Keyed on the PERSON, with no tenant term.
 *
 * #1991 says "3 streams per user", and this key is the only thing that decides
 * whether that is true. A `sse:slot:<tenantId>:<userId>:*` pattern — which is
 * what this was first written as — caps three streams per MEMBERSHIP, so
 * somebody in three farms holds nine, and the number the cap is meant to bound
 * grows with how many farms a person joins. The route's own reason for existing
 * is that a person holds one connection rather than one per tenant; a per-tenant
 * cap would contradict the path it is served from.
 *
 * The cost of the person key is that the SCAN pattern is not tenant-prefixed,
 * so a count walks one person's slots wherever they came from. That is the
 * intent: all of them count against the same three.
 */
function slotKey(userId: string, id: string): string {
    return `sse:slot:${userId}:${id}`;
}

function slotPattern(userId: string): string {
    return `sse:slot:${userId}:*`;
}

/**
 * Take a slot, or report that the person is at capacity.
 *
 * ## Without Redis this does not refuse anyone
 *
 * `getRedis()` returns null when Redis is not configured, and then every
 * acquire succeeds with a no-op slot. That is deliberate: the cap is a
 * resource bound, not a security control, and a deployment without Redis
 * (a developer's machine, a self-hosted install) should get working streams
 * rather than a refusal it cannot diagnose. The subscription still releases on
 * disconnect through the stream's own lifecycle — the cap is what bounds
 * CONCURRENCY, not what prevents leaks.
 */
export async function acquireStreamSlot(
    userId: string,
    streamId: string,
): Promise<AcquireResult> {
    const redis = getRedis();
    if (!redis) {
        return { ok: true, slot: { refresh: async () => {}, release: async () => {} } };
    }

    const key = slotKey(userId, streamId);
    try {
        // SCAN rather than KEYS: KEYS is O(n) over the WHOLE keyspace and
        // blocks the server, and this runs on every stream open. The count is
        // of one person's slots, so the cursor loop ends almost immediately.
        const held = await countSlots(redis, slotPattern(userId));
        if (held >= MAX_STREAMS_PER_USER) {
            logger.info('sse.at_capacity', {
                component: 'realtime',
                held,
                max: MAX_STREAMS_PER_USER,
            });
            return { ok: false, reason: 'at-capacity' };
        }

        // Counted first, then claimed. The race is real — two tabs opening in
        // the same instant can both see 2 and both claim — and it is
        // deliberately not closed with a Lua script or a counter key.
        //
        // The failure it permits is one extra stream for one person, which
        // costs one subscription. The alternatives cost more than that: an
        // INCR counter has no way to recover from a process that dies holding
        // it, which is the failure this whole design is shaped around, and a
        // script is a second place for the TTL semantics to live.
        await redis.set(key, '1', 'EX', SLOT_TTL_SECONDS);

        return {
            ok: true,
            slot: {
                refresh: async () => {
                    try {
                        await redis.expire(key, SLOT_TTL_SECONDS);
                    } catch {
                        // A refresh that fails lets the slot lapse, which
                        // frees it early. Harmless: the stream keeps running
                        // and the person is briefly under-counted.
                    }
                },
                release: async () => {
                    try {
                        await redis.del(key);
                    } catch {
                        // The TTL is the backstop. This is why there is one.
                    }
                },
            },
        };
    } catch (err) {
        // Redis being unreachable must not stop a person receiving
        // notifications. Same reasoning as the null client above.
        logger.warn('sse.slot_acquire_failed', {
            component: 'realtime',
            error: err instanceof Error ? err.message : String(err),
        });
        return { ok: true, slot: { refresh: async () => {}, release: async () => {} } };
    }
}

/** Count one person's live slots with SCAN. Exported for the test's benefit. */
export async function countSlots(
    redis: { scan: (...args: never[]) => Promise<[string, string[]]> },
    pattern: string,
): Promise<number> {
    let cursor = '0';
    let n = 0;
    do {
        const [next, keys] = await (redis.scan as unknown as (
            c: string,
            m: string,
            p: string,
            co: string,
            cnt: number,
        ) => Promise<[string, string[]]>)(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        n += keys.length;
    } while (cursor !== '0');
    return n;
}
