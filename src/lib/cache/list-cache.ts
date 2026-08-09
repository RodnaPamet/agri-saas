/**
 * List-read cache (Redis-backed).
 *
 * Wraps the hottest list usecases — practices, risks, evidence, tasks,
 * plus the slow-changing agronomy catalogs (crop types, crop
 * varieties, units) and per-planting weather-derived reads — so
 * cache hits skip the DB round-trip entirely. Mutation paths bump
 * a per-tenant version counter to invalidate every cached entry of
 * the same entity in O(1).
 *
 * Architectural choices and why:
 *
 *   • **Per-(tenant, entity) version counter.** Cache keys embed the
 *     current version of `entity:tenant`. A write calls
 *     `bumpEntityCacheVersion()` which INCRs the counter; old
 *     entries become unreachable immediately and time out via
 *     TTL. Avoids a SCAN+DEL pattern (slow on big keyspaces) and
 *     avoids per-filter-shape invalidation tracking (impossible to
 *     enumerate from a write path). One Redis op per write, no
 *     coordination.
 *
 *   • **Tenant in the key, always.** Tenant isolation is enforced
 *     at the DB layer by RLS, but caching bypasses RLS by
 *     construction. The cache key includes `ctx.tenantId` so a
 *     request from tenant A can never read tenant B's cache entry.
 *     The structural test in `tests/unit/list-cache.test.ts`
 *     asserts this invariant directly.
 *
 *   • **TTL is a safety net, not the primary correctness mechanism.**
 *     Default TTL is 60s. Combined with explicit version bumps on
 *     every write, the worst-case staleness is bounded:
 *       - With invalidation working: instant fresh-read after a
 *         mutation
 *       - With invalidation broken (e.g. a write usecase forgot to
 *         call `bumpEntityCacheVersion`): bounded to TTL
 *
 *   • **Fail-open on Redis errors.** A Redis hiccup must not break
 *     the API. Get/set failures fall through to the loader.
 *     Mirrors the fail-open posture in `authRateLimit.ts` and
 *     `apiReadRateLimit.ts`.
 *
 *   • **No-Redis dev/test ergonomics.** When `getRedis()` returns
 *     null (no `REDIS_URL` configured — dev or test without the
 *     local redis container), the helper bypasses the cache
 *     entirely and calls the loader directly. The wrapped usecases
 *     behave exactly as if no cache existed.
 *
 *   • **Stable filter hashing.** The cache key includes a SHA-256
 *     hash of a key-sorted JSON view of the filter object. Same
 *     filters (regardless of property order) → same hash → same
 *     cache entry. Different filters → different hash → different
 *     entry.
 */
import { createHash } from 'node:crypto';
import type { RequestContext } from '@/app-layer/types';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';

const CACHE_PREFIX = 'inflect:cache:v1';
const DEFAULT_TTL_SECONDS = 60;
// 30 days — version counter shouldn't be evicted under normal load
// and an evicted counter just means the next read pays a cache miss.
const VERSION_KEY_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Entities that opt into list-result caching. Tightly enumerated
 * because each entry implies a write-side responsibility (call
 * `bumpEntityCacheVersion` on every write) — adding a new entity
 * here without wiring the writes is a correctness bug.
 */
export type CacheableEntity =
    | 'practice'
    | 'risk'
    | 'evidence'
    | 'task'
    | 'crop-type'
    | 'crop-variety'
    | 'unit'
    | 'weather-observation';

export interface CachedReadOptions<T> {
    ctx: RequestContext;
    /** Domain entity. Used for invalidation. */
    entity: CacheableEntity;
    /** Distinguishes multiple read shapes per entity (e.g. 'list', 'listPaginated'). */
    operation: string;
    /**
     * Filters / params that distinguish results. Hashed to form
     * part of the key — different filters get different cache
     * entries. Pass a stable, JSON-serialisable shape; functions
     * and Date instances are fine but the hash treats them by
     * `JSON.stringify` semantics so prefer plain primitives where
     * possible.
     */
    params: unknown;
    /** TTL in seconds. Default 60. */
    ttlSeconds?: number;
    /** The underlying DB query. Only called on cache miss. */
    loader: () => Promise<T>;
}

export async function cachedListRead<T>(opts: CachedReadOptions<T>): Promise<T> {
    const redis = getRedis();
    if (!redis) {
        // No Redis configured — bypass cache, call loader directly.
        // This is the dev/test ergonomics path; behaviour is
        // observationally identical to the cache-disabled state.
        return opts.loader();
    }

    const tenantId = opts.ctx.tenantId;
    const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;

    // Per-(entity, tenant) version counter. INCR'd by writes via
    // `bumpEntityCacheVersion`; embedded in the cache key so a
    // bump leaves all prior entries unreachable.
    const versionKey = `${CACHE_PREFIX}:ver:${opts.entity}:${tenantId}`;

    let version = '0';
    try {
        const stored = await redis.get(versionKey);
        if (stored !== null) version = stored;
    } catch (err) {
        // Redis hiccup. Fall through to loader; we'll re-cache on
        // the next call.
        logger.warn('list-cache version-read failed', {
            component: 'list-cache',
            entity: opts.entity,
            error: err instanceof Error ? err.message : String(err),
        });
        return opts.loader();
    }

    // Stable filter hash. Same logical params (regardless of
    // property order) produce the same hash.
    const filterHash = createHash('sha256')
        .update(stableStringify(opts.params))
        .digest('hex')
        .slice(0, 16);

    const cacheKey =
        `${CACHE_PREFIX}:${opts.entity}:${opts.operation}:${tenantId}:v${version}:${filterHash}`;

    // ── HIT path ──
    const start = Date.now();
    let raw: string | null = null;
    try {
        raw = await redis.get(cacheKey);
    } catch (err) {
        // Treat as miss; log + load.
        logger.warn('list-cache get failed', {
            component: 'list-cache',
            entity: opts.entity,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    if (raw !== null) {
        try {
            const parsed = JSON.parse(raw) as T;
            logger.debug('list-cache hit', {
                component: 'list-cache',
                entity: opts.entity,
                operation: opts.operation,
                latencyMs: Date.now() - start,
                tenantId,
            });
            return parsed;
        } catch {
            // Corrupted JSON — fall through to loader. The bad
            // entry will be overwritten by the upcoming `set`.
            logger.warn('list-cache parse error — refreshing', {
                component: 'list-cache',
                entity: opts.entity,
                tenantId,
            });
        }
    }

    // ── MISS path ──
    const loadStart = Date.now();
    const result = await opts.loader();
    const loadMs = Date.now() - loadStart;

    try {
        await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl);
    } catch (err) {
        // Failed to cache. Not user-visible — the result is
        // already on its way back to the caller.
        logger.warn('list-cache set failed', {
            component: 'list-cache',
            entity: opts.entity,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    logger.debug('list-cache miss', {
        component: 'list-cache',
        entity: opts.entity,
        operation: opts.operation,
        loadMs,
        tenantId,
    });

    return result;
}

/**
 * Invalidate ALL cached list-reads for `(entity, tenant)` by
 * INCR'ing the version counter. Old entries become unreachable
 * immediately (next read computes a different cache key) and
 * time out via TTL.
 *
 * Call AFTER the DB write commits — never inside the transaction.
 * If the bump itself fails (transient Redis issue), the worst
 * case is bounded staleness equal to the cache TTL. The function
 * NEVER throws — write paths shouldn't fail because Redis is
 * sneezing.
 */
export async function bumpEntityCacheVersion(
    ctx: RequestContext,
    entity: CacheableEntity,
): Promise<void> {
    const redis = getRedis();
    if (!redis) return;

    const versionKey = `${CACHE_PREFIX}:ver:${entity}:${ctx.tenantId}`;
    try {
        await redis.incr(versionKey);
        // Refresh the version-key TTL so it doesn't drift to
        // expiry under heavy invalidation pressure (an evicted
        // counter is harmless — next read pays a cache miss — but
        // refreshing keeps the counter durable enough that a
        // sustained invalidation pattern doesn't degrade the
        // hit rate).
        await redis.expire(versionKey, VERSION_KEY_TTL_SECONDS);
    } catch (err) {
        logger.warn('list-cache version-bump failed', {
            component: 'list-cache',
            entity,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Stable JSON serialisation — sorts keys at every level so the
 * same logical object always produces the same string regardless
 * of property declaration order.
 *
 * Exported for tests + reuse; production callers should prefer
 * `cachedListRead`.
 */
export function stableStringify(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
        (k) => JSON.stringify(k) + ':' + stableStringify(obj[k]),
    );
    return '{' + parts.join(',') + '}';
}
