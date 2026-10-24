/**
 * Does every flag key the code gates on have a row? (#2009, #2291)
 *
 * ## The silence this reports
 *
 * A `FeatureFlag` row that does not exist is OFF by design, and
 * `assertFeatureEnabled` 404s rather than 403s — deliberately, for
 * anti-enumeration. Both decisions are right, and together they mean a surface
 * whose key was never inserted is indistinguishable from a surface that does
 * not exist. #2009's instance 3: `social.public-profile` gated 12 call sites,
 * production held exactly one row, and every one of them returned
 * `notFound()` for everybody for months. Nothing reported it, because nothing
 * was wrong — the code was correct and the table was simply missing a row.
 *
 * Measured again on 2026-10-24 (#2291): two of the six referenced keys had no
 * row. `social.farm-media` gates `GET /api/public/media/[hash]`, so with
 * `social.public-profile` ENABLED the public farm page rendered while every
 * photograph on it 404'd; `integrations.google` gated an admin Connect button
 * that could only ever fail. Both rows were inserted that day on an owner
 * ruling, which is exactly why this exists: the next one should not need
 * somebody to go looking.
 *
 * This is the #781 treatment, fifth instance of the same argument: WATCHED,
 * not gated. `capabilities.basemap` exists because "the code shipped" and "the
 * capability is active" are different claims; so do `capabilities.email` and
 * `capabilities.platformConsole`. Same shape.
 *
 * ## Why not a startup assertion, which is the tempting shape
 *
 * #2009 answers this itself: *"A startup assertion is tempting and probably
 * wrong for flags: a container that refuses to boot because a flag row is
 * missing turns a dark feature into an outage."* So this sits OUTSIDE
 * `checks`/`failed` like its four siblings and can never 503 the probe — which
 * matters more here than for any of them, because `/api/readyz` is the GCP
 * uptime check's target and a missing flag row must never page anybody.
 *
 * ## Three states
 *
 *   - `complete` — every referenced key has a row. Says nothing about whether
 *     those rows are ENABLED: a row with `enabled=false` is a legitimate
 *     state, and P2–P6 surfaces are dark-launch by default. The distinction
 *     this draws is "no row at all" versus "a row somebody decided about".
 *   - `incomplete` — at least one referenced key has no row, with the keys
 *     named.
 *   - `unknown` — the lookup could not run. Reported rather than collapsed
 *     into `incomplete`, because during a database incident every probe would
 *     otherwise shout about a configuration fault that does not exist, and the
 *     real signal in that window is `checks.database`, which `readyz` already
 *     fails on. `a-finding-wants-both-questions`: this guards the false alarm
 *     as well as the miss.
 *
 * ## The keys ARE named, unlike every sibling capability
 *
 * `basemap` reports a branch enum and `platformConsole` a state enum, both
 * under a firm "never a key, never a host" precedent. The departure is
 * deliberate and the reasoning is that the precedent is about SECRETS and
 * these are not: `REFERENCED_FLAG_KEYS` is a closed set compiled into the
 * image from public source, carries no credential, and is not caller-supplied.
 * Reporting `incomplete` without saying which key is missing would leave an
 * operator with the console open and nothing to type into it — a signal that
 * names a problem it cannot act on is how a report earns its way to being
 * ignored.
 *
 * ## `orphanRows` is the second number
 *
 * The count of rows whose key nothing gates on. Harmless on its own — a
 * retired flag — but it is what separates "the table is populated and missing
 * two" from "the table is empty or I read the wrong one", and an empty read
 * would otherwise report every key missing with perfect confidence. A count,
 * not names, because an unreferenced key is the one case where the value did
 * not come from this repo.
 *
 * ## The client is INJECTED, and not for testability
 *
 * Importing `@/lib/prisma` here would pull the extended client into `readyz`'s
 * module graph, and that module reads `Prisma.dmmf` at load. Three readyz
 * suites mock `@prisma/client` with `PrismaClient` alone, so the import throws
 * before any test runs — 28 failures across 3 suites when
 * `platformConsoleCapability` did it. The repo's partial-barrel-mock trap,
 * reached transitively.
 *
 * `readyz` already builds a raw `PrismaClient` for the database check and
 * passes that. It is also the RIGHT client: `FeatureFlag.key` is not an
 * encrypted column, so the extension's per-tenant DEK resolution would be work
 * for nothing — and `FeatureFlag` is tenantless, so there is no tenant context
 * to resolve one from.
 */
import { REFERENCED_FLAG_KEYS } from '@/lib/feature-flag-keys';
import { logger } from '@/lib/observability/logger';

export type FeatureFlagRowsState = 'complete' | 'incomplete' | 'unknown';

export interface FeatureFlagsCapability {
    readonly state: FeatureFlagRowsState;
    /** Referenced keys with no row. Empty unless `state` is `incomplete`. */
    readonly missingRows: readonly string[];
    /** How many referenced keys there are, so the figure above has a scale. */
    readonly referenced: number;
    /** Rows whose key nothing gates on. A count — see the docblock. */
    readonly orphanRows: number;
}

/** The one query this needs, so a caller can pass any client that has it. */
export interface FeatureFlagKeyReader {
    featureFlag: {
        findMany(args: { select: { key: true } }): Promise<{ key: string }[]>;
    };
}

/**
 * NOT memoized, for `platformConsoleCapability`'s reason: the state changes
 * WITHOUT a restart. Inserting the missing row through the console moves
 * `incomplete` → `complete` while the process keeps running, and a cached
 * `incomplete` would then be a stale alarm — which is the failure direction
 * that makes a report ignorable. One unindexed read of a table holding single
 * digits of rows, against a probe every 60s from six regions.
 */
export async function featureFlagsCapability(
    db: FeatureFlagKeyReader,
): Promise<FeatureFlagsCapability> {
    const referenced = REFERENCED_FLAG_KEYS.length;
    try {
        const rows = await db.featureFlag.findMany({ select: { key: true } });
        const present = new Set(rows.map((r) => r.key));
        const missingRows = REFERENCED_FLAG_KEYS.filter((k) => !present.has(k));
        const orphanRows = [...present].filter(
            (k) => !(REFERENCED_FLAG_KEYS as readonly string[]).includes(k),
        ).length;
        return {
            state: missingRows.length === 0 ? 'complete' : 'incomplete',
            missingRows,
            referenced,
            orphanRows,
        };
    } catch (err) {
        // `unknown`, never `incomplete` — see the docblock. An unreadable table
        // is a database problem, and reporting it as a configuration fault
        // would send an operator to the flag console during an outage.
        logger.warn('feature_flags.capability_lookup_failed', {
            component: 'feature-flags-capability',
            error: err instanceof Error ? err.message : String(err),
        });
        return { state: 'unknown', missingRows: [], referenced, orphanRows: 0 };
    }
}
