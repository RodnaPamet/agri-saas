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
 * The channel reporting its OWN failure — #1940.
 *
 * Measured over 30 days: 1857 requests logged, **0** `web-vital` entries and
 * **0** requests to this route. The pipeline is code-complete and has
 * produced nothing, and the reason it went unnoticed is that it could not
 * say so: the dynamic import's `.catch(() => {})` is silent, `sendBeacon`'s
 * boolean return was discarded, and the reporter wraps everything in a bare
 * `catch`. A dead RUM channel looked exactly like a healthy one with no
 * interesting metrics.
 *
 * Best-effort is right for the BEACON — a visitor's page must not break
 * because telemetry failed. It is wrong for the CHANNEL, and those are
 * different concerns.
 *
 * ## Why a client-reported error can arrive when a metric cannot
 *
 * The two candidate causes differ exactly here. If the `web-vitals` chunk is
 * blocked by the nonce-based strict CSP (`script-src`), the callbacks never
 * run and no metric can ever be sent — but `connect-src` allows `'self'`, so
 * a diagnostic POST still arrives. An `import-failed` entry in the log
 * therefore DISCRIMINATES between the two candidates the issue lists, which
 * no amount of server-side waiting can do.
 *
 * A CLOSED SET, like every other echoed field (#1964): this route is public,
 * unauthenticated and deliberately un-rate-limited, so an open string here
 * would be billable log ingest anyone could drive.
 */
type ChannelError = 'import-failed' | 'beacon-refused';
const CHANNEL_ERRORS: Record<ChannelError, true> = {
    'import-failed': true,
    'beacon-refused': true,
};

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

        /**
         * Logged at WARN and under its own message, so "the channel is
         * broken" is a query rather than an inference from an absence. It is
         * deliberately NOT folded into `web-vital`: a dashboard counting
         * metrics must not count failures as measurements.
         *
         * Checked independently of `metric` above, not in an `else` — a body
         * carrying a channel error carries no `name`, so the two branches are
         * disjoint by construction, and an `else` would hide a future beacon
         * that reported both.
         */
        const channelError = allowed(CHANNEL_ERRORS, m?.channelError);
        if (channelError) {
            logger.warn('web-vital.channel_error', {
                component: 'web-vitals',
                channelError,
                surface: allowed(SURFACES, m?.surface),
            });
        }
    } catch {
        /* malformed beacon — ignore */
    }
    return new Response(null, { status: 204 });
}
