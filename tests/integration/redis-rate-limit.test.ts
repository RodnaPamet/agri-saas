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

    /**
     * Turn a `null` from the limiter into a diagnosis — #2714.
     *
     * `null` is the limiter's DEGRADED signal, not a verdict. `redisBucket`
     * is documented as fail-to-local on a Redis error and never fail-open, so
     * `null` means the Redis call did not succeed — and the limiter swallows
     * the underlying error in order to degrade, which is correct for
     * production and leaves a test with nothing to read.
     *
     * `expect(r).not.toBeNull()` therefore reports the same two words,
     * `Received: null`, for two opposite situations: a limiter defect, and an
     * environment where Redis went away mid-suite. That happened on MAIN at
     * `b0261b63f` (run 41374257522, shard 3/6) — it failed on the FIRST
     * iteration with `Redis connection closed` logged immediately after, the
     * next main commit passed, and the auto-filed issue self-closed with
     * "CI is green again", leaving no record of the cause. A second occurrence
     * would have been indistinguishable from a first.
     *
     * The suite's own `redisAvailable` probe cannot cover this: it runs ONCE
     * in `beforeAll`, and the failure is Redis becoming unreachable AFTER it.
     *
     * So on a `null` this re-probes through the suite's tracked client and
     * says which world we are in. It is the `uniform-failure-shape` fix this
     * repo has applied twice elsewhere, at the only place in this file that
     * reads a limiter result for non-nullness.
     */
    async function limiterAnswer(
        r: Awaited<ReturnType<typeof checkRateLimitRedis>>,
        where: string,
    ): Promise<NonNullable<typeof r>> {
        if (r !== null && r !== undefined) return r;

        let redisSays: string;
        try {
            redisSays = await probe.ping();
        } catch (e) {
            redisSays = `unreachable (${(e as Error).message})`;
        }
        const verdict =
            redisSays === 'PONG'
                ? 'Redis answers PONG right now, so this is a LIMITER defect — '
                  + 'the Lua or the key shape, not the environment.'
                : 'Redis does NOT answer, so this is the ENVIRONMENT: the service '
                  + 'went away after beforeAll probed it. See #2714 — do not read '
                  + 'this as a limit being wrong.';
        throw new Error(
            `${where}: the limiter returned null, which is its DEGRADED signal `
                + `rather than a verdict. Redis probe: ${redisSays}. ${verdict}`,
        );
    }

    const cfg = (over: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
        maxAttempts: 3,
        windowMs: 60_000,
        ...over,
    });

    function key(): string {
        return `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    /**
     * The control for the diagnosis above. Without it `limiterAnswer` could
     * print one sentence for both worlds and nobody would know — which is the
     * defect it exists to fix, one level up.
     */
    describe('a null SAYS WHICH WORLD it is in (#2714)', () => {
        it('blames the LIMITER when Redis answers', async () => {
            if (skipIfNoRedis()) return;
            // Redis is genuinely up here — the suite would not have got this
            // far otherwise — so a null can only be the limiter's own fault.
            await expect(limiterAnswer(null, 'synthetic')).rejects.toThrow(
                /LIMITER defect/,
            );
        });

        it('blames the ENVIRONMENT when Redis does not answer', async () => {
            if (skipIfNoRedis()) return;
            // The failure mode #2714 actually saw: Redis reachable at
            // `beforeAll` and gone by the time the limiter ran. Simulated by
            // making the probe itself fail, because the real thing needs the
            // service to die mid-suite.
            const realPing = probe.ping.bind(probe);
            (probe as unknown as { ping: () => Promise<string> }).ping = () =>
                Promise.reject(new Error('connection closed'));
            try {
                const err = await limiterAnswer(null, 'synthetic').catch((e) => e);
                expect(String(err)).toMatch(/ENVIRONMENT/);
                expect(String(err)).toMatch(/#2714/);
                // And it must NOT blame the limiter in this world, or the two
                // messages are interchangeable and the split is cosmetic.
                expect(String(err)).not.toMatch(/LIMITER defect/);
            } finally {
                (probe as unknown as { ping: () => Promise<string> }).ping = realPing;
            }
        });

        it('passes a real answer straight through', async () => {
            if (skipIfNoRedis()) return;
            // The negative control: a helper that threw unconditionally would
            // satisfy both assertions above and fail every other test here.
            const r = await checkRateLimitRedis(key(), cfg());
            await expect(limiterAnswer(r, 'synthetic')).resolves.toMatchObject({
                allowed: true,
            });
        });
    });

    it('allows up to maxAttempts and blocks the next', async () => {
        if (skipIfNoRedis()) return;
        const k = key();
        for (let i = 1; i <= 3; i++) {
            const r = await limiterAnswer(
                await checkRateLimitRedis(k, cfg()),
                `attempt ${i} of 3`,
            );
            expect(r.allowed).toBe(true);
            // Remaining counts DOWN, so an off-by-one shows here rather than
            // only at the boundary.
            expect(r.remaining).toBe(3 - i);
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
