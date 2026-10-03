/**
 * The VM-Redis rate-limit counter: real Redis, real Lua, real window. P1.8.
 *
 * ## Why this has to hit a real Redis
 *
 * The behaviour under test lives in a Lua script. Mocking `eval` would assert
 * that the wrapper passes five arguments, which is not the claim — the claim is
 * that the WINDOW counts correctly, that a blocked attempt does not extend it,
 * and that a counter OUTLIVES THE CLIENT. None of those is observable without
 * a server that runs the script.
 *
 * ## The assertion that is actually P1.8
 *
 * `a counter survives a brand-new client` is the whole point of the change.
 * Production ran `RATE_LIMIT_MODE=memory` in a single container, so every
 * budget lived in an in-process Map and every deploy reset it — and Watchtower
 * recreates that container on each image push. A fresh client reading an
 * existing counter is the closest a test gets to "the deploy did not wipe it".
 *
 * ## Gating
 *
 * Mirrors `tests/integration/bullmq-real-api.test.ts`: `REDIS_URL_TEST` first
 * (what CI sets), then `REDIS_URL`, then a localhost default; a short-timeout
 * probe so a missing local Redis cannot hang the suite; and an escalation flag
 * so a skip in CI — which declares a `redis:7-alpine` service — is a BUG rather
 * than an environment fact.
 */
import IORedis from 'ioredis';
import type { RateLimitConfig } from '@/lib/security/rate-limit';

const REDIS_URL =
    process.env.REDIS_URL_TEST || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REQUIRE_REDIS = process.env.REDIS_RATE_LIMIT_REQUIRE_REDIS === '1';

async function probeRedis(): Promise<boolean> {
    const client = new IORedis(REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        lazyConnect: true,
        retryStrategy: () => null,
    });
    try {
        await client.connect();
        await client.ping();
        return true;
    } catch {
        return false;
    } finally {
        client.disconnect();
    }
}

/**
 * Probed in `beforeAll`, not at module scope: top-level await is not available
 * in this jest transform (CJS), and the repo's existing redis suite
 * (`bullmq-real-api.test.ts`) settles the convention.
 *
 * The cost of a runtime gate is that an unavailable Redis makes each case
 * RETURN EARLY, and an early return PASSES — absence reading as success, which
 * is this repo's recurring defect. `REDIS_RATE_LIMIT_REQUIRE_REDIS=1` is the
 * escalation: in CI, which declares a `redis:7-alpine` service, a skip is a BUG
 * and this turns it red.
 */
let redisAvailable = false;

/** Clients to QUIT, not merely disconnect. */
const openConnections: IORedis[] = [];
function track(c: IORedis): IORedis {
    openConnections.push(c);
    return c;
}

describe('VM-Redis rate-limit counter', () => {
    // Imported lazily so the module's env gate sees RATE_LIMIT_MODE below.
    let checkRateLimitRedis: typeof import('@/lib/rate-limit/redisBucket').checkRateLimitRedis;
    let resetRateLimitRedis: typeof import('@/lib/rate-limit/redisBucket').resetRateLimitRedis;
    let probe: IORedis;
    const savedMode = process.env.RATE_LIMIT_MODE;
    const savedUrl = process.env.REDIS_URL;

    beforeAll(async () => {
        redisAvailable = await probeRedis();
        if (!redisAvailable) {
            if (REQUIRE_REDIS) {
                throw new Error(
                    `REDIS_RATE_LIMIT_REQUIRE_REDIS=1 but Redis at ${REDIS_URL} is ` +
                        `unreachable. CI declares a redis service, so a skip here ` +
                        `means it was declared for nothing and the Lua is unproven.`,
                );
            }
            return;
        }
        process.env.RATE_LIMIT_MODE = 'redis';
        process.env.REDIS_URL = REDIS_URL;
        const mod = await import('@/lib/rate-limit/redisBucket');
        checkRateLimitRedis = mod.checkRateLimitRedis;
        resetRateLimitRedis = mod.resetRateLimitRedis;
        probe = track(new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 }));
    });

    afterAll(async () => {
        if (savedMode === undefined) delete process.env.RATE_LIMIT_MODE;
        else process.env.RATE_LIMIT_MODE = savedMode;
        if (savedUrl === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = savedUrl;
        // QUIT, not disconnect: an externally-supplied ioredis client left open
        // produces "A worker process has failed to exit gracefully", which this
        // repo has been bitten by — a leaked handle killed a jest worker while
        // the tests themselves passed.
        await Promise.all(
            openConnections.map((c) => c.quit().catch(() => c.disconnect())),
        );
        openConnections.length = 0;
    });

    /** Every case needs this: an unavailable Redis must not assert on undefined. */
    const skipIfNoRedis = (): boolean => !redisAvailable;

    const cfg = (over: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
        maxAttempts: 3,
        windowMs: 60_000,
        ...over,
    });

    function key(): string {
        return `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    it('allows up to maxAttempts and blocks the next', async () => {
        if (skipIfNoRedis()) return;
        const k = key();
        for (let i = 1; i <= 3; i++) {
            const r = await checkRateLimitRedis(k, cfg());
            expect(r).not.toBeNull();
            expect(r!.allowed).toBe(true);
            // Remaining counts DOWN, so an off-by-one shows here rather than
            // only at the boundary.
            expect(r!.remaining).toBe(3 - i);
        }
        const blocked = await checkRateLimitRedis(k, cfg());
        expect(blocked!.allowed).toBe(false);
        expect(blocked!.remaining).toBe(0);
        expect(blocked!.retryAfterMs).toBeGreaterThan(0);
    });

    it('a BLOCKED attempt does not extend the window', async () => {
        if (skipIfNoRedis()) return;
        // Parity with the in-process fallback, which filters and returns
        // WITHOUT pushing. A ZADD-always implementation would let a caller
        // hammering a closed door push their own reset further away, so the two
        // stores would disagree whenever Redis blipped.
        const k = key();
        const c = cfg({ maxAttempts: 1 });
        await checkRateLimitRedis(k, c);
        const first = await checkRateLimitRedis(k, c);
        const zcardAfterFirstBlock = await probe.zcard(`rl:node:${k}`);
        await checkRateLimitRedis(k, c);
        await checkRateLimitRedis(k, c);
        const zcardAfterMore = await probe.zcard(`rl:node:${k}`);

        expect(first!.allowed).toBe(false);
        // The set has exactly the ONE allowed attempt, however many were refused.
        expect(zcardAfterFirstBlock).toBe(1);
        expect(zcardAfterMore).toBe(1);
    });

    it('a counter SURVIVES a brand-new client — the point of P1.8', async () => {
        if (skipIfNoRedis()) return;
        const k = key();
        const c = cfg({ maxAttempts: 2 });
        await checkRateLimitRedis(k, c);
        await checkRateLimitRedis(k, c);

        // A fresh client is the closest a test gets to a recreated container.
        // With the in-process Map this budget would be back to full.
        const fresh = track(new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 }));
        try {
            expect(await fresh.zcard(`rl:node:${k}`)).toBe(2);
        } finally {
            fresh.disconnect();
        }
        const after = await checkRateLimitRedis(k, c);
        expect(after!.allowed).toBe(false);
    });

    it('lockoutMs measures from the LAST attempt, not the oldest', async () => {
        if (skipIfNoRedis()) return;
        // The other parity detail. With a 60s window and a 10-minute lockout,
        // a window-based retryAfter would be <= 60s; the lockout must dominate.
        const k = key();
        const c = cfg({ maxAttempts: 1, windowMs: 60_000, lockoutMs: 600_000 });
        await checkRateLimitRedis(k, c);
        const blocked = await checkRateLimitRedis(k, c);
        expect(blocked!.allowed).toBe(false);
        expect(blocked!.retryAfterMs).toBeGreaterThan(60_000);
        expect(blocked!.retryAfterMs).toBeLessThanOrEqual(600_000);
    });

    it('the key EXPIRES, so a counter cannot leak forever', async () => {
        if (skipIfNoRedis()) return;
        const k = key();
        await checkRateLimitRedis(k, cfg({ windowMs: 5_000 }));
        const ttl = await probe.pttl(`rl:node:${k}`);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(5_000);
    });

    it('reset clears the counter', async () => {
        if (skipIfNoRedis()) return;
        const k = key();
        const c = cfg({ maxAttempts: 1 });
        await checkRateLimitRedis(k, c);
        expect((await checkRateLimitRedis(k, c))!.allowed).toBe(false);
        await resetRateLimitRedis(k);
        expect((await checkRateLimitRedis(k, c))!.allowed).toBe(true);
    });

    it('two different keys do not share a budget', async () => {
        if (skipIfNoRedis()) return;
        // The control: a script that ignored KEYS[1] would pass every case
        // above while throttling the whole deployment as one caller.
        const a = key();
        const b = key();
        const c = cfg({ maxAttempts: 1 });
        await checkRateLimitRedis(a, c);
        expect((await checkRateLimitRedis(a, c))!.allowed).toBe(false);
        expect((await checkRateLimitRedis(b, c))!.allowed).toBe(true);
    });
});
