/**
 * Runtime feature flags — the dark-launch rail every social surface sits behind.
 *
 * Three rules, in precedence order, and the order is the whole design:
 *
 *   1. `FEATURE_FLAGS_FORCE_OFF=1` turns EVERYTHING off, within one request.
 *      It is read per call and never cached, so the kill switch cannot be
 *      defeated by a warm cache — which is the only property that makes it a
 *      kill switch rather than a suggestion.
 *   2. A flag absent from the table is OFF. Default-off is structural: there is
 *      no code path that treats "unknown" as enabled.
 *   3. `enabled` AND cohort membership. When `cohorts` is non-empty, enabling
 *      the flag is necessary but not sufficient. Read as OR, an enabled flag
 *      with cohorts set would expose the surface to the whole deployment.
 *
 * ── why not NEXT_PUBLIC_* ──
 *
 * `NEXT_PUBLIC_*` is inlined at `next build`, so a flag held there needs a
 * rebuild, an image push and a rollout to flip. `NEXT_PUBLIC_NOTIFICATIONS_SSE`
 * is the live example: a client switch that is off in production and cannot be
 * turned on without shipping. Flags are therefore DB-backed and read at request
 * time.
 *
 * ── the cache, and what it is allowed to cost ──
 *
 * The flag TABLE is cached in Redis for 30s under ONE key, so a flip propagates
 * in ≤30s and the common request does no database read. Cohort membership is NOT
 * cached: it is per-user, the cache would be keyed per user, and a stale
 * membership is a wrong answer about one person rather than bounded staleness
 * about the deployment.
 *
 * `getRedis()` returns null in dev and test. That is not an error path — the
 * resolver reads the database directly and every rule above still holds. A flag
 * system that only works with Redis would be a flag system that fails closed on
 * a Redis outage, and failing closed here means the product disappears.
 */
import { prisma } from '@/lib/prisma';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';
import { notFound } from '@/lib/errors/types';

/** One key for the whole table — a flag flip invalidates every flag at once. */
const CACHE_KEY = 'feature-flags:v1:all';
/** 30s, so a flip propagates within the window the plan's hardening asserts. */
const CACHE_TTL_SECONDS = 30;

export interface FlagRow {
    key: string;
    enabled: boolean;
    cohorts: string[];
}

/** The resolved answer for one caller: flag key -> visible to THEM. */
export type ResolvedFlags = Record<string, boolean>;

/**
 * Is the global kill switch engaged?
 *
 * Read from the environment on EVERY call rather than captured at module load:
 * a module-level constant would be fixed for the life of the process, so a
 * container that started before the switch was set would ignore it until
 * restarted — which is precisely when you need it to work.
 */
export function flagsForcedOff(): boolean {
    return process.env.FEATURE_FLAGS_FORCE_OFF === '1';
}

/** The flag table, via a 30s Redis cache when Redis is there. */
export async function readFlagTable(): Promise<FlagRow[]> {
    const redis = getRedis();
    if (redis) {
        try {
            const hit = await redis.get(CACHE_KEY);
            if (hit) return JSON.parse(hit) as FlagRow[];
        } catch (err) {
            // A cache read failure must not take the product down with it.
            logger.warn('feature-flags.cache_read_failed', {
                component: 'feature-flags',
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const rows = await prisma.featureFlag.findMany({
        select: { key: true, enabled: true, cohorts: true },
    });

    if (redis) {
        try {
            await redis.set(CACHE_KEY, JSON.stringify(rows), 'EX', CACHE_TTL_SECONDS);
        } catch (err) {
            logger.warn('feature-flags.cache_write_failed', {
                component: 'feature-flags',
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return rows;
}

/** Drop the cached table so the next read is fresh. Called after a flip. */
export async function invalidateFlagCache(): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
        await redis.del(CACHE_KEY);
    } catch (err) {
        logger.warn('feature-flags.cache_invalidate_failed', {
            component: 'feature-flags',
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/** The cohorts this user belongs to. Not cached — see the module note. */
async function cohortsFor(userId: string | null): Promise<Set<string>> {
    if (!userId) return new Set();
    const rows = await prisma.featureFlagCohortMember.findMany({
        where: { userId },
        select: { cohortKey: true },
    });
    return new Set(rows.map((r) => r.cohortKey));
}

/**
 * Every flag, resolved for one caller.
 *
 * `userId` null means an anonymous caller: they are in no cohort, so a
 * cohort-gated flag is off for them even when enabled.
 */
export async function resolveFlags(userId: string | null): Promise<ResolvedFlags> {
    // Rule 1 first, and before any IO: the kill switch answers without touching
    // Redis or the database, so it still works when both are unhappy.
    if (flagsForcedOff()) return {};

    const [rows, cohorts] = await Promise.all([readFlagTable(), cohortsFor(userId)]);

    const out: ResolvedFlags = {};
    for (const row of rows) {
        out[row.key] = row.enabled && (row.cohorts.length === 0 || row.cohorts.some((c) => cohorts.has(c)));
    }
    return out;
}

/**
 * One flag, for one caller. Absent means false — see rule 2.
 *
 * Prefer `resolveFlags` when a surface checks several flags: this reads the
 * cached table per call, which is cheap but not free.
 */
export async function isFeatureEnabled(key: string, userId: string | null): Promise<boolean> {
    const flags = await resolveFlags(userId);
    return flags[key] === true;
}

/**
 * Gate an API route on a flag. Throws a 404 when the flag is off.
 *
 * 404 AND NOT 403, deliberately. A dark-launched surface should not be
 * discoverable: 403 says "this exists and you may not have it", which tells an
 * unauthorised reader that the feature is real and shipping. The same reasoning
 * the plan applies to private profiles in P6 — a private and a missing profile
 * return the same 404.
 *
 * The twin of `assertModuleEnabled` for module gating; the difference is scope
 * (platform, not tenant) and the status (404, not the module gate's answer).
 */
export async function assertFeatureEnabled(key: string, userId: string | null): Promise<void> {
    if (!(await isFeatureEnabled(key, userId))) {
        throw notFound('Not found');
    }
}
