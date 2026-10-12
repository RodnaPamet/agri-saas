/**
 * Is this account frozen because the person asked to be deleted? (#1655)
 *
 * ## Why this is a sibling of `isAccountSuspended` and not a branch of it
 *
 * Both withhold something, and P5.6b already recorded why they must stay
 * apart: *"the cause differs and so does the remedy. Collapsing them would send
 * an Art 17 statement to somebody who asked to leave, and would let a person
 * cancel their own suspension."* So this is a separate verdict, a separate
 * cache key and a separate refusal code — `ACCOUNT_DELETION_PENDING`, never
 * `ACCOUNT_SUSPENDED`.
 *
 * ## Where it is read, and the one place it must NOT be
 *
 * At the `withApiErrorHandling` mutation choke point only — the seam P5.5a's
 * slow mode already uses for a per-account policy. Deliberately NOT in
 * `getSessionOrThrow`, where P5.9's suspension check lives, for two reasons:
 *
 *   - that choke point governs READS as well as writes, and the ruling is "no
 *     new content", not "no access". A person in the grace period can still
 *     look at their own farm;
 *   - both escape hatches — `DELETE /api/account/deletion` and
 *     `GET /api/account/export` — resolve through `getUserCtx`, hence through
 *     `getSessionOrThrow`. A check there would block the route out of the
 *     freeze, which is the `slow-mode-escape-is-not-throttled` failure exactly.
 *
 * ## The fail directions, inherited rather than re-decided
 *
 * Redis unreadable falls THROUGH to Postgres (a cache outage must not freeze
 * anyone). Postgres unreadable fails OPEN here, and that is the one place this
 * differs from suspension — deliberately. A suspension is a platform refusal
 * where failing closed is free, because the request could not do its work
 * anyway. This is a self-service state, and refusing a farmer's journal entry
 * because a cache and a database both hiccuped is a worse outcome than letting
 * one write through during the grace period. The data is not erased for 30
 * days, so a missed block costs almost nothing; a false block costs a field
 * record.
 */
import prisma from '@/lib/prisma';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';

/**
 * Short, for the reason suspension's is: the TTL is a BACKSTOP for a lost
 * invalidation, not the unfreeze window. Both self-service edges invalidate
 * explicitly, so this only matters if one of those is lost — and a person who
 * just cancelled must not stay frozen while they watch.
 */
export const DELETION_PENDING_CACHE_TTL = 30;

const key = (userId: string) => `account:deletion-pending:${userId}`;

export async function isDeletionPending(userId: string): Promise<boolean> {
    const redis = getRedis();
    if (redis) {
        try {
            const hit = await redis.get(key(userId));
            if (hit === '1') return true;
            if (hit === '0') return false;
        } catch (err) {
            // Fall through to the authority. Redis is an optimisation over it.
            logger.warn('deletion_pending.cache_read_failed', {
                component: 'deletion-pending',
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    let pending: boolean;
    try {
        const row = await prisma.user.findUnique({
            where: { id: userId },
            select: { deletionRequestedAt: true },
        });
        // No row is not a frozen row — the same reading `isAccountSuspended`
        // gives a missing user, so a deleted account meets the unauthenticated
        // refusal its caller already handles rather than a confusing freeze.
        pending = Boolean(row?.deletionRequestedAt);
    } catch (err) {
        // FAIL OPEN, unlike suspension. See the docblock: a false freeze costs
        // a farmer a field record, a missed one costs ~nothing for 30 days.
        logger.error('deletion_pending.lookup_failed', {
            component: 'deletion-pending',
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    }

    if (redis) {
        try {
            await redis.set(key(userId), pending ? '1' : '0', 'EX', DELETION_PENDING_CACHE_TTL);
        } catch {
            // A cache that will not accept a write still answered the question.
        }
    }
    return pending;
}

/**
 * Drop the cached verdict for one person.
 *
 * Called on BOTH edges — requesting and cancelling. Requesting matters because
 * a cached `'0'` from a mutation moments earlier would let the person keep
 * writing for the rest of the TTL; cancelling matters because a cached `'1'`
 * would keep them frozen after they recovered, which is the moment it would be
 * least forgivable.
 *
 * Never throws: a lost invalidation degrades to the TTL, and propagating would
 * fail a request whose database work has already committed.
 */
export async function invalidateDeletionPendingCache(userId: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
        await redis.del(key(userId));
    } catch (err) {
        logger.warn('deletion_pending.cache_invalidate_failed', {
            component: 'deletion-pending',
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
