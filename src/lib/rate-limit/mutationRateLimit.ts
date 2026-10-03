/**
 * Distributed mutation-tier rate limiter (Roadmap-5 PR1).
 *
 * The Epic A.2 mutation tier used to keep its sliding-window counters in an
 * in-process `Map` (`src/lib/security/rate-limit.ts`). That is correct for a
 * single node but silently ineffective the moment the app runs on more than
 * one instance behind a load balancer — each instance enforces its own
 * fraction of the budget, so the real limit is `N × preset`. This module
 * moves the counter to the SAME Upstash-Redis + in-memory-fallback pattern the
 * Edge limiters use (`authRateLimit.ts` / `apiReadRateLimit.ts` /
 * `credential-rate-limit.ts`), so the budget is enforced globally.
 *
 * ## Latency contract (mobile-first)
 *
 * Exactly ONE Redis round-trip on the mutation hot path: `Ratelimit.limit()`
 * runs a single server-side sliding-window evaluation (no client-side
 * pipeline, no multi-command check). Mobile RTTs stack fast, so the hot path
 * never issues a second op.
 *
 * ## Semantics
 *
 * `Ratelimit.slidingWindow(maxAttempts, windowMs)` — the same primitive the
 * Edge tier already trusts. For presets that carry a `lockoutMs`, the Redis
 * path expresses back-pressure through the sliding window's natural
 * `reset` horizon rather than a separate fixed lockout; every lockout preset
 * is sized so `windowMs` bounds the block appropriately (see
 * docs/rate-limiting.md). The security property — blocked after `maxAttempts`
 * within the window — is identical.
 *
 * ## Fallback
 *
 * No Upstash env (or `RATE_LIMIT_MODE=memory`) ⇒ delegate to the existing
 * in-process sliding window. A zero-config single-node self-host is unchanged.
 * A Redis error at call time also degrades to the Map (fail-to-local, NOT
 * fail-open) so a Redis outage never removes rate limiting entirely.
 */
import { Ratelimit } from '@upstash/ratelimit';

import {
    checkRateLimit as checkRateLimitInMemory,
    resetRateLimit as resetRateLimitInMemory,
    type RateLimitConfig,
    type RateLimitResult,
} from '@/lib/security/rate-limit';
// edgeLogger (loose field types + runs on both runtimes) — the Node logger's
// warn() types `err` as Error, but we log String(err).
import { edgeLogger } from '@/lib/observability/edge-logger';

import { getUpstashRedis } from './upstashClient';
import {
    checkRateLimitRedis,
    resetRateLimitRedis,
    redisRateLimitAvailable,
} from './redisBucket';

const KEY_PREFIX = 'rl:mut';

// One Ratelimit instance per distinct (maxAttempts, windowMs) shape. Presets
// that share numbers (several are 60/min or 5/hr) reuse the same limiter.
const _limiters = new Map<string, Ratelimit>();

function limiterFor(config: RateLimitConfig): Ratelimit | null {
    const redis = getUpstashRedis();
    if (!redis) return null;

    const shape = `${config.maxAttempts}:${config.windowMs}`;
    let limiter = _limiters.get(shape);
    if (!limiter) {
        limiter = new Ratelimit({
            redis,
            prefix: KEY_PREFIX,
            limiter: Ratelimit.slidingWindow(
                config.maxAttempts,
                // config.windowMs is a plain number, so the template widens to
                // `string`; assert the `${number} ms` shape the Duration union
                // accepts (all presets are whole-millisecond windows).
                `${config.windowMs} ms` as `${number} ms`,
            ),
        });
        _limiters.set(shape, limiter);
    }
    return limiter;
}

/**
 * Check + record one attempt against the distributed sliding window.
 * Returns the SAME `RateLimitResult` shape the in-memory limiter returns, so
 * the middleware wire contract (429 + Retry-After + X-RateLimit-*) is
 * unchanged regardless of backend.
 */
export async function checkRateLimitDistributed(
    key: string,
    config: RateLimitConfig,
): Promise<RateLimitResult> {
    const limiter = limiterFor(config);
    if (!limiter) {
        // P1.8 — before the in-process Map, try the VM's OWN Redis.
        //
        // Production runs `RATE_LIMIT_MODE=memory` with no Upstash, in a single
        // container, so the Map was the whole store and every deploy reset
        // every counter. Watchtower recreates the container on each image push,
        // so a throttled caller was un-throttled minutes later.
        //
        // `null` means Redis could not answer inside its budget. Degrade to the
        // Map rather than fail open, matching the posture below: a limiter that
        // still counts locally beats no limiter.
        if (redisRateLimitAvailable()) {
            const viaRedis = await checkRateLimitRedis(key, config);
            if (viaRedis) return viaRedis;
        }
        // No Redis either — in-process Map (tests, or a self-host without one).
        return checkRateLimitInMemory(key, config);
    }

    try {
        const r = await limiter.limit(key); // ← single round-trip
        const retryAfterMs = r.success ? 0 : Math.max(0, r.reset - Date.now());
        return {
            allowed: r.success,
            remaining: Math.max(0, r.remaining),
            retryAfterMs,
        };
    } catch (err) {
        // Redis unreachable mid-request. Degrade to the local Map rather than
        // fail-open — a limiter that still counts locally beats no limiter.
        edgeLogger.warn('rate-limit.redis_error_fallback_memory', {
            component: 'rate-limit',
            err: String(err),
        });
        return checkRateLimitInMemory(key, config);
    }
}

/**
 * Clear the counter for a key (e.g. MFA verify success). Best-effort on the
 * Redis side: the sliding window ages out within `windowMs` regardless, so a
 * missed `DEL` only means the user keeps their (already-consumed) budget until
 * the window rolls off — never a lock-out, since success already let them
 * through.
 */
export async function resetRateLimitDistributed(key: string): Promise<void> {
    resetRateLimitInMemory(key);
    // P1.8 — clear the VM-Redis counter too. Unconditional and best-effort for
    // the same reason the Upstash DEL below is: a missed reset only means the
    // caller keeps an already-consumed budget until the window rolls off, never
    // a lock-out, because the success that triggered this already let them
    // through.
    if (redisRateLimitAvailable()) await resetRateLimitRedis(key);
    const redis = getUpstashRedis();
    if (!redis) return;
    try {
        await redis.del(`${KEY_PREFIX}:${key}`);
    } catch (err) {
        edgeLogger.warn('rate-limit.reset_del_failed', {
            component: 'rate-limit',
            err: String(err),
        });
    }
}

/** Test-only: drop memoised limiters so a suite can flip env between files. */
export function __resetMutationLimitersForTests(): void {
    _limiters.clear();
}
