/**
 * Per-route request-outcome counters — a durable, queryable record of
 * "how did requests to this endpoint end?".
 *
 * ── WHY THIS EXISTS ──
 *
 * `recordRequestMetrics` already counts every request by (method, route,
 * status) — but into OpenTelemetry instruments, and `initTelemetry` is
 * hard-gated on `OTEL_ENABLED=true` with an OTLP collector at
 * `OTEL_EXPORTER_OTLP_ENDPOINT`. Neither is set on any deployment in
 * `deploy/`, so in production those counters are created against the noop
 * meter and thrown away. The other record of an outcome is the pino line
 * `withApiErrorHandling` emits per request — which goes to container
 * stdout and is not queryable by anything running inside the app.
 *
 * The consequence is the bug this module was written for: an iOS client
 * POSTing a body missing a required field made
 * `POST /api/t/{slug}/insurance/leads` return 400 for EVERY call, for
 * weeks, and nothing noticed. Production alerting is one GCP uptime check
 * on `/api/readyz`; a route at a 100% failure rate is indistinguishable
 * from a route nobody calls.
 *
 * So this module keeps the SMALLEST durable thing that makes that
 * distinguishable: a counter per (hour, status, method, route) in Redis —
 * already a hard dependency here (BullMQ, list cache, rate limiting) and
 * already pinned to `noeviction` in every compose file
 * (`tests/guards/redis-eviction-policy.test.ts`), so these counters cannot
 * be silently evicted out from under the job that reads them.
 *
 * It is NOT a telemetry system. There is no tenant axis, no latency, no
 * payload, no user — only how many requests to a route ended in each
 * status code. `zero-success-route-check` folds a rolling window of these
 * and warns about routes with failures and zero successes.
 *
 * ── SHAPE ──
 *
 *   key    `api:route-outcome:v1:<YYYY-MM-DDTHH>`   (one hash per UTC hour)
 *   field  `<status>|<METHOD> <route>`              e.g. `400|POST /api/t/:tenantSlug/insurance/leads`
 *   value  request count
 *
 * The status leads the field so parsing splits on the FIRST `|` and is
 * unambiguous no matter what a route contains.
 *
 * ── CARDINALITY ──
 *
 * Routes are the already-normalised labels `recordRequestMetrics` computes
 * (`normalizeRoute` collapses UUIDs, the tenant slug and long opaque ids),
 * plus a numeric-segment collapse applied here — `normalizeRoute` leaves
 * `/api/.../123` alone, which is a per-entity key this hash would grow a
 * field for. Every bucket also carries a TTL, so any cardinality surprise
 * self-heals within a day rather than growing forever.
 *
 * @module lib/observability/route-outcomes
 */
import { getRedis } from '@/lib/redis';
import { logger } from './logger';

/** Key namespace. Bump the version suffix if the field encoding changes. */
export const ROUTE_OUTCOME_PREFIX = 'api:route-outcome:v1';

/** Hours of history the reader folds by default. */
export const ROUTE_OUTCOME_WINDOW_HOURS = 24;

/**
 * Bucket TTL. Two hours of slack beyond the default window so the oldest
 * bucket a run reads is still alive when that run starts late.
 */
export const ROUTE_OUTCOME_TTL_SECONDS = (ROUTE_OUTCOME_WINDOW_HOURS + 2) * 3600;

/** Hard cap on a stored route label, so one pathological path can't bloat a field. */
const MAX_ROUTE_LABEL_CHARS = 160;

/** `/1234` → `/:id`. Applied on top of `normalizeRoute`, which leaves short numeric ids alone. */
const NUMERIC_SEGMENT_RE = /\/\d+(?=\/|$)/g;

/** The status range a real HTTP response can carry. */
const MIN_STATUS = 100;
const MAX_STATUS = 599;

/** Aggregated outcomes for one (method, route) pair over a window. */
export interface RouteOutcomeCounts {
    method: string;
    /** Normalised route label, e.g. `/api/t/:tenantSlug/insurance/leads`. */
    route: string;
    /** HTTP status code → number of requests that ended in it. */
    statusCounts: Record<number, number>;
}

/** One request-outcome field decoded back into its parts. */
export interface ParsedRouteOutcomeField {
    status: number;
    method: string;
    route: string;
}

/**
 * The label a route is counted under: `METHOD /normalised/route`.
 *
 * `route` is expected to be the output of `normalizeRoute`; this adds the
 * numeric-segment collapse and the length cap.
 */
export function routeOutcomeLabel(method: string, route: string): string {
    const collapsed = route.replace(NUMERIC_SEGMENT_RE, '/:id');
    return `${method.toUpperCase()} ${collapsed.slice(0, MAX_ROUTE_LABEL_CHARS)}`;
}

/** The Redis hash key for the UTC hour `at` falls in. */
export function routeOutcomeBucketKey(at: Date): string {
    // `2026-09-24T07:41:03.123Z`.slice(0, 13) → `2026-09-24T07`
    return `${ROUTE_OUTCOME_PREFIX}:${at.toISOString().slice(0, 13)}`;
}

/** Encode one outcome as a hash field. */
export function routeOutcomeField(status: number, label: string): string {
    return `${status}|${label}`;
}

/** Decode a hash field. Returns null for anything that isn't a well-formed field. */
export function parseRouteOutcomeField(field: string): ParsedRouteOutcomeField | null {
    const bar = field.indexOf('|');
    if (bar <= 0) return null;

    const statusText = field.slice(0, bar);
    if (!/^\d{3}$/.test(statusText)) return null;
    const status = Number(statusText);
    if (status < MIN_STATUS || status > MAX_STATUS) return null;

    const label = field.slice(bar + 1);
    const space = label.indexOf(' ');
    if (space <= 0) return null;

    const method = label.slice(0, space);
    const route = label.slice(space + 1);
    if (route.length === 0) return null;

    return { status, method, route };
}

/**
 * Count one finished request.
 *
 * Fire-and-forget by design: the write is never awaited on the response
 * path and never rejects into it. A single pipeline keeps it to one Redis
 * round trip, and a missing/failing Redis degrades to no counting at all
 * (which the reader reports as UNKNOWN, never as "clean" — see
 * `readRouteOutcomeWindow`).
 */
export function recordRouteOutcome(attrs: {
    method: string;
    /** Normalised route label — pass `normalizeRoute(pathname)`. */
    route: string;
    status: number;
}): void {
    const redis = getRedis();
    if (!redis) return;

    const key = routeOutcomeBucketKey(new Date());
    const field = routeOutcomeField(attrs.status, routeOutcomeLabel(attrs.method, attrs.route));

    void redis
        .pipeline()
        .hincrby(key, field, 1)
        .expire(key, ROUTE_OUTCOME_TTL_SECONDS)
        .exec()
        .catch((err: unknown) => {
            logger.warn('route-outcome counter write failed', {
                component: 'route-outcomes',
                error: err instanceof Error ? err.message : String(err),
            });
        });
}

/**
 * The bucket keys covering the `hours` UTC hours ending at `now`, newest
 * first. The hour `now` falls in is included (it is partial — that is
 * correct, a broken client is broken in the current hour too).
 */
export function routeOutcomeBucketKeys(hours: number, now: Date): string[] {
    const keys: string[] = [];
    for (let i = 0; i < hours; i++) {
        keys.push(routeOutcomeBucketKey(new Date(now.getTime() - i * 3600_000)));
    }
    return keys;
}

/**
 * Fold raw `HGETALL` results into one row per (method, route).
 *
 * Pure — the reader's whole interpretation step, separated so it can be
 * tested without Redis. Unparseable fields and non-numeric values are
 * dropped rather than throwing: a malformed field must not blind the
 * check to every other route in the same bucket.
 */
export function foldRouteOutcomeHashes(
    hashes: Array<Record<string, string>>,
): RouteOutcomeCounts[] {
    const byLabel = new Map<string, RouteOutcomeCounts>();

    for (const hash of hashes) {
        for (const [field, rawCount] of Object.entries(hash)) {
            const parsed = parseRouteOutcomeField(field);
            if (!parsed) continue;

            const count = Number(rawCount);
            if (!Number.isFinite(count) || count <= 0) continue;

            const label = `${parsed.method} ${parsed.route}`;
            let row = byLabel.get(label);
            if (!row) {
                row = { method: parsed.method, route: parsed.route, statusCounts: {} };
                byLabel.set(label, row);
            }
            row.statusCounts[parsed.status] = (row.statusCounts[parsed.status] ?? 0) + count;
        }
    }

    return [...byLabel.values()];
}

/** A folded window of request outcomes. */
export interface RouteOutcomeWindow {
    /**
     * False when Redis is not configured or the read failed — the window
     * is UNKNOWN, not empty. A caller must never read `routes: []` off a
     * failed probe as "nothing is broken".
     */
    available: boolean;
    /** Hours requested. */
    windowHours: number;
    /** Hourly buckets that actually returned data. */
    bucketsRead: number;
    /** One row per (method, route) seen in the window. */
    routes: RouteOutcomeCounts[];
}

/**
 * Read and fold the last `hours` hourly buckets.
 *
 * Never throws: a Redis failure comes back as `available: false`.
 */
export async function readRouteOutcomeWindow(options: {
    hours?: number;
    now?: Date;
} = {}): Promise<RouteOutcomeWindow> {
    const windowHours = options.hours ?? ROUTE_OUTCOME_WINDOW_HOURS;
    const now = options.now ?? new Date();

    const redis = getRedis();
    if (!redis) {
        return { available: false, windowHours, bucketsRead: 0, routes: [] };
    }

    const keys = routeOutcomeBucketKeys(windowHours, now);

    let hashes: Array<Record<string, string>>;
    try {
        const pipeline = redis.pipeline();
        for (const key of keys) pipeline.hgetall(key);
        const replies = await pipeline.exec();

        // ioredis returns `[error, result]` tuples, or null if the pipeline
        // itself produced nothing. Either is an unknown window.
        if (!replies) {
            return { available: false, windowHours, bucketsRead: 0, routes: [] };
        }

        hashes = [];
        for (const [err, result] of replies) {
            if (err) continue;
            if (result && typeof result === 'object') {
                hashes.push(result as Record<string, string>);
            }
        }
    } catch (err) {
        logger.warn('route-outcome window read failed', {
            component: 'route-outcomes',
            error: err instanceof Error ? err.message : String(err),
        });
        return { available: false, windowHours, bucketsRead: 0, routes: [] };
    }

    const nonEmpty = hashes.filter((h) => Object.keys(h).length > 0);

    return {
        available: true,
        windowHours,
        bucketsRead: nonEmpty.length,
        routes: foldRouteOutcomeHashes(nonEmpty),
    };
}
