/**
 * A per-IMEI rate cap for the Codec 8 listener — #2948 §3.
 *
 * ## The obvious implementation is itself the denial of service
 *
 * "A per-IMEI rate cap" reads as `Map<imei, count>`. On a port facing the
 * public internet with no authentication, the KEY is attacker-supplied: a
 * flood of randomly-generated 15-digit IMEIs creates a new map entry each
 * time, and the thing protecting the database exhausts the listener's heap
 * instead. The cap has to bound its own state, not just the writes.
 *
 * So this holds **at most `MAX_TRACKED` buckets** and evicts the
 * least-recently-seen when full. Two consequences, both deliberate:
 *
 *  - An attacker CAN evict a real device's bucket by flooding, which resets
 *    that device's allowance early. That is a far smaller harm than either
 *    unbounded memory or refusing the real device outright, and it is bounded
 *    by the cap itself — the eviction gives the real machine MORE allowance,
 *    never less throughput than it would otherwise have.
 *  - The eviction is LRU by last-seen rather than by remaining allowance,
 *    because evicting the most-throttled bucket is exactly what an attacker
 *    would want: it would make the cap forget the device it was busy limiting.
 *
 * ## Unknown IMEIs are capped BEFORE the allowlist lookup, deliberately
 *
 * The allowlist lives in Postgres. Checking it first means one TCP packet per
 * database query, so an unauthenticated flood becomes a query flood — against
 * the same database the farm's own requests use, and against the 1-2
 * connections the listener deliberately holds (#2948, pool decision). The
 * cheap in-memory cap runs first and the lookup only happens for a connection
 * that is within its allowance.
 *
 * ## It is a TOKEN BUCKET, not a fixed window
 *
 * A fixed window lets a device send its whole allowance in the last
 * millisecond of one window and again in the first of the next — twice the
 * intended rate across the boundary, which for a tracker reporting every 30 s
 * is the difference between 2 and 4 records a minute being accepted. The
 * bucket refills continuously, so the rate holds across any interval.
 *
 * ## The clock is injected
 *
 * Not for purity — because a time-dependent cap tested against the real clock
 * can only be tested by sleeping, and a test that sleeps is a test nobody runs
 * at a boundary. Every refill, eviction and boundary case below is exercised
 * at an exact instant.
 */

/**
 * Tokens a bucket holds when full. A tracker at the documented 30-second
 * cadence sends 2 records a minute, so 20 is ten times the expected rate: it
 * absorbs a device replaying a buffered backlog after a GSM outage — which is
 * normal and expected (see `MachinePosition.recordedAt`) — while still
 * bounding a device gone haywire.
 */
export const BURST = 20;

/** Tokens restored per second. 0.5/s is 30 records a minute sustained. */
export const REFILL_PER_SECOND = 0.5;

/**
 * How many IMEIs are tracked at once.
 *
 * Sized against the fleet, not the attacker: production holds single-digit
 * farms, and 10,000 buckets is ~1 MB. The number's job is to be a CEILING
 * that exists, not to be exactly right.
 */
export const MAX_TRACKED = 10_000;

interface Bucket {
    tokens: number;
    lastRefillMs: number;
    lastSeenMs: number;
}

export interface RateCapOptions {
    burst?: number;
    refillPerSecond?: number;
    maxTracked?: number;
}

export interface Verdict {
    allowed: boolean;
    /** Tokens left after this decision, for the listener's log line. */
    remaining: number;
    /** True when this call evicted another IMEI's bucket to make room. */
    evicted: boolean;
}

export class ImeiRateCap {
    private readonly buckets = new Map<string, Bucket>();
    private readonly burst: number;
    private readonly refillPerSecond: number;
    private readonly maxTracked: number;

    constructor(opts: RateCapOptions = {}) {
        this.burst = opts.burst ?? BURST;
        this.refillPerSecond = opts.refillPerSecond ?? REFILL_PER_SECOND;
        this.maxTracked = opts.maxTracked ?? MAX_TRACKED;
    }

    /** How many IMEIs are currently tracked — the bound this class exists for. */
    get size(): number {
        return this.buckets.size;
    }

    /**
     * Spend one token for `imei` at `nowMs`.
     *
     * `nowMs` is passed in rather than read from `Date.now()` so the listener
     * uses one instant for a whole frame — a frame carrying 10 records must not
     * see the clock move between them and refill mid-decision.
     */
    take(imei: string, nowMs: number): Verdict {
        let evicted = false;
        let b = this.buckets.get(imei);

        if (!b) {
            if (this.buckets.size >= this.maxTracked) {
                evicted = this.evictOldest();
                // If eviction could not free a slot the map is at its ceiling
                // with nothing to drop, which can only happen at maxTracked 0.
                // Refusing is the safe direction: the alternative is growing.
                if (!evicted && this.buckets.size >= this.maxTracked) {
                    return { allowed: false, remaining: 0, evicted: false };
                }
            }
            b = { tokens: this.burst, lastRefillMs: nowMs, lastSeenMs: nowMs };
            this.buckets.set(imei, b);
        }

        // Refill before spending, clamped at the burst ceiling. `max(0, …)`
        // guards a clock that went backwards — NTP correction, a container
        // clock jump — which would otherwise grant a negative refill and
        // silently tighten the cap.
        const elapsedMs = Math.max(0, nowMs - b.lastRefillMs);
        b.tokens = Math.min(this.burst, b.tokens + (elapsedMs / 1000) * this.refillPerSecond);
        b.lastRefillMs = nowMs;
        b.lastSeenMs = nowMs;

        if (b.tokens < 1) {
            return { allowed: false, remaining: b.tokens, evicted };
        }
        b.tokens -= 1;
        return { allowed: true, remaining: b.tokens, evicted };
    }

    /**
     * Drop the least-recently-SEEN bucket.
     *
     * Deliberately not the most-throttled one: evicting whichever bucket has
     * fewest tokens is what an attacker wants, because it makes the cap forget
     * precisely the device it is busy limiting.
     */
    private evictOldest(): boolean {
        let oldestKey: string | null = null;
        let oldestSeen = Infinity;
        for (const [k, v] of this.buckets) {
            if (v.lastSeenMs < oldestSeen) {
                oldestSeen = v.lastSeenMs;
                oldestKey = k;
            }
        }
        if (oldestKey === null) return false;
        this.buckets.delete(oldestKey);
        return true;
    }
}
