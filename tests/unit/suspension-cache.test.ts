/**
 * P5.9 — the suspension cache, and the two fail directions (#1600).
 *
 * ## Why this file exists, measured rather than assumed
 *
 * `tests/integration/p5-9-suspension-takes-effect.test.ts` has a case named
 * "a cached NOT-suspended verdict cannot outlive the suspension". It proves
 * nothing: there is no `REDIS_URL` in `.env.test`, so `getRedis()` returns null
 * and the entire cache path — including the invalidation — is dead code under
 * that suite. I found this by mutation-proof, not by reading: deleting the
 * `afterCommit('suspension.invalidate-cache', …)` call reddened **zero** tests.
 *
 * So the cache is tested here, where `getRedis` is mocked and its availability
 * is an input rather than an accident of the environment.
 *
 * ## The two fail directions are opposite, deliberately
 *
 *   - **Redis unreadable → fall THROUGH to Postgres.** Redis is not the
 *     authority, it is an optimisation over one. A cache outage must not sign
 *     anyone out.
 *   - **Postgres unreadable → fail CLOSED.** And that costs nothing new: a
 *     request that cannot read `User.suspendedAt` cannot do the work it came
 *     for either, so the request was going to fail regardless. That asymmetry
 *     is why `src/middleware.ts` can fail open on an unknown session answer
 *     while this fails closed on an unknown suspension answer.
 */
const redisGet = jest.fn();
const redisSet = jest.fn();
const redisDel = jest.fn();
let redisAvailable = true;

jest.mock('@/lib/redis', () => ({
    getRedis: () =>
        redisAvailable
            ? { get: redisGet, set: redisSet, del: redisDel }
            : null,
}));

const findUnique = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
    isAccountSuspended,
    invalidateSuspensionCache,
    SUSPENSION_CACHE_TTL,
} from '@/lib/auth/suspension';

beforeEach(() => {
    redisAvailable = true;
    redisGet.mockReset();
    redisSet.mockReset();
    redisDel.mockReset();
    findUnique.mockReset();
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    redisDel.mockResolvedValue(1);
    findUnique.mockResolvedValue({ suspendedAt: null });
});

describe('the cache answers without touching the database', () => {
    it("returns false on a cached '0' and does NOT query Postgres", async () => {
        redisGet.mockResolvedValue('0');

        expect(await isAccountSuspended('u1')).toBe(false);
        // The whole point of the cache: the common answer costs no query.
        expect(findUnique).not.toHaveBeenCalled();
    });

    it("returns true on a cached '1' and does NOT query Postgres", async () => {
        redisGet.mockResolvedValue('1');

        expect(await isAccountSuspended('u1')).toBe(true);
        expect(findUnique).not.toHaveBeenCalled();
    });

    it('populates the cache on a miss, with a SHORT ttl', async () => {
        findUnique.mockResolvedValue({ suspendedAt: new Date() });

        expect(await isAccountSuspended('u1')).toBe(true);

        expect(redisSet).toHaveBeenCalledWith(
            expect.stringContaining('u1'), '1', 'EX', SUSPENSION_CACHE_TTL,
        );
        // Short because the TTL is a BACKSTOP for a lost invalidation, not the
        // revocation window. A long one would make lifting a suspension slow,
        // and an appeal upheld is when someone should get their account back.
        expect(SUSPENSION_CACHE_TTL).toBeLessThanOrEqual(60);
    });

    it('caches a negative verdict too', async () => {
        expect(await isAccountSuspended('u1')).toBe(false);
        expect(redisSet).toHaveBeenCalledWith(
            expect.stringContaining('u1'), '0', 'EX', SUSPENSION_CACHE_TTL,
        );
    });

    it('keys per user, so one suspension is not everyone’s', async () => {
        await isAccountSuspended('alice');
        await isAccountSuspended('bob');

        const keys = redisGet.mock.calls.map((c) => c[0] as string);
        expect(keys[0]).not.toBe(keys[1]);
        expect(keys[0]).toContain('alice');
        expect(keys[1]).toContain('bob');
    });
});

describe('Redis unreadable falls THROUGH, it does not refuse', () => {
    it('reads Postgres when the cache GET throws', async () => {
        redisGet.mockRejectedValue(new Error('connection reset'));
        findUnique.mockResolvedValue({ suspendedAt: null });

        // Not a refusal: Redis is an optimisation over the authority, not the
        // authority. A cache outage must not sign anyone out.
        expect(await isAccountSuspended('u1')).toBe(false);
        expect(findUnique).toHaveBeenCalled();
    });

    it('reads Postgres when Redis is not configured at all', async () => {
        // The state every test in this repo actually runs in — which is how
        // the integration suite came to "prove" the cache without one.
        redisAvailable = false;
        findUnique.mockResolvedValue({ suspendedAt: new Date() });

        expect(await isAccountSuspended('u1')).toBe(true);
        expect(findUnique).toHaveBeenCalled();
    });

    it('still answers when the cache SET throws', async () => {
        redisSet.mockRejectedValue(new Error('OOM command not allowed'));

        await expect(isAccountSuspended('u1')).resolves.toBe(false);
    });
});

describe('Postgres unreadable fails CLOSED', () => {
    it('treats an unreadable row as suspended', async () => {
        findUnique.mockRejectedValue(new Error('too many connections'));

        // Strict, and free: a request that cannot read this row cannot do its
        // own work either, so this creates no new outage mode.
        expect(await isAccountSuspended('u1')).toBe(true);
    });

    it('does NOT cache a failed lookup', async () => {
        findUnique.mockRejectedValue(new Error('too many connections'));

        await isAccountSuspended('u1');

        // Caching a fail-closed verdict would turn one database blip into a
        // full TTL of lockout for that user, long after the database recovered.
        expect(redisSet).not.toHaveBeenCalled();
    });

    it('a MISSING user is not suspended', async () => {
        findUnique.mockResolvedValue(null);

        // Not a user, so not a suspended user. Returning true would turn a
        // deleted account into a confusing refusal instead of the
        // unauthenticated one the caller already handles.
        expect(await isAccountSuspended('gone')).toBe(false);
    });
});

describe('invalidation', () => {
    it('deletes the key for that user only', async () => {
        await invalidateSuspensionCache('u1');

        expect(redisDel).toHaveBeenCalledTimes(1);
        expect(redisDel.mock.calls[0][0]).toContain('u1');
    });

    it('is a no-op when Redis is absent, and does not throw', async () => {
        redisAvailable = false;
        await expect(invalidateSuspensionCache('u1')).resolves.toBeUndefined();
    });

    it('swallows a DEL failure rather than failing the suspension', async () => {
        // A lost invalidation degrades to the TTL. Propagating would undo a
        // suspension that has already taken effect in the database.
        redisDel.mockRejectedValue(new Error('connection reset'));
        await expect(invalidateSuspensionCache('u1')).resolves.toBeUndefined();
    });
});
