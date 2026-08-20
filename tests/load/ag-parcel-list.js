// k6 load-test scenario — authenticated parcel/field list-read baseline
// ("ag-parcel-list").
//
// A single global login in setup() extracts the NextAuth session-token
// cookie and hands it to every VU via the setup→default data channel;
// each request re-attaches it explicitly (`cookies: { … }`). This mirrors
// mutations.js — the per-VU cookie jar does NOT reliably carry the
// session-token across iterations under `next start`, so we never rely
// on it. We measure the steady-state list-read path, not the cold login.
//
// The surface under test is the parcel/field list — `locations` are
// the fields that hold parcels:
//
//   GET /api/t/{slug}/locations  — cursor-paged + filtered (status, q)
//
// returning `{ items, pageInfo: { nextCursor, hasNextPage } }`.
//
// Design budget: p95 < 500ms for the parcel-list surface. The realistic
// "10 operators × large field" profile is reached by running this at
// `-e VUS=10` against a heavy seed — but the threshold below gates
// EVERY run, so a latency regression fails CI even at the small
// CI/smoke seed (it just won't be the full-scale stress profile there).
//
// Run staged baselines:
//   k6 run -e VUS=10  -e DURATION=2m tests/load/ag-parcel-list.js
//   k6 run -e VUS=50  -e DURATION=2m tests/load/ag-parcel-list.js
//   k6 run -e VUS=100 -e DURATION=2m tests/load/ag-parcel-list.js
//
// The seed (`prisma/seed.ts`) creates a small but non-empty dataset
// in `acme-corp`. Run the same script against a heavier seed for
// realistic baselines — see tests/load/README.md.

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { textSummary } from './vendor/k6-summary.js';
import { loadConfig } from './lib/config.js';
import { login } from './lib/auth.js';

const cfg = loadConfig();

// Per-endpoint counters so the summary breaks throughput out by surface.
const locationsRequests = new Counter('list_locations_requests');
const listSuccessRate = new Rate('list_success_rate');

export const options = {
    scenarios: {
        parcel_list_baseline: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: cfg.rampUp, target: cfg.vus },
                { duration: cfg.duration, target: cfg.vus },
                { duration: cfg.rampDown, target: 0 },
            ],
            gracefulRampDown: '30s',
            gracefulStop: '30s',
        },
    },
    thresholds: {
        // Read-path error budget. Anything above 1% is a real problem.
        'http_req_failed{type:list}': ['rate<0.01'],

        // The ag-parcel-list p95<500ms budget. p99 caps the long tail
        // so a regression in the slow path also fails CI.
        'http_req_duration{endpoint:locations}': ['p(95)<500', 'p(99)<1500'],

        // Aggregate success rate across the parcel-list endpoint.
        list_success_rate: ['rate>0.99'],

        // Per-endpoint check rate.
        // `check` is a tag k6 sets ITSELF to the individual check's name, so
        // the tag passed to `check()` never bound and this sub-metric had
        // ZERO samples — which k6 passes. See tests/guards/k6-threshold-binding.
        // `count>0` is what makes the rename verifiable: without it the gate
        // cannot tell "everything passed" from "nothing ran".
        'checks{check_group:locations_ok}': ['rate>0.99', 'count>0'],

        // Login-step health (gate the warm-up, not the steady state).
        'http_req_failed{step:login}': ['rate<0.05'],
    },
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    discardResponseBodies: false,
};

// Realistic filter sets — rotated per iteration so we don't hammer
// a single query plan. Covers: empty filter, status filter, narrow
// text search, an explicit page size, and a combined status+text
// filter that exercises a different index path.
const LOCATIONS_FILTERS = [
    '',
    'status=ACTIVE',
    'q=farm',
    'limit=50',
    'status=ACTIVE&q=field',
];

function pickFilter(filters, iter) {
    return filters[iter % filters.length];
}

// Single global login — extract the session-token cookie and share it
// via the setup→default data channel (mirrors mutations.js). Never
// trust the per-VU jar to carry it across iterations.
export function setup() {
    const ok = login(cfg);
    if (!ok) {
        throw new Error(
            'ag-parcel-list.js setup login failed — refusing to run the read smoke without a session. ' +
            'Verify the SUT is up at ' + cfg.baseUrl + ' with AUTH_TEST_MODE=1.',
        );
    }
    const cookies = http.cookieJar().cookiesForURL(cfg.baseUrl);
    const tokenName = cookies['next-auth.session-token']
        ? 'next-auth.session-token'
        : '__Secure-next-auth.session-token';
    const tokenArr = cookies[tokenName];
    if (!Array.isArray(tokenArr) || tokenArr.length === 0) {
        throw new Error('login succeeded but no session cookie surfaced in the jar');
    }
    return { tokenName, tokenValue: tokenArr[0] };
}

export default function parcelListIteration(data) {
    const iter = __ITER;
    const base = `${cfg.baseUrl}/api/t/${cfg.tenant}`;
    // Re-attach the shared session cookie on every request.
    const auth = { cookies: { [data.tokenName]: data.tokenValue } };

    group('list:locations', () => {
        const qs = pickFilter(LOCATIONS_FILTERS, iter);
        const url = qs ? `${base}/locations?${qs}` : `${base}/locations`;
        const r = http.get(url, {
            ...auth,
            tags: { type: 'list', endpoint: 'locations' },
        });
        const ok = check(
            r,
            {
                'locations 200': (res) => res.status === 200,
                'locations is JSON': (res) => {
                    try {
                        const j = res.json();
                        // Shape can be an array (bare GET) or
                        // { items, pageInfo } (paginated). Both valid.
                        return Array.isArray(j) || typeof j === 'object';
                    } catch (_e) {
                        return false;
                    }
                },
            },
            { check_group: 'locations_ok' },
        );
        locationsRequests.add(1);
        listSuccessRate.add(ok);
    });

    // 250ms think-time per iteration. With 10 VUs this is ~40 RPS on
    // the parcel-list endpoint. Tune via DURATION or by adjusting this
    // sleep if you want sharper or softer load.
    sleep(0.25);
}

export function handleSummary(data) {
    return {
        stdout: textSummary(data, { indent: ' ', enableColors: true }),
        'tests/load/results/ag-parcel-list-summary.json': JSON.stringify(data, null, 2),
    };
}
