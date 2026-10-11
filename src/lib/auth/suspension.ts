/**
 * Is this account suspended? Asked on every authenticated request (P5.9, #1600).
 *
 * ## Why a suspension-specific check rather than tightening the general ones
 *
 * Owner ruling, DECISION 1 on #1600. The two existing revocation paths have
 * deliberate lags — the JWT `sessionVersion` check is throttled to 5 minutes,
 * and a bearer access token is only re-examined at refresh, so revocation waits
 * up to its 15-minute TTL. Both buy something real: no database read on every
 * authenticated request. Tightening them would put that read on every request a
 * farmer makes over rural LTE, to close a window that matters for a handful of
 * accounts.
 *
 * So suspension gets its own signal, checked every request, and the general
 * paths are left alone.
 *
 * ## Why it CANNOT live in middleware, which is where "within one request"
 * would naturally go
 *
 * `src/middleware.ts` has the one enforcement point that reads `token.error`,
 * and it covers cookie AND bearer because `getToken()` reads both. That is
 * where this belongs on paper — and it is impossible here. Middleware declares
 * no runtime, so it runs on the EDGE, and `redisBucket.ts` states the
 * consequence plainly: *"ioredis is Node-only, and so is Prisma, so the Edge has
 * no persistent store available at all in this deployment."* Upstash is absent
 * in production (checked on the VM), so there is nothing at the Edge to ask.
 *
 * Setting `token.error` from the `jwt` callback does not work either: that
 * callback runs when a session is re-issued, not per request, which is exactly
 * why the `sessionVersion` check is throttled at all. A flag written there takes
 * effect on the next re-issue — the 5-minute lag by another route.
 *
 * So the check runs in NODE, at `getSessionOrThrow`, which all three context
 * resolvers call and which goes through `auth()` — cookie first, bearer
 * fallback. One function, both credential types, every authenticated route.
 *
 * ## The fail direction, which is NOT the dogmatic answer
 *
 * `src/middleware.ts` deliberately fails OPEN on an unknown session answer, and
 * says why: *"Failing closed there would turn a database blip into a fleet-wide
 * sign-out of every operator mid-field."* That reasoning is right and it does
 * NOT apply here, for a specific reason worth stating:
 *
 * **This check reads the same database the request needs anyway.** A request
 * whose `User` row is unreadable cannot do the work it came for — the journal
 * entry, the listing, the message all need that database. So failing closed
 * creates no new outage mode: the request was going to fail regardless. That
 * makes the strict direction free here, where it would have been expensive in
 * middleware.
 *
 * Redis is treated as the opposite: a cache miss or a Redis error falls THROUGH
 * to Postgres rather than refusing. Redis being down must not sign anyone out,
 * because Redis is not the authority — it is an optimisation over one.
 *
 * ## The cache TTL is a backstop, not the revocation window
 *
 * A cached "not suspended" would otherwise make the TTL the real lag, which
 * would be rebuilding the thing this phase is fixing with a smaller number. So
 * `suspendAccount` DELETES the key in the same operation that sets the column,
 * and the TTL only matters if that invalidation is lost. With one app container
 * the distinction is academic; with a second replica it is the whole reason the
 * cache lives in Redis rather than in a process-local Map.
 */
import prisma from '@/lib/prisma';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';

/**
 * How long a NEGATIVE answer is cached.
 *
 * Short, because it is a backstop for a lost invalidation rather than the
 * mechanism. 60s bounds the damage of a missed `DEL` to one minute while still
 * absorbing essentially every request: a user making ten calls to render a page
 * pays one Postgres read, not ten.
 *
 * A POSITIVE answer is cached for the same duration and no longer. Caching a
 * suspension for hours would make LIFTING one slow, and an appeal upheld is
 * exactly the moment a person should get their account back immediately.
 */
const SUSPENSION_CACHE_TTL_SECONDS = 60;

const CACHE_PREFIX = 'suspension:v1:';

/** `'1'` suspended, `'0'` not. A deliberately tiny value — this is a hot key. */
type CachedVerdict = '0' | '1';

function cacheKey(userId: string): string {
    return `${CACHE_PREFIX}${userId}`;
}

/**
 * Whether this account's access is currently withheld.
 *
 * Throws nothing. Returns `true` when the answer could not be determined from
 * the database — see "The fail direction" above.
 */
export async function isAccountSuspended(userId: string): Promise<boolean> {
    const redis = getRedis();

    if (redis) {
        try {
            const cached = (await redis.get(cacheKey(userId))) as CachedVerdict | null;
            if (cached === '0') return false;
            if (cached === '1') return true;
        } catch (err) {
            // Fall THROUGH to Postgres. Redis is not the authority, and a
            // cache outage must not sign anyone out.
            logger.warn('suspension.cache_unreadable', {
                component: 'suspension',
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    let suspended: boolean;
    try {
        const row = await prisma.user.findUnique({
            where: { id: userId },
            select: { suspendedAt: true },
        });
        // A MISSING user is not suspended — it is not a user. Returning `true`
        // here would turn a deleted account into a confusing refusal rather
        // than the unauthenticated one the caller already handles.
        suspended = row?.suspendedAt != null;
    } catch (err) {
        logger.error('suspension.lookup_failed', {
            component: 'suspension',
            error: err instanceof Error ? err.message : String(err),
        });
        // FAIL CLOSED, and it costs nothing new: a request that cannot read
        // this row cannot do its own work either.
        return true;
    }

    if (redis) {
        try {
            await redis.set(
                cacheKey(userId),
                suspended ? '1' : '0',
                'EX',
                SUSPENSION_CACHE_TTL_SECONDS,
            );
        } catch {
            // A cache we could not write is a cache we do without.
        }
    }

    return suspended;
}

/**
 * Drop the cached verdict for one account.
 *
 * Called by every path that CHANGES the column, in the same operation. Not
 * best-effort in intent, even though a failure cannot be propagated: a lost
 * invalidation degrades to the TTL, which is why the TTL is short.
 */
export async function invalidateSuspensionCache(userId: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
        await redis.del(cacheKey(userId));
    } catch (err) {
        logger.warn('suspension.cache_invalidation_failed', {
            component: 'suspension',
            userId,
            ttlSeconds: SUSPENSION_CACHE_TTL_SECONDS,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/** Exported for the test that pins the backstop's size. */
export const SUSPENSION_CACHE_TTL = SUSPENSION_CACHE_TTL_SECONDS;
