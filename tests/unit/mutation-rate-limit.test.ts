/**
 * Unit test: distributed mutation-tier rate limiter (Roadmap-5 PR1).
 *
 * Covers the two backends and the load-bearing key composition:
 *   - Redis path (mocked Upstash): one round-trip, result mapping, block.
 *   - Fallback path: no Upstash env ⇒ in-process Map still enforces.
 *   - Redis error mid-request ⇒ fail-to-memory (not fail-open).
 *   - CGNAT key composition: the authenticated mutation key carries userId,
 *     so carrier-NAT users behind one IP don't cross-throttle.
 */

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// Practicelable Upstash client + Ratelimit.
const mockLimit = jest.fn();
const mockDel = jest.fn();
const mockGetRedis = jest.fn();

jest.mock('@upstash/ratelimit', () => ({
    Ratelimit: class {
        static slidingWindow() {
            return { kind: 'sliding-window' };
        }
        limit = mockLimit;
    },
}));

jest.mock('@/lib/rate-limit/upstashClient', () => ({
    getUpstashRedis: () => mockGetRedis(),
    __resetUpstashClientForTests: jest.fn(),
}));

import {
    checkRateLimitDistributed,
    resetRateLimitDistributed,
    __resetMutationLimitersForTests,
} from '@/lib/rate-limit/mutationRateLimit';
import { buildRateLimitKey } from '@/lib/security/rate-limit-middleware';
import {
    clearAllRateLimits,
    API_MUTATION_LIMIT,
    EXCHANGE_LISTING_CREATE_LIMIT,
    EXCHANGE_INQUIRY_LIMIT,
} from '@/lib/security/rate-limit';

beforeEach(() => {
    __resetMutationLimitersForTests();
    clearAllRateLimits();
    mockLimit.mockReset();
    mockDel.mockReset();
    mockGetRedis.mockReset();
});

describe('Redis (Upstash) path', () => {
    beforeEach(() => {
        mockGetRedis.mockReturnValue({ del: mockDel });
    });

    it('evaluates via the sliding window in exactly ONE round-trip', async () => {
        mockLimit.mockResolvedValue({
            success: true,
            limit: 60,
            remaining: 59,
            reset: Date.now() + 60_000,
        });

        const key = 'api-mutation:ip:1.1.1.1:u:alice';
        const r = await checkRateLimitDistributed(key, API_MUTATION_LIMIT);

        expect(mockLimit).toHaveBeenCalledTimes(1); // single op, no pipeline
        expect(mockLimit).toHaveBeenCalledWith(key);
        expect(r).toMatchObject({ allowed: true, remaining: 59 });
    });

    it('maps a blocked result to allowed:false + a positive retryAfterMs', async () => {
        const reset = Date.now() + 30_000;
        mockLimit.mockResolvedValue({ success: false, limit: 20, remaining: 0, reset });

        const r = await checkRateLimitDistributed('x', EXCHANGE_LISTING_CREATE_LIMIT);
        expect(r.allowed).toBe(false);
        expect(r.retryAfterMs).toBeGreaterThan(0);
        expect(r.retryAfterMs).toBeLessThanOrEqual(30_000);
    });

    it('covers the exchange presets (they route through the same limiter)', async () => {
        mockLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 });
        await checkRateLimitDistributed('inq:ip:2.2.2.2:u:bob', EXCHANGE_INQUIRY_LIMIT);
        expect(mockLimit).toHaveBeenCalledWith('inq:ip:2.2.2.2:u:bob');
    });

    it('a Redis error mid-request degrades to the in-process Map (fail-to-memory, not fail-open)', async () => {
        mockLimit.mockRejectedValue(new Error('upstash unreachable'));
        const key = 'degrade-key';
        const cfg = { maxAttempts: 1, windowMs: 60_000 };
        // First call: memory allows.
        expect((await checkRateLimitDistributed(key, cfg)).allowed).toBe(true);
        // Second call (still erroring): memory now blocks — limiter didn't vanish.
        expect((await checkRateLimitDistributed(key, cfg)).allowed).toBe(false);
    });

    it('reset issues a best-effort DEL on the prefixed key', async () => {
        await resetRateLimitDistributed('some:key');
        expect(mockDel).toHaveBeenCalledWith('rl:mut:some:key');
    });
});

describe('Fallback path (no Upstash env)', () => {
    beforeEach(() => {
        mockGetRedis.mockReturnValue(null); // zero-config self-host
    });

    it('enforces the budget via the in-process Map', async () => {
        const key = 'fallback:ip:3.3.3.3:u:carol';
        const cfg = { maxAttempts: 2, windowMs: 60_000 };
        expect((await checkRateLimitDistributed(key, cfg)).allowed).toBe(true);
        expect((await checkRateLimitDistributed(key, cfg)).allowed).toBe(true);
        expect((await checkRateLimitDistributed(key, cfg)).allowed).toBe(false);
        expect(mockLimit).not.toHaveBeenCalled(); // never touched Redis
    });
});

describe('CGNAT key composition', () => {
    it('the authenticated mutation key carries the userId', () => {
        const key = buildRateLimitKey('api-mutation', '203.0.113.7', 'user-42');
        expect(key).toContain('u:user-42');
    });

    it('two users behind ONE carrier IP get distinct keys (no cross-throttle)', () => {
        const ip = '100.64.0.1'; // RFC 6598 CGNAT space
        const a = buildRateLimitKey('api-mutation', ip, 'user-a');
        const b = buildRateLimitKey('api-mutation', ip, 'user-b');
        expect(a).not.toBe(b);
        expect(a).toContain('u:user-a');
        expect(b).toContain('u:user-b');
    });
});
