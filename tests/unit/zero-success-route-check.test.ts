/**
 * Zero-success route check — detection logic + the Redis counters it reads.
 *
 * The regression class: an iOS client POSTed a body missing a required
 * field, `/api/t/{slug}/insurance/leads` 400'd on every call for weeks, and
 * nothing noticed because a route at a 100% failure rate looks exactly like
 * a route nobody calls.
 *
 * The load-bearing assertion in this file is therefore NOT "a failing route
 * is reported" — a rule that reported everything would pass that. It is the
 * pair: a route with only failures IS reported, and a route with even one
 * success is NOT, no matter how many failures sit beside it.
 */

// ── Redis fake ───────────────────────────────────────────────────────
// Names must start with `mock` — jest hoists `jest.mock` above the
// declarations and rejects other out-of-scope references.

type MockHash = Map<string, number>;

/** null ⇒ `getRedis()` returns null (no REDIS_URL). */
let mockStore: Map<string, MockHash> | null = new Map();
/** How the fake pipeline's `exec()` behaves. */
let mockExecMode: 'ok' | 'throw' | 'null' = 'ok';
/** Every `expire(key, ttl)` the code under test issued. */
let mockExpireCalls: Array<{ key: string; ttl: number }> = [];

jest.mock('@/lib/redis', () => ({
    getRedis: () => {
        if (mockStore === null) return null;
        const store = mockStore;
        return {
            pipeline() {
                const ops: Array<() => [Error | null, unknown]> = [];
                const api = {
                    hincrby(key: string, field: string, by: number) {
                        ops.push(() => {
                            const hash = store.get(key) ?? new Map<string, number>();
                            const next = (hash.get(field) ?? 0) + by;
                            hash.set(field, next);
                            store.set(key, hash);
                            return [null, next];
                        });
                        return api;
                    },
                    expire(key: string, ttl: number) {
                        ops.push(() => {
                            mockExpireCalls.push({ key, ttl });
                            return [null, 1];
                        });
                        return api;
                    },
                    hgetall(key: string) {
                        ops.push(() => {
                            const hash = store.get(key);
                            if (!hash) return [null, {}];
                            const out: Record<string, string> = {};
                            for (const [f, v] of hash) out[f] = String(v);
                            return [null, out];
                        });
                        return api;
                    },
                    async exec() {
                        if (mockExecMode === 'throw') throw new Error('redis down');
                        if (mockExecMode === 'null') return null;
                        return ops.map((op) => op());
                    },
                };
                return api;
            },
        };
    },
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { logger } from '@/lib/observability/logger';
import {
    ROUTE_OUTCOME_PREFIX,
    ROUTE_OUTCOME_TTL_SECONDS,
    foldRouteOutcomeHashes,
    parseRouteOutcomeField,
    readRouteOutcomeWindow,
    recordRouteOutcome,
    routeOutcomeBucketKey,
    routeOutcomeBucketKeys,
    routeOutcomeField,
    routeOutcomeLabel,
    type RouteOutcomeCounts,
} from '@/lib/observability/route-outcomes';
import {
    DEFAULT_MIN_FAILURES,
    detectZeroSuccessRoutes,
    runZeroSuccessRouteCheck,
} from '@/app-layer/jobs/zero-success-route-check';

const LEADS = '/api/t/:tenantSlug/insurance/leads';

function counts(
    method: string,
    route: string,
    statusCounts: Record<number, number>,
): RouteOutcomeCounts {
    return { method, route, statusCounts };
}

/** Drain the fire-and-forget pipeline `recordRouteOutcome` kicks off. */
async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    mockStore = new Map();
    mockExecMode = 'ok';
    mockExpireCalls = [];
    jest.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════════════
// Field encoding
// ═════════════════════════════════════════════════════════════════════

describe('route-outcome field encoding', () => {
    it('labels a route as METHOD + normalised path', () => {
        expect(routeOutcomeLabel('post', LEADS)).toBe(`POST ${LEADS}`);
    });

    it('collapses numeric path segments that normalizeRoute leaves alone', () => {
        // `normalizeRoute` only collapses UUIDs, the tenant slug and 20+ char
        // opaque ids — a short numeric id would otherwise grow one hash field
        // per entity.
        expect(routeOutcomeLabel('GET', '/api/t/:tenantSlug/parcels/1234')).toBe(
            'GET /api/t/:tenantSlug/parcels/:id',
        );
        expect(routeOutcomeLabel('GET', '/api/t/:tenantSlug/parcels/1234/soil')).toBe(
            'GET /api/t/:tenantSlug/parcels/:id/soil',
        );
    });

    it('caps a pathological route label', () => {
        const label = routeOutcomeLabel('GET', `/api/${'x'.repeat(500)}`);
        expect(label.length).toBeLessThanOrEqual(170);
    });

    it('keys a bucket by UTC hour', () => {
        const key = routeOutcomeBucketKey(new Date('2026-09-24T07:41:03.123Z'));
        expect(key).toBe(`${ROUTE_OUTCOME_PREFIX}:2026-09-24T07`);
        // Same hour, different minute ⇒ same bucket.
        expect(routeOutcomeBucketKey(new Date('2026-09-24T07:00:00.000Z'))).toBe(key);
        expect(routeOutcomeBucketKey(new Date('2026-09-24T08:00:00.000Z'))).not.toBe(key);
    });

    it('walks back one bucket per hour, newest first', () => {
        const keys = routeOutcomeBucketKeys(3, new Date('2026-09-24T07:41:00.000Z'));
        expect(keys).toEqual([
            `${ROUTE_OUTCOME_PREFIX}:2026-09-24T07`,
            `${ROUTE_OUTCOME_PREFIX}:2026-09-24T06`,
            `${ROUTE_OUTCOME_PREFIX}:2026-09-24T05`,
        ]);
    });

    it('round-trips status + method + route through a field', () => {
        const field = routeOutcomeField(400, routeOutcomeLabel('POST', LEADS));
        expect(field).toBe(`400|POST ${LEADS}`);
        expect(parseRouteOutcomeField(field)).toEqual({
            status: 400,
            method: 'POST',
            route: LEADS,
        });
    });

    it('rejects malformed fields instead of inventing a route', () => {
        for (const bad of [
            '',
            'POST /api/x',            // no status
            '|POST /api/x',           // empty status
            'abc|POST /api/x',        // non-numeric status
            '99|POST /api/x',         // below 100
            '600|POST /api/x',        // above 599
            '400|',                   // no label
            '400|GET',                // no space ⇒ no route
            '400| /api/x',            // empty method
            '400|GET ',               // empty route
        ]) {
            expect(parseRouteOutcomeField(bad)).toBeNull();
        }
    });
});

// ═════════════════════════════════════════════════════════════════════
// Recording
// ═════════════════════════════════════════════════════════════════════

describe('recordRouteOutcome', () => {
    it('is a silent no-op when Redis is not configured', async () => {
        mockStore = null;
        expect(() => recordRouteOutcome({ method: 'POST', route: LEADS, status: 400 })).not.toThrow();
        await flush();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('counts a request into the current hour bucket and sets a TTL', async () => {
        recordRouteOutcome({ method: 'POST', route: LEADS, status: 400 });
        recordRouteOutcome({ method: 'POST', route: LEADS, status: 400 });
        recordRouteOutcome({ method: 'GET', route: LEADS, status: 200 });
        await flush();

        const key = routeOutcomeBucketKey(new Date());
        const hash = mockStore!.get(key);
        expect(hash?.get(`400|POST ${LEADS}`)).toBe(2);
        expect(hash?.get(`200|GET ${LEADS}`)).toBe(1);

        expect(mockExpireCalls.length).toBeGreaterThan(0);
        for (const call of mockExpireCalls) {
            expect(call.key).toBe(key);
            expect(call.ttl).toBe(ROUTE_OUTCOME_TTL_SECONDS);
        }
    });

    it('is fed by recordRequestMetrics — the seam every API response passes through', async () => {
        // The counters are only worth reading if the request wrapper actually
        // writes them. `withApiErrorHandling` calls `recordRequestMetrics` on
        // every response (success, error and rate-limited), so THAT is the
        // wiring under test; deleting the recordRouteOutcome call inside it
        // would leave every other test in this file green and the feature
        // inert.
        const { recordRequestMetrics } = require('@/lib/observability/metrics');
        recordRequestMetrics({
            method: 'POST',
            route: '/api/t/acme-farm/insurance/leads',
            status: 400,
            durationMs: 12,
        });
        await flush();

        const hash = mockStore!.get(routeOutcomeBucketKey(new Date()));
        // Tenant slug collapsed by normalizeRoute before it is ever stored.
        expect(hash?.get(`400|POST ${LEADS}`)).toBe(1);
    });

    it('never rejects into the request path when Redis fails', async () => {
        mockExecMode = 'throw';
        expect(() => recordRouteOutcome({ method: 'POST', route: LEADS, status: 400 })).not.toThrow();
        await flush();
        expect(logger.warn).toHaveBeenCalledWith(
            'route-outcome counter write failed',
            expect.objectContaining({ component: 'route-outcomes' }),
        );
    });
});

// ═════════════════════════════════════════════════════════════════════
// Folding
// ═════════════════════════════════════════════════════════════════════

describe('foldRouteOutcomeHashes', () => {
    it('sums the same route across hourly buckets', () => {
        const folded = foldRouteOutcomeHashes([
            { [`400|POST ${LEADS}`]: '3', [`200|GET ${LEADS}`]: '1' },
            { [`400|POST ${LEADS}`]: '4', [`500|POST ${LEADS}`]: '2' },
        ]);

        expect(folded).toHaveLength(2);
        const post = folded.find((r) => r.method === 'POST')!;
        expect(post.route).toBe(LEADS);
        expect(post.statusCounts).toEqual({ 400: 7, 500: 2 });
        const get = folded.find((r) => r.method === 'GET')!;
        expect(get.statusCounts).toEqual({ 200: 1 });
    });

    it('drops a malformed field without losing its siblings', () => {
        const folded = foldRouteOutcomeHashes([
            { 'garbage': '9', [`400|POST ${LEADS}`]: '3', [`401|POST ${LEADS}`]: 'not-a-number' },
        ]);
        expect(folded).toHaveLength(1);
        expect(folded[0].statusCounts).toEqual({ 400: 3 });
    });

    it('returns nothing for an empty window', () => {
        expect(foldRouteOutcomeHashes([])).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════
// Reading
// ═════════════════════════════════════════════════════════════════════

describe('readRouteOutcomeWindow', () => {
    it('reports UNKNOWN (available:false), not an empty window, with no Redis', async () => {
        mockStore = null;
        const window = await readRouteOutcomeWindow({ hours: 24 });
        expect(window.available).toBe(false);
        expect(window.routes).toEqual([]);
    });

    it('reports UNKNOWN when the read throws', async () => {
        mockExecMode = 'throw';
        const window = await readRouteOutcomeWindow({ hours: 24 });
        expect(window.available).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith(
            'route-outcome window read failed',
            expect.objectContaining({ component: 'route-outcomes' }),
        );
    });

    it('reports UNKNOWN when the pipeline returns nothing', async () => {
        mockExecMode = 'null';
        const window = await readRouteOutcomeWindow({ hours: 24 });
        expect(window.available).toBe(false);
    });

    it('folds only the hours inside the window', async () => {
        const now = new Date('2026-09-24T07:30:00.000Z');
        mockStore!.set(
            `${ROUTE_OUTCOME_PREFIX}:2026-09-24T07`,
            new Map([[`400|POST ${LEADS}`, 5]]),
        );
        mockStore!.set(
            `${ROUTE_OUTCOME_PREFIX}:2026-09-24T06`,
            new Map([[`400|POST ${LEADS}`, 2]]),
        );
        // Three hours back — outside a 2-hour window.
        mockStore!.set(
            `${ROUTE_OUTCOME_PREFIX}:2026-09-24T04`,
            new Map([[`200|POST ${LEADS}`, 99]]),
        );

        const window = await readRouteOutcomeWindow({ hours: 2, now });
        expect(window.available).toBe(true);
        expect(window.bucketsRead).toBe(2);
        expect(window.routes).toHaveLength(1);
        expect(window.routes[0].statusCounts).toEqual({ 400: 7 });
    });
});

// ═════════════════════════════════════════════════════════════════════
// The detection rule
// ═════════════════════════════════════════════════════════════════════

describe('detectZeroSuccessRoutes', () => {
    it('reports a route whose every response failed', () => {
        const found = detectZeroSuccessRoutes([counts('POST', LEADS, { 400: 42 })]);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
            method: 'POST',
            route: LEADS,
            failures: 42,
            successes: 0,
            dominantStatus: 400,
        });
    });

    it('does NOT report a route with even one success beside its failures', () => {
        // The load-bearing case. A 99%-failure route is a bug report; only a
        // route that has NEVER succeeded is the "client cannot satisfy this
        // endpoint" shape this job hunts. A rule that dropped the
        // zero-success test would report this row.
        const found = detectZeroSuccessRoutes([counts('POST', LEADS, { 400: 500, 201: 1 })]);
        expect(found).toEqual([]);
    });

    it('treats any status below 400 as a success', () => {
        for (const ok of [200, 201, 204, 302, 304, 399]) {
            expect(
                detectZeroSuccessRoutes([counts('POST', LEADS, { 400: 50, [ok]: 1 })]),
            ).toEqual([]);
        }
        // …and 400 itself is a failure, not a success.
        expect(detectZeroSuccessRoutes([counts('POST', LEADS, { 400: 50 })])).toHaveLength(1);
    });

    it('does not report a route below the failure floor', () => {
        const belowFloor = DEFAULT_MIN_FAILURES - 1;
        expect(detectZeroSuccessRoutes([counts('POST', LEADS, { 404: belowFloor })])).toEqual([]);
        expect(
            detectZeroSuccessRoutes([counts('POST', LEADS, { 404: DEFAULT_MIN_FAILURES })]),
        ).toHaveLength(1);
    });

    it('honours an explicit minFailures', () => {
        expect(
            detectZeroSuccessRoutes([counts('POST', LEADS, { 400: 3 })], { minFailures: 10 }),
        ).toEqual([]);
        expect(
            detectZeroSuccessRoutes([counts('POST', LEADS, { 400: 3 })], { minFailures: 3 }),
        ).toHaveLength(1);
    });

    it('names the most common failure status, breaking ties to the lowest code', () => {
        const clear = detectZeroSuccessRoutes([counts('POST', LEADS, { 400: 2, 500: 9 })]);
        expect(clear[0].dominantStatus).toBe(500);

        // A tie must resolve deterministically rather than on key order.
        const tied = detectZeroSuccessRoutes([counts('POST', LEADS, { 500: 6, 422: 6 })]);
        expect(tied[0].dominantStatus).toBe(422);
        const tiedReversed = detectZeroSuccessRoutes([counts('POST', LEADS, { 422: 6, 500: 6 })]);
        expect(tiedReversed[0].dominantStatus).toBe(422);
    });

    it('sorts worst-first and caps the report', () => {
        const rows = [
            counts('GET', '/api/a', { 500: 10 }),
            counts('GET', '/api/b', { 500: 90 }),
            counts('GET', '/api/c', { 500: 50 }),
        ];
        const found = detectZeroSuccessRoutes(rows);
        expect(found.map((f) => f.route)).toEqual(['/api/b', '/api/c', '/api/a']);

        const capped = detectZeroSuccessRoutes(rows, { maxReported: 2 });
        expect(capped.map((f) => f.route)).toEqual(['/api/b', '/api/c']);
    });

    it('separates methods on the same path', () => {
        const found = detectZeroSuccessRoutes([
            counts('POST', LEADS, { 400: 30 }),
            counts('GET', LEADS, { 200: 30 }),
        ]);
        expect(found).toHaveLength(1);
        expect(found[0].method).toBe('POST');
    });

    it('reports nothing for an empty window', () => {
        expect(detectZeroSuccessRoutes([])).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════
// The job
// ═════════════════════════════════════════════════════════════════════

describe('runZeroSuccessRouteCheck', () => {
    const now = new Date('2026-09-24T07:30:00.000Z');

    function seed(hour: string, hash: Record<string, number>): void {
        mockStore!.set(`${ROUTE_OUTCOME_PREFIX}:${hour}`, new Map(Object.entries(hash)));
    }

    it('warns naming the offending route', async () => {
        seed('2026-09-24T07', { [`400|POST ${LEADS}`]: 120 });
        seed('2026-09-24T06', { [`200|GET ${LEADS}`]: 40 });

        const result = await runZeroSuccessRouteCheck({ windowHours: 24, now });

        expect(result.outcomeDataAvailable).toBe(true);
        expect(result.routesObserved).toBe(2);
        expect(result.findings.map((f) => `${f.method} ${f.route}`)).toEqual([`POST ${LEADS}`]);

        expect(logger.warn).toHaveBeenCalledWith(
            'api routes failing with zero successes',
            expect.objectContaining({
                component: 'zero-success-route-check',
                failingRouteCount: 1,
                failingRoutes: [`POST ${LEADS}`],
            }),
        );
        const fields = (logger.warn as jest.Mock).mock.calls[0][1];
        expect(fields.detail[0]).toMatchObject({
            method: 'POST',
            route: LEADS,
            failures: 120,
            successes: 0,
            dominantStatus: 400,
        });
    });

    it('logs clean — not a warning — when every observed route succeeded at least once', async () => {
        seed('2026-09-24T07', { [`400|POST ${LEADS}`]: 120, [`201|POST ${LEADS}`]: 1 });

        const result = await runZeroSuccessRouteCheck({ windowHours: 24, now });

        expect(result.findings).toEqual([]);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(
            'zero-success route check clean',
            expect.objectContaining({ component: 'zero-success-route-check', failingRouteCount: 0 }),
        );
    });

    it('says UNKNOWN, not clean, when the counters cannot be read', async () => {
        mockStore = null;
        const result = await runZeroSuccessRouteCheck({ windowHours: 24, now });

        expect(result.outcomeDataAvailable).toBe(false);
        // Never the clean line — `runJob` emits its own job started/completed
        // info pair, so this asserts the CHECK's verdict, not log silence.
        expect(logger.info).not.toHaveBeenCalledWith(
            'zero-success route check clean',
            expect.anything(),
        );
        expect(logger.warn).toHaveBeenCalledWith(
            'zero-success route check could not read request outcomes',
            expect.objectContaining({ reason: 'redis-unavailable' }),
        );
    });

    it('says UNKNOWN, not clean, when nothing was counted at all', async () => {
        const result = await runZeroSuccessRouteCheck({ windowHours: 24, now });

        expect(result.outcomeDataAvailable).toBe(true);
        expect(result.routesObserved).toBe(0);
        expect(logger.info).not.toHaveBeenCalledWith(
            'zero-success route check clean',
            expect.anything(),
        );
        expect(logger.warn).toHaveBeenCalledWith(
            'zero-success route check saw no request outcomes at all',
            expect.objectContaining({ reason: 'no-outcomes-recorded' }),
        );
    });

    it('reads what recordRouteOutcome wrote — the two halves agree on the encoding', async () => {
        // End to end through the real field encoding: a broken client and a
        // healthy one, counted by the recorder and read back by the job.
        for (let i = 0; i < 9; i++) {
            recordRouteOutcome({ method: 'POST', route: LEADS, status: 400 });
        }
        for (let i = 0; i < 4; i++) {
            recordRouteOutcome({ method: 'GET', route: '/api/t/:tenantSlug/parcels', status: 200 });
        }
        await flush();

        const result = await runZeroSuccessRouteCheck({ windowHours: 24 });

        expect(result.routesObserved).toBe(2);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]).toMatchObject({
            method: 'POST',
            route: LEADS,
            failures: 9,
            successes: 0,
        });
    });
});

// ═════════════════════════════════════════════════════════════════════
// Registration
// ═════════════════════════════════════════════════════════════════════

describe('zero-success-route-check registration', () => {
    it('has a JOB_DEFAULTS entry', () => {
        const { JOB_DEFAULTS } = require('@/app-layer/jobs/types');
        expect(JOB_DEFAULTS).toHaveProperty('zero-success-route-check');
        // One attempt: the window is rolling, so a retry only re-logs.
        expect(JOB_DEFAULTS['zero-success-route-check'].attempts).toBe(1);
    });

    it('is scheduled once a day', () => {
        const { SCHEDULED_JOBS } = require('@/app-layer/jobs/schedules');
        const entry = SCHEDULED_JOBS.find(
            (s: { name: string }) => s.name === 'zero-success-route-check',
        );
        expect(entry).toBeDefined();
        // `m h * * *` — a fixed hour every day.
        expect(entry.pattern).toMatch(/^\d+ \d+ \* \* \*$/);
        expect(entry.description).toBeTruthy();
    });
});
