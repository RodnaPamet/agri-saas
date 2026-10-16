import { NextRequest } from 'next/server';
import type { Metric } from 'web-vitals';

import { logger } from '@/lib/observability/logger';

/**
 * Anonymous web-vitals RUM sink. Public (see `isPublicPath`) and bare (no
 * mutation rate-limit — vitals beacon several times per page load). No PII:
 * only the metric name / value / rating. Always 204s; a malformed beacon is
 * ignored.
 *
 * ## Every logged field comes from a closed set — #1964
 *
 * This route is public and unauthenticated, and it is deliberately outside
 * `withApiErrorHandling` so that it is NOT rate-limited: a real beacon fires
 * several times per page load and throttling it would drop the measurements
 * this endpoint exists to collect. Those two properties together mean any
 * field echoed from the body is an unbounded, unauthenticated write into the
 * log — and since #1940 those logs leave the VM, so it is billable ingest
 * that anyone on the internet can drive.
 *
 * `typeof x === 'string'` bounds neither length nor content. Pino
 * JSON-escapes its values, so this was never entry forgery; it was volume and
 * arbitrary content. `rating`, `navigationType` and `name` used to be echoed
 * on nothing but a `typeof` check while `surface` beside them was closed-set
 * checked, which is the inconsistency #1964 records.
 *
 * ## The registries are derived from `Metric`, not transcribed from the spec
 *
 * `Record<Metric['name'], true>` and friends make tsc the thing that keeps
 * these lists honest: a `web-vitals` upgrade that adds a metric, a rating or
 * a navigation type fails the build here instead of silently dropping the new
 * value. That matters more than it sounds — writing #1964 from memory I
 * listed six navigation types and the installed library has **seven**
 * (`soft-navigation`), which is exactly the drift a hand-kept list invites.
 *
 * Same idiom as `REASON_REGISTRY` in `src/lib/db/rls-middleware.ts`.
 *
 * `surface` is ours, not the library's, so it has no type to derive from —
 * hence a local union and the same treatment.
 */
const METRIC_NAMES: Record<Metric['name'], true> = {
    CLS: true,
    FCP: true,
    INP: true,
    LCP: true,
    TTFB: true,
};

const RATINGS: Record<Metric['rating'], true> = {
    good: true,
    'needs-improvement': true,
    poor: true,
};

const NAVIGATION_TYPES: Record<Metric['navigationType'], true> = {
    navigate: true,
    reload: true,
    'back-forward': true,
    'back-forward-cache': true,
    prerender: true,
    restore: true,
    'soft-navigation': true,
};

/** The coarse surface label the reporter derives with `isPublicSurface` (#1814). */
type Surface = 'public-farm' | 'app';
const SURFACES: Record<Surface, true> = { 'public-farm': true, app: true };

/**
 * The value if it is a member of `registry`, otherwise `undefined`.
 *
 * `Object.hasOwn` rather than `registry[value]`, so an inherited key cannot
 * answer for a real one — `'constructor'` and `'toString'` are the cases, and
 * a prototype hit would admit precisely the attacker-chosen strings this
 * function exists to refuse. Same reasoning as
 * `src/components/processes/node-taxonomy.ts:383`.
 */
function allowed<K extends string>(registry: Record<K, true>, value: unknown): K | undefined {
    return typeof value === 'string' && Object.hasOwn(registry, value) ? (value as K) : undefined;
}

export async function POST(req: NextRequest) {
    try {
        const m = (await req.json()) as Record<string, unknown> | null;
        const metric = allowed(METRIC_NAMES, m?.name);
        const value = m?.value;

        /**
         * An unrecognised `name` drops the WHOLE beacon, where an
         * unrecognised `rating` only drops that field. The asymmetry is
         * deliberate: `name` is what the measurement IS, so a beacon naming
         * no known metric is not a measurement with a bad label — there is
         * nothing left to record. A rating is an annotation on a value that
         * is still perfectly good.
         */
        if (metric && typeof value === 'number' && Number.isFinite(value)) {
            logger.info('web-vital', {
                component: 'web-vitals',
                metric,
                value: Math.round(value * 1000) / 1000,
                /**
                 * Dropped, never defaulted — for all three. A default would
                 * attribute a stranger's beacon to a real rating, surface or
                 * navigation type, which is worse for every question these
                 * fields exist to answer than simply not knowing.
                 */
                rating: allowed(RATINGS, m?.rating),
                navigationType: allowed(NAVIGATION_TYPES, m?.navigationType),
                surface: allowed(SURFACES, m?.surface),
            });
        }
    } catch {
        /* malformed beacon — ignore */
    }
    return new Response(null, { status: 204 });
}
