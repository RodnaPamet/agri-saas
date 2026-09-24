/**
 * Zero-success route check — "a client is broken against this endpoint".
 *
 * ── THE FAILURE THIS EXISTS FOR ──
 *
 * An iOS client called `POST /api/t/{slug}/insurance/leads` with a body
 * missing a required field. Every request 400'd, for weeks, and nobody
 * noticed: production alerting is one GCP uptime check on `/api/readyz`,
 * and to that check a route failing 100% of the time looks exactly like a
 * route nobody calls. The per-request pino line said so on every single
 * call — into container stdout, where nothing queries it.
 *
 * ── THE RULE ──
 *
 * Over a rolling window (default the last 24 hours, read from the hourly
 * counters in `@/lib/observability/route-outcomes`), report every
 * (method, route) with:
 *
 *   • at least `minFailures` responses with status >= 400, AND
 *   • ZERO responses with status < 400.
 *
 * The zero-success half is the whole signal. A route with a 40% error
 * rate is a bug report; a route that has never once succeeded in a day
 * while being called repeatedly is a CONTRACT break — a client sending a
 * shape the server will never accept. The `minFailures` floor keeps a
 * route called twice by a scanner out of the report.
 *
 * Any 4xx counts as a failure, 429 and 401 included. That is deliberate:
 * a client hammering into rate limits or auth failures with no successful
 * call in a day is the same class of broken.
 *
 * ── WHAT IT IS NOT ──
 *
 * It sends nothing. The deliverable is one structured `logger.warn`
 * naming the offending routes; wiring that to a pager is an operator
 * decision, not this job's.
 *
 * It also never reports "clean" from a failed probe. No Redis, an
 * unreadable window, or an empty window are each logged as UNKNOWN —
 * `outcomeDataAvailable` / `routesObserved` say which — because
 * "I could not look" and "I looked and everything is fine" are the two
 * states this whole job exists to stop conflating.
 *
 * @module app-layer/jobs/zero-success-route-check
 */
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import {
    readRouteOutcomeWindow,
    ROUTE_OUTCOME_WINDOW_HOURS,
    type RouteOutcomeCounts,
} from '@/lib/observability/route-outcomes';

/** Hours of outcome history folded per run. */
export const DEFAULT_WINDOW_HOURS = ROUTE_OUTCOME_WINDOW_HOURS;

/**
 * Failures a route needs before a zero-success window is worth reporting.
 * Below this, "no successes" is as likely to mean "barely called" as
 * "broken" — one probe from a scanner should not page anyone.
 */
export const DEFAULT_MIN_FAILURES = 5;

/** Cap on routes named in one log line, so a site-wide outage can't emit a novel. */
export const DEFAULT_MAX_REPORTED = 20;

/** The status floor that separates a failure from a success. */
const FAILURE_STATUS_FLOOR = 400;

/** One route that failed with no successes at all in the window. */
export interface ZeroSuccessRouteFinding {
    method: string;
    route: string;
    /** Responses with status >= 400. */
    failures: number;
    /** Responses with status < 400 — always 0 for a finding, kept so the log states it. */
    successes: number;
    /** The failure status seen most often; ties break to the LOWEST status code. */
    dominantStatus: number;
    /** Full status breakdown, so the log line says what the client is actually getting. */
    statusCounts: Record<number, number>;
}

export interface DetectZeroSuccessOptions {
    minFailures?: number;
    maxReported?: number;
}

/**
 * The detection rule, as a pure function over folded counters.
 *
 * Sorted by failure volume (descending), then route, then method — a
 * total order, so the same window always produces the same report and the
 * `maxReported` slice is never a coin toss between two tied routes.
 */
export function detectZeroSuccessRoutes(
    observed: RouteOutcomeCounts[],
    options: DetectZeroSuccessOptions = {},
): ZeroSuccessRouteFinding[] {
    const minFailures = options.minFailures ?? DEFAULT_MIN_FAILURES;
    const maxReported = options.maxReported ?? DEFAULT_MAX_REPORTED;

    const findings: ZeroSuccessRouteFinding[] = [];

    for (const row of observed) {
        let successes = 0;
        let failures = 0;
        let dominantStatus = 0;
        let dominantCount = 0;

        for (const [statusText, count] of Object.entries(row.statusCounts)) {
            const status = Number(statusText);
            if (!Number.isFinite(status) || count <= 0) continue;

            if (status < FAILURE_STATUS_FLOOR) {
                successes += count;
                continue;
            }

            failures += count;
            if (count > dominantCount || (count === dominantCount && status < dominantStatus)) {
                dominantCount = count;
                dominantStatus = status;
            }
        }

        // The signal is the ABSENCE of any success. One 2xx in the window
        // means the endpoint accepts what at least one client sends, which
        // is a different (and far less urgent) problem.
        if (successes > 0) continue;
        if (failures < minFailures) continue;

        findings.push({
            method: row.method,
            route: row.route,
            failures,
            successes,
            dominantStatus,
            statusCounts: row.statusCounts,
        });
    }

    findings.sort(
        (a, b) =>
            b.failures - a.failures ||
            a.route.localeCompare(b.route) ||
            a.method.localeCompare(b.method),
    );

    return findings.slice(0, maxReported);
}

export interface ZeroSuccessRouteCheckOptions {
    /** Hours of history to fold. Default 24. */
    windowHours?: number;
    /** Failure floor before a route is reported. Default 5. */
    minFailures?: number;
    /** Max routes named in the log line. Default 20. */
    maxReported?: number;
    /** Override the "now" anchor — test-only seam. */
    now?: Date;
}

export interface ZeroSuccessRouteCheckResult {
    windowHours: number;
    /** Hourly buckets that held data. */
    bucketsRead: number;
    /** Distinct (method, route) pairs seen in the window. */
    routesObserved: number;
    /** Routes with failures and zero successes, worst first. */
    findings: ZeroSuccessRouteFinding[];
    /**
     * False when the counters could not be read at all. A false here means
     * the run decided NOTHING — it is not a clean bill of health.
     */
    outcomeDataAvailable: boolean;
}

/**
 * Fold the window, apply the rule, and say what it found in one
 * structured line.
 */
export async function runZeroSuccessRouteCheck(
    options: ZeroSuccessRouteCheckOptions = {},
): Promise<ZeroSuccessRouteCheckResult> {
    return runJob('zero-success-route-check', () => checkOnce(options));
}

/**
 * The run itself, outside the `runJob` wrapper so the observability
 * scaffolding and the check's own reasoning stay separable.
 */
async function checkOnce(
    options: ZeroSuccessRouteCheckOptions,
): Promise<ZeroSuccessRouteCheckResult> {
    const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;

    const window = await readRouteOutcomeWindow({
        hours: windowHours,
        now: options.now,
    });

    const findings = detectZeroSuccessRoutes(window.routes, {
        minFailures: options.minFailures,
        maxReported: options.maxReported,
    });

    const result: ZeroSuccessRouteCheckResult = {
        windowHours,
        bucketsRead: window.bucketsRead,
        routesObserved: window.routes.length,
        findings,
        outcomeDataAvailable: window.available,
    };

    if (!window.available) {
        // Probe failed ⇒ UNKNOWN. Warn, because a check that silently
        // stops checking is how the original bug survived weeks.
        logger.warn('zero-success route check could not read request outcomes', {
            component: 'zero-success-route-check',
            windowHours,
            reason: 'redis-unavailable',
        });
        return result;
    }

    if (window.routes.length === 0) {
        // Redis answered, but nothing has been counted. Also UNKNOWN: an
        // app that served no requests and an app whose counters stopped
        // being written look identical from here.
        logger.warn('zero-success route check saw no request outcomes at all', {
            component: 'zero-success-route-check',
            windowHours,
            bucketsRead: window.bucketsRead,
            reason: 'no-outcomes-recorded',
        });
        return result;
    }

    if (findings.length > 0) {
        logger.warn('api routes failing with zero successes', {
            component: 'zero-success-route-check',
            windowHours,
            bucketsRead: window.bucketsRead,
            routesObserved: window.routes.length,
            failingRouteCount: findings.length,
            // Flat list first: the one field an operator greps for.
            failingRoutes: findings.map((f) => `${f.method} ${f.route}`),
            detail: findings.map((f) => ({
                method: f.method,
                route: f.route,
                failures: f.failures,
                successes: f.successes,
                dominantStatus: f.dominantStatus,
                statusCounts: f.statusCounts,
            })),
        });
        return result;
    }

    logger.info('zero-success route check clean', {
        component: 'zero-success-route-check',
        windowHours,
        bucketsRead: window.bucketsRead,
        routesObserved: window.routes.length,
        failingRouteCount: 0,
    });

    return result;
}
