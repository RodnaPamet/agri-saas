/**
 * #1655 — the deletion-pending verdict, and the fail direction that is
 * deliberately the OPPOSITE of its neighbour's.
 *
 * `isAccountSuspended` fails CLOSED on an unreadable Postgres, and P5.9's note
 * explains why that is free: a request that cannot read `User.suspendedAt`
 * cannot do the work it came for either, so no new outage mode is created.
 *
 * That argument does NOT transfer here, and reusing it would have been the
 * `a-safety-argument-expires-silently` shape. This check runs at the mutation
 * choke point BEFORE the handler, on a request that may be perfectly able to
 * do its work. Failing closed would refuse a farmer's journal entry because a
 * cache and a database both hiccuped — and the cost of the opposite mistake is
 * almost nothing, because the data is not erased for 30 days and a missed
 * block during an outage changes no outcome.
 *
 * So: **Redis unreadable falls through; Postgres unreadable fails OPEN.** Both
 * asserted, because an inverted fail direction is invisible in a green suite.
 */
const redisGet = jest.fn();
const redisSet = jest.fn();
const redisDel = jest.fn();
let redisAvailable = true;

jest.mock('@/lib/redis', () => ({
    getRedis: () =>
        redisAvailable ? { get: redisGet, set: redisSet, del: redisDel } : null,
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
    isDeletionPending,
    invalidateDeletionPendingCache,
    DELETION_PENDING_CACHE_TTL,
} from '@/lib/auth/deletion-pending';

beforeEach(() => {
    redisAvailable = true;
    redisGet.mockReset().mockResolvedValue(null);
    redisSet.mockReset().mockResolvedValue('OK');
    redisDel.mockReset().mockResolvedValue(1);
    findUnique.mockReset().mockResolvedValue({ deletionRequestedAt: null });
});

describe('the cache answers without touching the database', () => {
    it("returns true on a cached '1' and does NOT query Postgres", async () => {
        redisGet.mockResolvedValue('1');
        expect(await isDeletionPending('u1')).toBe(true);
        expect(findUnique).not.toHaveBeenCalled();
    });

    it("returns false on a cached '0' and does NOT query Postgres", async () => {
        redisGet.mockResolvedValue('0');
        expect(await isDeletionPending('u1')).toBe(false);
        expect(findUnique).not.toHaveBeenCalled();
    });

    it('populates on a miss with a SHORT ttl', async () => {
        findUnique.mockResolvedValue({ deletionRequestedAt: new Date() });

        expect(await isDeletionPending('u1')).toBe(true);
        expect(redisSet).toHaveBeenCalledWith(
            expect.stringContaining('u1'), '1', 'EX', DELETION_PENDING_CACHE_TTL,
        );
        // A BACKSTOP for a lost invalidation, not the unfreeze window — both
        // edges invalidate explicitly. Long would mean a person who just
        // cancelled sits frozen watching their own screen.
        expect(DELETION_PENDING_CACHE_TTL).toBeLessThanOrEqual(60);
    });

    it('keys per user', async () => {
        await isDeletionPending('alice');
        await isDeletionPending('bob');
        const keys = redisGet.mock.calls.map((c) => c[0] as string);
        expect(keys[0]).not.toBe(keys[1]);
    });
});

describe('Redis unreadable falls THROUGH to the authority', () => {
    it('reads Postgres when the GET throws', async () => {
        redisGet.mockRejectedValue(new Error('connection reset'));
        findUnique.mockResolvedValue({ deletionRequestedAt: new Date() });

        expect(await isDeletionPending('u1')).toBe(true);
        expect(findUnique).toHaveBeenCalled();
    });

    it('reads Postgres when Redis is absent — the state .env.test is in', async () => {
        redisAvailable = false;
        findUnique.mockResolvedValue({ deletionRequestedAt: new Date() });

        expect(await isDeletionPending('u1')).toBe(true);
    });

    it('still answers when the SET throws', async () => {
        redisSet.mockRejectedValue(new Error('OOM command not allowed'));
        await expect(isDeletionPending('u1')).resolves.toBe(false);
    });
});

describe('Postgres unreadable fails OPEN — the opposite of suspension', () => {
    it('treats an unreadable row as NOT frozen', async () => {
        findUnique.mockRejectedValue(new Error('too many connections'));

        // THE MUTATION TARGET for the fail direction. Inverting this to `true`
        // would refuse every mutation on the platform during a database blip —
        // because this check runs on every mutating request, for every account.
        expect(await isDeletionPending('u1')).toBe(false);
    });

    it('does NOT cache a failed lookup', async () => {
        findUnique.mockRejectedValue(new Error('too many connections'));
        await isDeletionPending('u1');

        // Caching an outage verdict would extend one blip across a full TTL.
        expect(redisSet).not.toHaveBeenCalled();
    });

    it('a MISSING user is not frozen', async () => {
        findUnique.mockResolvedValue(null);
        expect(await isDeletionPending('gone')).toBe(false);
    });
});

describe('invalidation', () => {
    it('deletes that user’s key only', async () => {
        await invalidateDeletionPendingCache('u1');
        expect(redisDel).toHaveBeenCalledTimes(1);
        expect(redisDel.mock.calls[0][0]).toContain('u1');
    });

    it('is a no-op without Redis and does not throw', async () => {
        redisAvailable = false;
        await expect(invalidateDeletionPendingCache('u1')).resolves.toBeUndefined();
    });

    it('swallows a DEL failure', async () => {
        // Degrades to the TTL. Propagating would fail a cancel whose database
        // work has already committed — the person would be told their recovery
        // failed when it succeeded.
        redisDel.mockRejectedValue(new Error('connection reset'));
        await expect(invalidateDeletionPendingCache('u1')).resolves.toBeUndefined();
    });
});
