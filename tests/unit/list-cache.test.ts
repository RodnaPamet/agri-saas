/**
 * Tests for the Redis-backed list-read cache.
 *
 * Mocks ioredis with ioredis-mock so we exercise the real command
 * logic (GET / SET / EX / INCR / EXPIRE) in-process without
 * needing a Redis container.
 *
 * Coverage:
 *   • Cache hit returns the same data as the loader on first call.
 *   • Cache miss runs the loader exactly once, then subsequent
 *     calls hit the cache.
 *   • Different tenants get different cache entries (isolation).
 *   • Different filters get different cache entries.
 *   • Same logical filter, different property order → same entry
 *     (stable hashing).
 *   • `bumpEntityCacheVersion` invalidates — next read misses.
 *   • TTL is respected (entries expire).
 *   • No-Redis fallback: when REDIS_URL is unset, calls the loader
 *     every time and never caches.
 *   • Loader errors propagate without poisoning the cache.
 *   • Tenant isolation: tenant A's cache is never readable by
 *     tenant B even when filters and ops match.
 */

// Force ioredis-mock for the entire test file. Must be before any
// import that transitively loads ioredis (i.e. before getRedis).
jest.mock('ioredis', () => require('ioredis-mock'));

// Provide REDIS_URL so getRedis() doesn't return null in the
// "with cache" tests. Individual no-Redis tests will reset env.
process.env.REDIS_URL = 'redis://localhost:6379';

import {
    cachedListRead,
    bumpEntityCacheVersion,
    stableStringify,
} from '@/lib/cache/list-cache';
import { getRedis, disconnectRedis } from '@/lib/redis';
import type { RequestContext } from '@/app-layer/types';

function fakeCtx(tenantId: string, userId = 'u-test'): RequestContext {
    return {
        tenantId,
        userId,
        role: 'EDITOR',
        permissions: {},
        appPermissions: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

beforeEach(async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    // ioredis-mock shares an in-memory store across client instances.
    // FLUSHALL ensures each test starts with a clean cache; without
    // this, version counters + cache entries leak between tests.
    const redis = getRedis();
    if (redis) {
        await redis.flushall();
    }
});

afterEach(async () => {
    await disconnectRedis();
});

describe('cachedListRead — basic hit/miss', () => {
    it('runs the loader exactly once on miss; second call serves from cache', async () => {
        const ctx = fakeCtx('t-1');
        const loader = jest.fn(async () => [{ id: 'r1', name: 'Risk 1' }]);

        const first = await cachedListRead({
            ctx,
            entity: 'risk',
            operation: 'list',
            params: { status: 'OPEN' },
            loader,
        });
        const second = await cachedListRead({
            ctx,
            entity: 'risk',
            operation: 'list',
            params: { status: 'OPEN' },
            loader,
        });

        expect(first).toEqual(second);
        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('different operations on the same entity are independent cache entries', async () => {
        const ctx = fakeCtx('t-1');
        const loaderList = jest.fn(async () => ['list']);
        const loaderPaginated = jest.fn(async () => ({ items: ['paginated'], pageInfo: {} }));

        await cachedListRead({ ctx, entity: 'risk', operation: 'list', params: {}, loader: loaderList });
        await cachedListRead({ ctx, entity: 'risk', operation: 'listPaginated', params: {}, loader: loaderPaginated });

        // Both loaders fire — different ops are different keys.
        expect(loaderList).toHaveBeenCalledTimes(1);
        expect(loaderPaginated).toHaveBeenCalledTimes(1);
    });
});

describe('cachedListRead — filter sensitivity', () => {
    it('different filter values produce different cache entries', async () => {
        const ctx = fakeCtx('t-1');
        const loader = jest.fn(async (status: string) => [{ status }]);

        await cachedListRead({
            ctx,
            entity: 'risk',
            operation: 'list',
            params: { status: 'OPEN' },
            loader: () => loader('OPEN'),
        });
        await cachedListRead({
            ctx,
            entity: 'risk',
            operation: 'list',
            params: { status: 'CLOSED' },
            loader: () => loader('CLOSED'),
        });

        expect(loader).toHaveBeenCalledTimes(2);
        expect(loader).toHaveBeenNthCalledWith(1, 'OPEN');
        expect(loader).toHaveBeenNthCalledWith(2, 'CLOSED');
    });

    it('same logical filter regardless of property order hits the same entry', async () => {
        const ctx = fakeCtx('t-1');
        const loader = jest.fn(async () => [1]);

        // Property order varies but logical content is identical.
        await cachedListRead({
            ctx,
            entity: 'risk',
            operation: 'list',
            params: { status: 'OPEN', q: 'foo', limit: 50 },
            loader,
        });
        await cachedListRead({
            ctx,
            entity: 'risk',
            operation: 'list',
            params: { limit: 50, status: 'OPEN', q: 'foo' },
            loader,
        });
        await cachedListRead({
            ctx,
            entity: 'risk',
            operation: 'list',
            params: { q: 'foo', limit: 50, status: 'OPEN' },
            loader,
        });

        expect(loader).toHaveBeenCalledTimes(1);
    });
});

describe('cachedListRead — tenant isolation', () => {
    it('two tenants with identical params get independent cache entries', async () => {
        const ctxA = fakeCtx('t-A');
        const ctxB = fakeCtx('t-B');
        const loaderA = jest.fn(async () => [{ tenantId: 't-A' }]);
        const loaderB = jest.fn(async () => [{ tenantId: 't-B' }]);

        const a = await cachedListRead({ ctx: ctxA, entity: 'risk', operation: 'list', params: {}, loader: loaderA });
        const b = await cachedListRead({ ctx: ctxB, entity: 'risk', operation: 'list', params: {}, loader: loaderB });

        // Both loaders fired (tenant A's cache entry can't be read by tenant B).
        expect(loaderA).toHaveBeenCalledTimes(1);
        expect(loaderB).toHaveBeenCalledTimes(1);
        expect(a).toEqual([{ tenantId: 't-A' }]);
        expect(b).toEqual([{ tenantId: 't-B' }]);
    });

    it('a write to tenant A does not invalidate tenant B', async () => {
        const ctxA = fakeCtx('t-A');
        const ctxB = fakeCtx('t-B');
        const loaderB = jest.fn(async () => ['B-data']);

        // Prime tenant B's cache.
        await cachedListRead({ ctx: ctxB, entity: 'risk', operation: 'list', params: {}, loader: loaderB });
        expect(loaderB).toHaveBeenCalledTimes(1);

        // Tenant A invalidates its OWN cache.
        await bumpEntityCacheVersion(ctxA, 'risk');

        // Tenant B's read still hits cache (loader not called again).
        await cachedListRead({ ctx: ctxB, entity: 'risk', operation: 'list', params: {}, loader: loaderB });
        expect(loaderB).toHaveBeenCalledTimes(1);
    });
});

describe('cachedListRead — invalidation via bumpEntityCacheVersion', () => {
    it('a version bump forces the next read to miss', async () => {
        const ctx = fakeCtx('t-1');
        let counter = 0;
        const loader = jest.fn(async () => {
            counter++;
            return { value: counter };
        });

        const first = await cachedListRead({ ctx, entity: 'risk', operation: 'list', params: {}, loader });
        const second = await cachedListRead({ ctx, entity: 'risk', operation: 'list', params: {}, loader });
        await bumpEntityCacheVersion(ctx, 'risk');
        const third = await cachedListRead({ ctx, entity: 'risk', operation: 'list', params: {}, loader });

        expect(first).toEqual({ value: 1 });
        expect(second).toEqual({ value: 1 }); // cache hit
        expect(third).toEqual({ value: 2 });  // miss after bump
        expect(loader).toHaveBeenCalledTimes(2);
    });

    it('bumping one entity does NOT invalidate another', async () => {
        const ctx = fakeCtx('t-1');
        const loaderRisk = jest.fn(async () => ['risk-data']);
        const loaderPractice = jest.fn(async () => ['practice-data']);

        // Prime both.
        await cachedListRead({ ctx, entity: 'risk', operation: 'list', params: {}, loader: loaderRisk });
        await cachedListRead({ ctx, entity: 'practice', operation: 'list', params: {}, loader: loaderPractice });

        await bumpEntityCacheVersion(ctx, 'risk');

        // Risk re-loads (bumped); practice still cached.
        await cachedListRead({ ctx, entity: 'risk', operation: 'list', params: {}, loader: loaderRisk });
        await cachedListRead({ ctx, entity: 'practice', operation: 'list', params: {}, loader: loaderPractice });

        expect(loaderRisk).toHaveBeenCalledTimes(2);
        expect(loaderPractice).toHaveBeenCalledTimes(1);
    });
});

describe('cachedListRead — TTL', () => {
    it('expired entries miss; loader runs again', async () => {
        const ctx = fakeCtx('t-1');
        const loader = jest.fn(async () => ['data']);

        await cachedListRead({
            ctx,
            entity: 'risk',
            operation: 'list',
            params: {},
            ttlSeconds: 1,
            loader,
        });

        // Wait for TTL to expire (a hair over 1s).
        await new Promise((r) => setTimeout(r, 1100));

        await cachedListRead({
            ctx,
            entity: 'risk',
            operation: 'list',
            params: {},
            ttlSeconds: 1,
            loader,
        });

        expect(loader).toHaveBeenCalledTimes(2);
    });
});

describe('cachedListRead — no-Redis fallback', () => {
    it('passes through to the loader when REDIS_URL is not configured', async () => {
        await disconnectRedis();
        delete process.env.REDIS_URL;

        const ctx = fakeCtx('t-1');
        const loader = jest.fn(async () => ['fresh']);

        // Two calls — both should call the loader (no caching).
        await cachedListRead({ ctx, entity: 'risk', operation: 'list', params: {}, loader });
        await cachedListRead({ ctx, entity: 'risk', operation: 'list', params: {}, loader });

        expect(loader).toHaveBeenCalledTimes(2);
    });
});

describe('cachedListRead — error propagation', () => {
    it('loader errors propagate (no cached value to serve)', async () => {
        const ctx = fakeCtx('t-1');
        const error = new Error('DB exploded');
        const loader = jest.fn(async () => {
            throw error;
        });

        await expect(
            cachedListRead({ ctx, entity: 'risk', operation: 'list', params: {}, loader }),
        ).rejects.toThrow('DB exploded');
    });

    it('a failed loader does not poison the cache — next call re-runs the loader', async () => {
        const ctx = fakeCtx('t-1');
        let attempt = 0;
        const loader = jest.fn(async () => {
            attempt++;
            if (attempt === 1) throw new Error('transient');
            return ['recovered'];
        });

        await expect(
            cachedListRead({ ctx, entity: 'risk', operation: 'list', params: {}, loader }),
        ).rejects.toThrow('transient');

        const second = await cachedListRead({
            ctx,
            entity: 'risk',
            operation: 'list',
            params: {},
            loader,
        });

        expect(second).toEqual(['recovered']);
        expect(loader).toHaveBeenCalledTimes(2);
    });
});

describe('cachedListRead — agronomy catalog + weather entities (feat/perf-scale)', () => {
    // The four entities added for the agri-saas perf work. Each must be a
    // valid CacheableEntity (compile-time) AND behave like the existing
    // entities at runtime: hit/miss + per-tenant isolation.
    const NEW_ENTITIES = ['crop-type', 'crop-variety', 'unit', 'weather-observation'] as const;

    it.each(NEW_ENTITIES)(
        '%s — runs the loader once on miss, serves the second call from cache',
        async (entity) => {
            const ctx = fakeCtx('t-1');
            const loader = jest.fn(async () => [{ id: `${entity}-1` }]);

            const first = await cachedListRead({ ctx, entity, operation: 'list', params: { measure: null }, loader });
            const second = await cachedListRead({ ctx, entity, operation: 'list', params: { measure: null }, loader });

            expect(first).toEqual(second);
            expect(loader).toHaveBeenCalledTimes(1);
        },
    );

    it.each(NEW_ENTITIES)(
        '%s — two tenants with identical params get independent cache entries (tenant isolation)',
        async (entity) => {
            const ctxA = fakeCtx('t-A');
            const ctxB = fakeCtx('t-B');
            const loaderA = jest.fn(async () => [{ tenantId: 't-A' }]);
            const loaderB = jest.fn(async () => [{ tenantId: 't-B' }]);

            const a = await cachedListRead({ ctx: ctxA, entity, operation: 'list', params: {}, loader: loaderA });
            const b = await cachedListRead({ ctx: ctxB, entity, operation: 'list', params: {}, loader: loaderB });

            // Both loaders fired — tenant A's cache entry can't be read by tenant B.
            expect(loaderA).toHaveBeenCalledTimes(1);
            expect(loaderB).toHaveBeenCalledTimes(1);
            expect(a).toEqual([{ tenantId: 't-A' }]);
            expect(b).toEqual([{ tenantId: 't-B' }]);
        },
    );

    it("crop-type — a version bump (mirrors createCropType) forces the next read to miss", async () => {
        const ctx = fakeCtx('t-1');
        let counter = 0;
        const loader = jest.fn(async () => {
            counter++;
            return { value: counter };
        });

        const first = await cachedListRead({ ctx, entity: 'crop-type', operation: 'list', params: {}, loader });
        const cached = await cachedListRead({ ctx, entity: 'crop-type', operation: 'list', params: {}, loader });
        await bumpEntityCacheVersion(ctx, 'crop-type');
        const afterBump = await cachedListRead({ ctx, entity: 'crop-type', operation: 'list', params: {}, loader });

        expect(first).toEqual({ value: 1 });
        expect(cached).toEqual({ value: 1 }); // hit
        expect(afterBump).toEqual({ value: 2 }); // miss after bump
        expect(loader).toHaveBeenCalledTimes(2);
    });

    it('weather-observation — the gdd operation keys independently from a list op on the same entity', async () => {
        const ctx = fakeCtx('t-1');
        const loaderGdd = jest.fn(async () => ({ totalGdd: 42, days: [] }));
        const loaderList = jest.fn(async () => ['obs']);

        await cachedListRead({ ctx, entity: 'weather-observation', operation: 'gdd', params: { plantingId: 'p1' }, loader: loaderGdd });
        await cachedListRead({ ctx, entity: 'weather-observation', operation: 'list', params: { plantingId: 'p1' }, loader: loaderList });

        // Different ops on the same entity are different keys — both fire.
        expect(loaderGdd).toHaveBeenCalledTimes(1);
        expect(loaderList).toHaveBeenCalledTimes(1);
    });
});

describe('stableStringify — primitive', () => {
    it('produces the same output regardless of property order', () => {
        const a = stableStringify({ z: 1, a: 2, m: { y: 3, x: 4 } });
        const b = stableStringify({ a: 2, m: { x: 4, y: 3 }, z: 1 });
        expect(a).toBe(b);
    });

    it('handles arrays, primitives, and undefined', () => {
        expect(stableStringify(undefined)).toBe('undefined');
        expect(stableStringify(null)).toBe('null');
        expect(stableStringify(42)).toBe('42');
        expect(stableStringify('foo')).toBe('"foo"');
        expect(stableStringify([1, 2, 3])).toBe('[1,2,3]');
        expect(stableStringify({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
    });
});
