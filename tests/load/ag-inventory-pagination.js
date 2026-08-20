// k6 load-test scenario — authenticated inventory-lot cursor pagination
// baseline ("ag-inventory-pagination").
//
// A single global login in setup() extracts the NextAuth session-token
// cookie and hands it to every VU via the setup→default data channel;
// each request re-attaches it explicitly (`cookies: { … }`). This mirrors
// mutations.js — the per-VU cookie jar does NOT reliably carry the
// session-token across iterations under `next start`, so we never rely
// on it. We measure the steady-state paged-read path, not the cold login.
//
// Design profile: "10 operators × 10k-lot location, p95<500ms". The
// realistic access pattern is an operator scrolling a large field's
// inventory page-by-page, so each iteration WALKS THE CURSOR:
//
//   GET /api/t/{slug}/inventory/lots?limit=50
//     → { items, pageInfo: { nextCursor, hasNextPage } }
//   while hasNextPage (up to ~3 pages):
//     GET /api/t/{slug}/inventory/lots?limit=50&cursor={nextCursor}
//
// The cursor-page walk is what an operator paging a 10k-lot field
// actually does; the p95<500ms budget below gates the per-request
// latency of that walk. CI runs it at VUS=10 / 30s against the seed
// — so the threshold mechanism gates without needing 10k seeded rows
// (the small seed just won't fill the full 3-page walk every time).
//
// Requires the INVENTORY module (enabled by default for the seed
// tenant `acme-corp`).
//
// Run staged baselines:
//   k6 run -e VUS=10  -e DURATION=2m tests/load/ag-inventory-pagination.js
//   k6 run -e VUS=50  -e DURATION=2m tests/load/ag-inventory-pagination.js
//   k6 run -e VUS=100 -e DURATION=2m tests/load/ag-inventory-pagination.js
//
// See tests/load/README.md for running against a heavier seed.

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { textSummary } from './vendor/k6-summary.js';
import { loadConfig } from './lib/config.js';
import { login } from './lib/auth.js';

const cfg = loadConfig();

// Page size per request and the max pages a single VU iteration walks
// — a realistic operator paging through a large field's lot list.
const PAGE_SIZE = 50;
const MAX_PAGES = 3;

// Per-endpoint counters so the summary breaks throughput out by surface.
const lotsRequests = new Counter('inventory_lots_requests');
const listSuccessRate = new Rate('list_success_rate');

export const options = {
    scenarios: {
        inventory_pagination_baseline: {
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

        // THE ag-inventory-pagination p95<500ms budget — the per-request
        // latency of a cursor-page walk over a large lot list. p99 caps
        // the long tail so a slow-path regression also fails CI.
        'http_req_duration{endpoint:inventory_lots}': ['p(95)<500', 'p(99)<1500'],

        // Aggregate success rate across every paged request.
        list_success_rate: ['rate>0.99'],

        // Per-endpoint check rate.
        // `check` is a tag k6 sets ITSELF to the individual check's name, so
        // the tag passed to `check()` never bound and this sub-metric had
        // ZERO samples — which k6 passes. See tests/guards/k6-threshold-binding.
        // `count>0` is what makes the rename verifiable: without it the gate
        // cannot tell "everything passed" from "nothing ran".
        'checks{check_group:inventory_lots_ok}': ['rate>0.99', 'count>0'],

        // Login-step health (gate the warm-up, not the steady state).
        'http_req_failed{step:login}': ['rate<0.05'],
    },
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    discardResponseBodies: false,
};

// One paged GET against the lots endpoint. Tags + checks every request
// uniformly so the threshold covers the whole cursor walk. Returns the
// nextCursor if the page reports hasNextPage, else null.
function fetchLotsPage(base, cursor, auth) {
    const url = cursor
        ? `${base}/inventory/lots?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
        : `${base}/inventory/lots?limit=${PAGE_SIZE}`;
    const r = http.get(url, {
        ...auth,
        tags: { type: 'list', endpoint: 'inventory_lots' },
    });
    const ok = check(
        r,
        {
            'inventory_lots 200': (res) => res.status === 200,
            'inventory_lots items is array': (res) => {
                try {
                    const body = res.json();
                    return Array.isArray(body.items);
                } catch (_e) {
                    return false;
                }
            },
        },
        { check_group: 'inventory_lots_ok' },
    );
    lotsRequests.add(1);
    listSuccessRate.add(ok);

    if (!ok) return null;
    try {
        const body = r.json();
        if (body.pageInfo && body.pageInfo.hasNextPage) {
            return body.pageInfo.nextCursor || null;
        }
    } catch (_e) {
        return null;
    }
    return null;
}

// Single global login — extract the session-token cookie and share it
// via the setup→default data channel (mirrors mutations.js). Never
// trust the per-VU jar to carry it across iterations.
export function setup() {
    const ok = login(cfg);
    if (!ok) {
        throw new Error(
            'ag-inventory-pagination.js setup login failed — refusing to run the read smoke without a session. ' +
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

export default function inventoryPaginationIteration(data) {
    const base = `${cfg.baseUrl}/api/t/${cfg.tenant}`;
    // Re-attach the shared session cookie on every paged request.
    const auth = { cookies: { [data.tokenName]: data.tokenValue } };

    group('inventory:lots-cursor-walk', () => {
        // Walk the cursor: first page, then follow nextCursor for up to
        // MAX_PAGES total — simulating an operator paging a large field.
        let cursor = null;
        for (let page = 0; page < MAX_PAGES; page++) {
            cursor = fetchLotsPage(base, cursor, auth);
            if (!cursor) break;
        }
    });

    // 250ms think-time per iteration. With 10 VUs this keeps the cursor
    // walk at an operator-realistic cadence. Tune via DURATION or by
    // adjusting this sleep if you want sharper or softer load.
    sleep(0.25);
}

export function handleSummary(data) {
    return {
        stdout: textSummary(data, { indent: ' ', enableColors: true }),
        'tests/load/results/ag-inventory-pagination-summary.json': JSON.stringify(data, null, 2),
    };
}
