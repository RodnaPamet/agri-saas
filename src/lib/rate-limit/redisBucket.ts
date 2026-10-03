/**
 * Rate-limit counters on the VM's OWN Redis. P1.8.
 *
 * ## Why this exists
 *
 * Production runs `RATE_LIMIT_MODE=memory` with no Upstash configured, in a
 * SINGLE app container. So every budget lives in an in-process Map, and every
 * deploy — Watchtower recreates the container on each image push — resets every
 * counter to zero. A caller who has just been throttled is un-throttled by the
 * next deploy, and deploys are frequent.
 *
 * The VM already runs Redis for BullMQ and the list cache, reachable at
 * `REDIS_URL`. This puts the counters there, so they outlive the container.
 *
 * ## Why not in the Edge limiters
 *
 * The five tiers invoked from `src/middleware.ts` run on the EDGE runtime,
 * which cannot open a TCP socket — ioredis is Node-only, and so is Prisma, so
 * the Edge has no persistent store available at all in this deployment. Those
 * tiers keep their in-process Map until their enforcement moves into Node.
 *
 * This module is reached only from `mutationRateLimit.ts`, whose importers are
 * `rate-limit-middleware.ts` and Node route handlers — 21 files, none declaring
 * the Edge runtime, and `src/middleware.ts` is not among them. Verified before
 * writing: an ioredis import anywhere on the Edge chain fails the BUILD, not a
 * test.
 *
 * ## Why a Lua script rather than a MULTI
 *
 * It has to match `checkRateLimit`'s semantics in `security/rate-limit.ts`
 * exactly, because that is the fallback this degrades to — a limiter whose
 * behaviour changes when Redis blips is worse than either behaviour alone. Two
 * details that a naive `ZADD`-always implementation gets wrong:
 *
 *   1. A BLOCKED attempt does NOT join the window. The in-memory version
 *      filters, compares, and returns without pushing, so a caller hammering a
 *      closed door does not push their own reset further away.
 *   2. `lockoutMs`, when a preset sets it, measures from the LAST attempt
 *      rather than the oldest — a different and longer penalty.
 *
 * Count-then-conditionally-add is not atomic across two round-trips, so it
 * lives in one script and costs one round-trip.
 */
import { randomUUID } from 'crypto';
import type { RateLimitConfig, RateLimitResult } from '@/lib/security/rate-limit';
import type Redis from 'ioredis';
import { getRedis } from '@/lib/redis';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

const KEY_PREFIX = 'rl:node';

/**
 * How long a counter check may take before the request gives up on Redis.
 *
 * The shared client sets `commandTimeout: 5000` for BullMQ, where a five-second
 * wait on a job is nothing. On a request path it is a stall on every call while
 * Redis is unwell, so this budget is far shorter and the caller degrades to its
 * local Map instead.
 */
const BUDGET_MS = 150;

/**
 * Sliding window, atomic, one round-trip.
 *
 * Returns `{allowed, remaining, retryAfterMs}` as a 3-element array.
 */
const SCRIPT = `
local key        = KEYS[1]
local now        = tonumber(ARGV[1])
local windowMs   = tonumber(ARGV[2])
local maxAttempts= tonumber(ARGV[3])
local lockoutMs  = tonumber(ARGV[4])
local member     = ARGV[5]

redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)

if count >= maxAttempts then
    redis.call('PEXPIRE', key, windowMs)
    if lockoutMs > 0 then
        -- From the LAST attempt, matching the in-process fallback's lockout.
        local last = redis.call('ZRANGE', key, -1, -1, 'WITHSCORES')
        return {0, 0, math.max(0, tonumber(last[2]) + lockoutMs - now)}
    end
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    return {0, 0, math.max(0, tonumber(oldest[2]) + windowMs - now)}
end

-- Only an ALLOWED attempt joins the window.
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs)
return {1, maxAttempts - count - 1, 0}
`;

/**
 * True when a Redis-backed counter is both CONFIGURED and possible.
 *
 * Gated on the mode and not merely on `REDIS_URL`, which is present in every
 * container because BullMQ needs it. `RATE_LIMIT_MODE=memory` has to stay
 * definitive: an operator who sets it while debugging an incident must get the
 * in-process Map, not a silent upgrade to a store shared with every other
 * replica and surviving their restart.
 */
export function redisRateLimitAvailable(): boolean {
    if (env.RATE_LIMIT_MODE !== 'redis') return false;
    // `env`, not `process.env`: REDIS_URL is in the validated schema, so the
    // snapshot is the right reader and `no-fallbacks` is satisfied without an
    // allowlist entry. Needing an exclusion would have been the signal that I
    // was reaching past something that already existed.
    return !!env.REDIS_URL && getRedis() !== null;
}

/**
 * The script, registered as a CUSTOM COMMAND rather than called via `.eval(`.
 *
 * Two reasons, and the second is the one that made me look:
 *
 *   1. `defineCommand` uses EVALSHA with an automatic fallback to EVAL on
 *      NOSCRIPT, so the script body ships once per server rather than on every
 *      request.
 *   2. `tests/guards/csp-script-guardrails.test.ts` flags a literal `.eval(`
 *      as a construct requiring `unsafe-eval` in the CSP. For `redis.eval` that
 *      is a false positive — it is a Redis command, not JavaScript evaluation —
 *      but the fix was to stop writing `.eval(` rather than to weaken a CSP
 *      guard or buy an exclusion from it. The better API was already there.
 *
 * Defined lazily and once per client; the client is shared and long-lived.
 */
interface RedisWithRateLimit {
    rlSlidingWindow(
        key: string,
        now: string,
        windowMs: string,
        maxAttempts: string,
        lockoutMs: string,
        member: string,
    ): Promise<[number, number, number]>;
}

const defined = new WeakSet<object>();

function clientWithCommand(): (Redis & RedisWithRateLimit) | null {
    const client = getRedis();
    if (!client) return null;
    if (!defined.has(client)) {
        client.defineCommand('rlSlidingWindow', { numberOfKeys: 1, lua: SCRIPT });
        defined.add(client);
    }
    return client as Redis & RedisWithRateLimit;
}

/** Resolve a promise to `null` if it has not settled within the budget. */
async function withBudget<T>(p: Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            p,
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), BUDGET_MS);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
    // NO `void p.catch(...)` here, deliberately.
    //
    // An earlier version had one, with a comment saying it stopped a slow Redis
    // surfacing as an unhandled rejection. Mutation testing removed it and
    // NOTHING went red, so I measured instead of reasoning:
    //
    //   race a 50ms rejection against a 10ms resolve, attach no catch
    //   -> unhandledRejection fired: false
    //
    // `Promise.race` SUBSCRIBES to every promise it is given, so the losing
    // promise's rejection is already handled and the extra catch protected
    // nothing. It is gone rather than kept, because a line retained with a
    // comment calling it load-bearing is how an inert control survives review.
}

/**
 * Consume one unit against `key`.
 *
 * `null` means "Redis could not answer in time" — the CALLER decides what to do
 * with that, and every caller here degrades to the in-process Map rather than
 * failing open, because a limiter that still counts locally beats no limiter.
 */
export async function checkRateLimitRedis(
    key: string,
    config: RateLimitConfig,
): Promise<RateLimitResult | null> {
    const redis = clientWithCommand();
    if (!redis) return null;

    try {
        const raw = await withBudget(
            redis.rlSlidingWindow(
                `${KEY_PREFIX}:${key}`,
                String(Date.now()),
                String(config.windowMs),
                String(config.maxAttempts),
                String(config.lockoutMs ?? 0),
                `${Date.now()}-${randomUUID()}`,
            ),
        );
        if (raw === null) {
            logger.warn('rate-limit.redis_budget_exceeded', {
                component: 'rate-limit',
                budgetMs: BUDGET_MS,
            });
            return null;
        }
        const [allowed, remaining, retryAfterMs] = raw;
        return {
            allowed: allowed === 1,
            remaining: Math.max(0, Number(remaining)),
            retryAfterMs: Math.max(0, Number(retryAfterMs)),
        };
    } catch (err) {
        logger.warn('rate-limit.redis_error', {
            component: 'rate-limit',
            err: err instanceof Error ? err : new Error(String(err)),
        });
        return null;
    }
}

/** Clear a counter. Best-effort: the window ages out within `windowMs` anyway. */
export async function resetRateLimitRedis(key: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
        await withBudget(redis.del(`${KEY_PREFIX}:${key}`));
    } catch (err) {
        logger.warn('rate-limit.redis_reset_failed', {
            component: 'rate-limit',
            err: err instanceof Error ? err : new Error(String(err)),
        });
    }
}
