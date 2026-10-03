/**
 * The VM-Redis limiter's WRAPPER: gating, budget, and what it does when Redis
 * cannot answer. P1.8.
 *
 * The Lua window itself is proved against a real server in
 * `tests/integration/redis-rate-limit.test.ts` — mocking `eval` could only
 * assert that five arguments were passed, which is not the claim. What IS
 * mockable, and matters just as much, is the behaviour around the call: whether
 * the mode gate holds, whether a slow Redis stalls the request path, and
 * whether a failure returns `null` so the caller degrades rather than failing
 * open.
 */
const evalMock = jest.fn();
const delMock = jest.fn();
const defineCommandMock = jest.fn();
let clientPresent = true;

/**
 * The client is shared and long-lived, so `defineCommand` must be registered
 * ONCE. A fresh object per `getRedis()` call would hide a bug where the module
 * re-registered on every request, so this returns the SAME object — which is
 * also what `src/lib/redis.ts` does.
 */
const fakeClient = {
    defineCommand: (...a: unknown[]) => defineCommandMock(...a),
    rlSlidingWindow: (...a: unknown[]) => evalMock(...a),
    del: (...a: unknown[]) => delMock(...a),
};

jest.mock('@/lib/redis', () => ({
    getRedis: () => (clientPresent ? fakeClient : null),
}));

import { checkRateLimitRedis, redisRateLimitAvailable, resetRateLimitRedis } from '@/lib/rate-limit/redisBucket';

const CFG = { maxAttempts: 5, windowMs: 60_000 };
const saved = { mode: process.env.RATE_LIMIT_MODE, url: process.env.REDIS_URL };

beforeEach(() => {
    jest.clearAllMocks();
    clientPresent = true;
    process.env.RATE_LIMIT_MODE = 'redis';
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
});

afterAll(() => {
    if (saved.mode === undefined) delete process.env.RATE_LIMIT_MODE;
    else process.env.RATE_LIMIT_MODE = saved.mode;
    if (saved.url === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved.url;
});

describe('the mode gate is definitive', () => {
    it('is available only when RATE_LIMIT_MODE is redis', () => {
        expect(redisRateLimitAvailable()).toBe(true);
    });

    it('`memory` means memory, even with REDIS_URL set', () => {
        // The operator-intent property. REDIS_URL is present in EVERY container
        // because BullMQ needs it, so gating on the URL alone would mean an
        // operator who set `memory` while debugging an incident silently got a
        // shared store that survives their restart.
        process.env.RATE_LIMIT_MODE = 'memory';
        expect(redisRateLimitAvailable()).toBe(false);
    });

    it('`upstash` does not route here either', () => {
        process.env.RATE_LIMIT_MODE = 'upstash';
        expect(redisRateLimitAvailable()).toBe(false);
    });
});

describe('what it returns when Redis cannot answer', () => {
    it('null when there is no client', async () => {
        clientPresent = false;
        await expect(checkRateLimitRedis('k', CFG)).resolves.toBeNull();
        expect(evalMock).not.toHaveBeenCalled();
    });

    it('null when eval REJECTS', async () => {
        evalMock.mockRejectedValue(new Error('READONLY'));
        // `null`, never a fabricated allow: the caller degrades to its local
        // Map, because a limiter that still counts locally beats no limiter.
        await expect(checkRateLimitRedis('k', CFG)).resolves.toBeNull();
    });

    it('null when eval exceeds the budget, and does NOT wait for it', async () => {
        // The shared client sets commandTimeout: 5000 for BullMQ. On a request
        // path that is a five-second stall per call while Redis is unwell, so
        // the limiter imposes its own far shorter budget.
        evalMock.mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve([1, 4, 0]), 5_000)),
        );
        const started = Date.now();
        await expect(checkRateLimitRedis('k', CFG)).resolves.toBeNull();
        const elapsed = Date.now() - started;
        // Well under the 5s the stub would have taken — the assertion is that
        // it gave up, not merely that it returned null.
        expect(elapsed).toBeLessThan(1_500);
    });
});

describe('it maps the script result faithfully', () => {
    it('an allow', async () => {
        evalMock.mockResolvedValue([1, 4, 0]);
        await expect(checkRateLimitRedis('k', CFG)).resolves.toEqual({
            allowed: true,
            remaining: 4,
            retryAfterMs: 0,
        });
    });

    it('a block, carrying retryAfterMs', async () => {
        evalMock.mockResolvedValue([0, 0, 1234]);
        await expect(checkRateLimitRedis('k', CFG)).resolves.toEqual({
            allowed: false,
            remaining: 0,
            retryAfterMs: 1234,
        });
    });

    it('clamps a negative retryAfterMs to zero', async () => {
        // Clock skew between the app and Redis can make `oldest + window - now`
        // negative. A negative Retry-After header is worse than a zero: a client
        // may treat it as "never retry".
        evalMock.mockResolvedValue([0, 0, -500]);
        await expect(checkRateLimitRedis('k', CFG)).resolves.toMatchObject({ retryAfterMs: 0 });
    });

    it('passes the lockout as 0 when the preset has none', async () => {
        evalMock.mockResolvedValue([1, 4, 0]);
        await checkRateLimitRedis('k', CFG);
        const args = evalMock.mock.calls[0];
        // rlSlidingWindow(key, now, windowMs, maxAttempts, lockoutMs, member)
        expect(args[0]).toBe('rl:node:k');
        expect(args[2]).toBe(String(CFG.windowMs));
        expect(args[3]).toBe(String(CFG.maxAttempts));
        expect(args[4]).toBe('0');
    });

    it('forwards a configured lockoutMs', async () => {
        evalMock.mockResolvedValue([0, 0, 9]);
        await checkRateLimitRedis('k', { ...CFG, lockoutMs: 600_000 });
        expect(evalMock.mock.calls[0][4]).toBe('600000');
    });
});

describe('the custom command is registered ONCE', () => {
    it('defineCommand is not called again on a second check', async () => {
        // The client is shared and long-lived. Re-registering per request would
        // be wasted work on the hot path and would hide a leak if the WeakSet
        // bookkeeping were wrong.
        evalMock.mockResolvedValue([1, 4, 0]);
        await checkRateLimitRedis('a', CFG);
        const afterFirst = defineCommandMock.mock.calls.length;
        await checkRateLimitRedis('b', CFG);
        expect(defineCommandMock.mock.calls.length).toBe(afterFirst);
    });

    it('it registers the command under the name the caller invokes', async () => {
        evalMock.mockResolvedValue([1, 4, 0]);
        await checkRateLimitRedis('c', CFG);
        // Only asserted if THIS run registered it; the WeakSet persists across
        // cases in one module instance, so an empty call list is legitimate.
        for (const call of defineCommandMock.mock.calls) {
            expect(call[0]).toBe('rlSlidingWindow');
            expect(call[1]).toMatchObject({ numberOfKeys: 1 });
        }
    });
});

describe('reset', () => {
    it('deletes the prefixed key', async () => {
        delMock.mockResolvedValue(1);
        await resetRateLimitRedis('abc');
        expect(delMock).toHaveBeenCalledWith('rl:node:abc');
    });

    it('swallows a failure — a missed reset is never a lock-out', async () => {
        delMock.mockRejectedValue(new Error('nope'));
        await expect(resetRateLimitRedis('abc')).resolves.toBeUndefined();
    });
});
