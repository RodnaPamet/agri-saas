/**
 * Turn a runtime feature flag on for the duration of a spec, and back off.
 *
 * Some surfaces are DORMANT in production — tenant SAML / OIDC SSO and SCIM
 * since 2026-11-18 — and stay in the codebase so they can be turned back on
 * from the flag console. The specs that exercise their UI keep running with
 * the flag on, so that turning one back on is not a step into untested code;
 * the specs that assert the production state run with it off.
 *
 * ## Why the Redis key is deleted here
 *
 * The server caches the whole flag table in Redis for 30 seconds
 * (`@/lib/feature-flags`, `feature-flags:v1:all`). Writing the row alone
 * would leave the server serving the OLD table for up to half a minute, so a
 * spec that flipped a flag and navigated would see a coin-flip. Deleting the
 * key makes the next request read the table fresh — the same thing
 * `invalidateFlagCache()` does after a console write.
 *
 * E2E runs with `workers: 1`, so a flag a spec turns on is visible to that
 * spec only: `restore()` runs in its `afterAll`, before the next file starts.
 */
import Redis from 'ioredis';

import { agPrisma } from './ag-fixtures';

/** Must match CACHE_KEY in src/lib/feature-flags.ts. */
const FLAG_CACHE_KEY = 'feature-flags:v1:all';

async function bustFlagCache(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) return; // no Redis → the server has no cache to bust
    const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
        await redis.connect();
        await redis.del(FLAG_CACHE_KEY);
    } finally {
        redis.disconnect();
    }
}

/**
 * Enable `keys` (no cohorts — these surfaces are resolved with no user) and
 * return a function that puts every row back the way it was found.
 */
export async function enableFlags(...keys: string[]): Promise<() => Promise<void>> {
    const prisma = agPrisma();
    try {
        const before = await prisma.featureFlag.findMany({ where: { key: { in: keys } } });
        for (const key of keys) {
            await prisma.featureFlag.upsert({
                where: { key },
                update: { enabled: true, cohorts: [] },
                create: { key, enabled: true, cohorts: [] },
            });
        }
        await bustFlagCache();

        return async () => {
            const p = agPrisma();
            try {
                for (const key of keys) {
                    const prior = before.find((r) => r.key === key);
                    if (prior) {
                        await p.featureFlag.update({
                            where: { key },
                            data: { enabled: prior.enabled, cohorts: prior.cohorts },
                        });
                    } else {
                        await p.featureFlag.deleteMany({ where: { key } });
                    }
                }
                await bustFlagCache();
            } finally {
                await p.$disconnect();
            }
        };
    } finally {
        await prisma.$disconnect();
    }
}
