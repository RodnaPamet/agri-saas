// k6 load-test scenario — authenticated list-read baseline.
//
// A single global login in setup() extracts the NextAuth session-token
// cookie and shares it via the setup→default data channel; every
// request re-attaches it explicitly. So we measure the steady-state
// list-read path rather than the cold login path (auth.js covers
// cold-login throughput separately).
//
// ## Why setup() and not a per-VU login
//
// This file used to log in once per VU at iteration 0, gated on a
// module-scope `loggedIn` flag, and trust the per-VU jar to carry the
// session onward. That does not work: **k6 resets the cookie jar
// between iterations**, but module state survives them. So the flag
// stayed true while the cookies vanished, and every iteration after
// the first ran unauthenticated — 401 on every list read, ~99% of the
// run, with exactly one success per VU.
//
// It went unnoticed because the lists step is `if:`-gated behind the
// auth step in load-test.yml, and auth had never passed: this scenario
// has never once executed in CI. mutations.js, ag-parcel-list.js and
// ag-inventory-pagination.js all carry a comment warning that the jar
// "does NOT reliably carry" the session across iterations — this file
// is simply the one that never got the fix, because nothing ran it.
//
// Per iteration each VU exercises the three highest-traffic list
// endpoints with realistic filter combinations:
//
//   GET /api/t/{slug}/evidence  — paged + filtered (status, archived)
//
// Run staged baselines:
//   k6 run -e VUS=50  -e DURATION=2m tests/load/lists.js
//   k6 run -e VUS=100 -e DURATION=2m tests/load/lists.js
//   k6 run -e VUS=200 -e DURATION=2m tests/load/lists.js
//
// The seed (`prisma/seed.ts`) creates a small but non-empty dataset
// in `acme-corp`: assets and templates.
// Run the same script against a heavier seed for realistic baselines
// — see tests/load/README.md.

import http from 'k6/http';
import exec from 'k6/execution';
import { check, group, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { textSummary } from './vendor/k6-summary.js';
import { loadConfig } from './lib/config.js';
import { login } from './lib/auth.js';

const cfg = loadConfig();

// Per-endpoint counters so the summary breaks throughput out by surface.
const evidenceRequests = new Counter('list_evidence_requests');
const listSuccessRate = new Rate('list_success_rate');
// Completed iterations, tagged by regime, so the saturation window
// carries a throughput floor (see READ_CAPACITY_FLOOR).
const listIterations = new Counter('list_iterations');

// Read throughput floor for the saturation window. Same construction
// as auth.js: a COUNT over a fixed-length window, derived from an
// observed rate rather than guessed. Reads are far cheaper than a
// login, so the floor is correspondingly higher.
const SATURATION_WINDOW_SEC = cfg.rampUpSec + cfg.durationSec + cfg.rampDownSec;
// Observed on a shared dev box under load average 19: 1076 iterations
// (3 list reads each) over a 105s window ≈ 10.2 iterations/s. A
// dedicated CI runner is faster, so this is the pessimistic end.
const MEASURED_ITERATIONS_PER_SEC = 10;
// Same 0.3 factor, and the same reasoning, as auth.js's CAPACITY_FLOOR:
// a collapse detector rather than a precision gate, because throughput
// on a shared runner swings with the host's load average. Precision
// lives in the summary artifact; the latency regime is the sensitive
// detector.
const READ_CAPACITY_FLOOR = Math.floor(SATURATION_WINDOW_SEC * MEASURED_ITERATIONS_PER_SEC * 0.3);

export const options = {
    scenarios: {
        // ── Regime 1: uncontended cost of a list read ──
        // Same rationale as auth.js: at the nightly's 25 VUs a single
        // Node process is deep enough into its queue that p95 tracks
        // the arrival rate, not the query. Measured here: ~25ms
        // uncontended vs ~1.0s at 25 VUs — a 40x queueing artifact.
        // Latency is therefore gated HERE and nowhere else.
        list_latency: {
            executor: 'constant-vus',
            vus: cfg.latencyVus,
            duration: `${cfg.latencySeconds}s`,
            tags: { regime: 'latency' },
            gracefulStop: '30s',
        },

        // ── Regime 2: sustained read load ──
        list_saturation: {
            executor: 'ramping-vus',
            startTime: `${cfg.latencySeconds + 10}s`,
            startVUs: 0,
            stages: [
                { duration: cfg.rampUp, target: cfg.vus },
                { duration: cfg.duration, target: cfg.vus },
                { duration: cfg.rampDown, target: 0 },
            ],
            tags: { regime: 'saturation' },
            gracefulRampDown: '30s',
            gracefulStop: '30s',
        },
    },
    thresholds: {
        // ── Correctness, in BOTH regimes ──
        // Read-path error budget. Anything above 1% is a real problem.
        'http_req_failed{type:list}': ['rate<0.01'],
        list_success_rate: ['rate>0.99'],
        'checks{check:evidence_ok}': ['rate>0.99'],

        // Login-step health (gate the warm-up, not the steady state).
        'http_req_failed{step:login}': ['rate<0.05'],

        // ── Latency: ONLY in the uncontended regime ──
        // p95 < 800ms covers a healthy DB-backed paginated list with
        // auth + tenant-RLS overhead, and is the figure docs/slos.md
        // publishes for the read path. Measured uncontended p95 on a
        // loaded dev box: evidence
        // 49.0ms — so the budget carries ~8x headroom. Deliberately
        // NOT tightened to the measurement: 800ms is the published
        // read SLO, and this gate exists to catch a regression that
        // breaches it, not to pin the current number.
        'http_req_duration{regime:latency,endpoint:evidence}': ['p(95)<800', 'p(99)<2000'],

        // ── Capacity: ONLY in the saturated regime ──
        'list_iterations{regime:saturation}': [`count>${READ_CAPACITY_FLOOR}`],

        // NOTE: no http_req_duration threshold on {regime:saturation} —
        // see the auth.js docblock for why gating latency on a
        // saturated single process asserts against our own load
        // profile rather than against the code.
    },
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    discardResponseBodies: false,
};

// Realistic filter sets — rotated per iteration so we don't hammer
// a single query plan. Covers: empty filter, narrow text search, and
// status/score-band filters that exercise different index paths.

const EVIDENCE_FILTERS = [
    'limit=50',
    'limit=50&status=APPROVED',
    'limit=50&archived=false',
    'limit=50&expiring=true',
    'limit=20&q=audit',
];

function pickFilter(filters, iter) {
    return filters[iter % filters.length];
}

// Single global login — extract the session-token cookie and share it
// via the setup→default data channel (mirrors mutations.js and
// ag-parcel-list.js). Never trust the per-VU jar to carry it across
// iterations; see the docblock.
export function setup() {
    const ok = login(cfg);
    if (!ok) {
        throw new Error(
            'lists.js setup login failed — refusing to run the read baseline without a session. ' +
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

export default function listsIteration(data) {
    const iter = __ITER;
    // Which regime this iteration belongs to — drives the metric tag
    // the regime-scoped thresholds address.
    const regime = exec.scenario.name === 'list_latency' ? 'latency' : 'saturation';
    const base = `${cfg.baseUrl}/api/t/${cfg.tenant}`;
    // Re-attach the shared session cookie on every request.
    const auth = { cookies: { [data.tokenName]: data.tokenValue } };


    group('list:evidence', () => {
        const url = `${base}/evidence?${pickFilter(EVIDENCE_FILTERS, iter)}`;
        const r = http.get(url, {
            ...auth,
            tags: { type: 'list', endpoint: 'evidence' },
        });
        const ok = check(
            r,
            {
                'evidence 200': (res) => res.status === 200,
                'evidence is JSON': (res) => {
                    try {
                        const j = res.json();
                        return Array.isArray(j) || typeof j === 'object';
                    } catch (_e) {
                        return false;
                    }
                },
            },
            { check: 'evidence_ok' },
        );
        evidenceRequests.add(1);
        listSuccessRate.add(ok);
    });

    listIterations.add(1, { regime });

    // 250ms think-time per iteration. With 50 VUs this is ~200 RPS
    // across all three endpoints (~67 RPS each). Tune via DURATION
    // or by adjusting this sleep if you want sharper or softer load.
    sleep(0.25);
}

export function handleSummary(data) {
    return {
        stdout: textSummary(data, { indent: ' ', enableColors: true }),
        'tests/load/results/lists-summary.json': JSON.stringify(data, null, 2),
    };
}
