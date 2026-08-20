// k6 load-test scenario — authentication baseline.
//
// Exercises the full NextAuth v4 credentials login so we can baseline
// the auth path. Each iteration uses a FRESH per-iteration cookie jar,
// so every iteration is a real cold login (csrf → callback/credentials
// → session), never a session reuse.
//
// ## Two regimes, because one number cannot answer both questions
//
// A login is bcrypt-bound, and `bcryptjs` is pure JavaScript running on
// the Node main thread — so the whole process serves ONE compare at a
// time and extra cores do not help. Measured at BCRYPT_COST=12:
//
//     serial bcrypt.compare      ~405 ms
//     process login capacity     ~2.4 logins/s
//
// That capacity is remarkably portable: a 4-core CI runner and an
// 8-core dev box both land at ~2.4/s, because the bound is single-core
// speed, not core count.
//
// The consequence is that a latency threshold under heavy concurrency
// measures THE ARRIVAL RATE YOU CHOSE, not the code. At 25 VUs the
// offered load is ~10x capacity, so by Little's Law p95 ≈ VUs/capacity
// ≈ 10s no matter how good the login path is. This is exactly how the
// old single-scenario version of this file came to fail 40 consecutive
// nightly runs while every functional check passed: it asserted
// p95 < 1500ms against a queue ~7x deeper than that budget allows.
//
// So the scenarios are split, and each is gated only on what it can
// actually measure:
//
//   login_latency     1 VU, no think-time. Never more than one login
//                     in flight ⇒ zero queueing ⇒ http_req_duration is
//                     pure service time. THIS is the latency gate, and
//                     the real regression detector: anything that makes
//                     a login more expensive (work factor, an extra
//                     query, a new middleware hop) moves it directly.
//
//   login_saturation  the thundering herd (ramping VUs, 1s think-time)
//                     — SSO-outage recovery, mass password reset. Gated
//                     on error rate, check rate, and a completed-login
//                     COUNT floor (capacity). Deliberately NOT gated on
//                     latency; see above.
//
// The two run SEQUENTIALLY — login_saturation starts after
// login_latency has finished and drained. Overlapping them would put
// the latency regime behind the herd's queue and reproduce the exact
// measurement error this split exists to remove.
//
// Run baselines:
//   k6 run -e VUS=50  -e DURATION=2m tests/load/auth.js
//   k6 run -e VUS=100 -e DURATION=2m tests/load/auth.js
//   k6 run -e VUS=200 -e DURATION=2m tests/load/auth.js
//
// Required env on the SUT:
//   AUTH_TEST_MODE=1      — disables the progressive-lockout policy
//                           (3 fails = 5s, 5 = 30s, 10 = 15min lock).
//                           Bcrypt is the bottleneck under load and
//                           the lockout would otherwise kill the run.
//   RATE_LIMIT_ENABLED=0  — bypasses the API rate-limit middleware
//                           so auth endpoint latency reflects only
//                           the auth path itself, not the limiter.
//
// See tests/load/README.md for the full runbook.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { textSummary } from './vendor/k6-summary.js';
import { loadConfig } from './lib/config.js';

const cfg = loadConfig();

// Custom end-to-end latency metric — k6's built-in http_req_duration
// is per-request; we want one number for the whole login transaction.
const authFullLoginMs = new Trend('auth_full_login_ms', true);
const authSuccessCount = new Counter('auth_success_count');
const authFailureCount = new Counter('auth_failure_count');

// ── Capacity floor for the saturation window ───────────────────────
// Derived from the measured per-login cost, not guessed. The server
// saturates within the first second or two of the ramp, so throughput
// sits at capacity for essentially the whole window.
const SATURATION_WINDOW_SEC = cfg.rampUpSec + cfg.durationSec + cfg.rampDownSec;
// End-to-end completed logins per second under saturation, as OBSERVED
// (not as derived from the bare bcrypt cost — a login also pays a
// PII-decrypting user lookup, a UserSession insert and JWT signing on
// the same single thread, so it lands below the ~2.4/s bcrypt ceiling):
//     CI runner, 25 VUs x 105s   259 logins   2.47/s
//     dev box (shared, loaded)   176 logins   1.68/s
// The gate runs in CI, so the CI figure sets the line and the margin
// below absorbs the dev-box spread.
const MEASURED_LOGINS_PER_SEC = 2.4;
// This is a COLLAPSE detector, not a precision capacity gate, and the
// factor is set that low deliberately. Throughput on a shared runner
// is not a precise instrument: two back-to-back runs of this file on
// the same dev box returned 176 and then 113 completed logins purely
// because the host's load average climbed. On a noisy neighbour a 2x
// throughput drop is indistinguishable from a 2x code regression, so
// gating tightly here would just re-introduce a flaky red — the thing
// this whole change set exists to remove.
//
// So the floor sits at ~30% of the CI line: it stays quiet through
// host noise (the worst observed dev-box run still cleared it by 50%)
// and fires only on an unambiguous collapse — a work factor raised
// several notches, a lock serialising the auth path, a broken
// connection pool. Precision belongs to the trend, not the gate: the
// per-run figure is written to the summary artifact, and the LATENCY
// regime above is the sensitive detector.
const CAPACITY_FLOOR = Math.floor(SATURATION_WINDOW_SEC * MEASURED_LOGINS_PER_SEC * 0.3);

export const options = {
    scenarios: {
        // ── Regime 1: uncontended cost of one login ──
        login_latency: {
            executor: 'constant-vus',
            vus: cfg.latencyVus,
            duration: `${cfg.latencySeconds}s`,
            exec: 'latencyIteration',
            tags: { regime: 'latency' },
            gracefulStop: '30s',
        },

        // ── Regime 2: thundering-herd capacity + resilience ──
        login_saturation: {
            executor: 'ramping-vus',
            // +10s so regime 1 has fully drained before the herd
            // starts; a 1-VU serial loop settles well inside that.
            startTime: `${cfg.latencySeconds + 10}s`,
            startVUs: 0,
            stages: [
                { duration: cfg.rampUp, target: cfg.vus },
                { duration: cfg.duration, target: cfg.vus },
                { duration: cfg.rampDown, target: 0 },
            ],
            exec: 'saturationIteration',
            tags: { regime: 'saturation' },
            gracefulRampDown: '30s',
            gracefulStop: '30s',
        },
    },

    // Hard pass/fail gates. A failed threshold marks the run as failed
    // (non-zero exit code in CI), even if individual checks pass.
    thresholds: {
        // ── Correctness, in BOTH regimes ──
        // Overload is not a licence to error. Under 10x capacity the
        // system must still queue cleanly rather than 5xx or drop.
        'http_req_failed{step:csrf}': ['rate<0.01'],
        'http_req_failed{step:login}': ['rate<0.01'],
        'http_req_failed{step:session}': ['rate<0.01'],
        // ── Check-group correctness ──
        // `count>0` is NOT decoration. These three thresholds were
        // previously keyed `checks{check:...}`, and `check` is a tag k6
        // sets ITSELF to the individual check's NAME — so the tag passed
        // to `check()` never survived, every sub-metric had ZERO samples,
        // and k6 passes a threshold with no samples. Measured across 11
        // nightly artifacts: parent `checks` 2,340 samples per run, these
        // three 0 every time, all reporting ok. They had never once been
        // evaluated against data.
        //
        // The rename to `check_group` is the fix; `count>0` is what makes
        // the fix VERIFIABLE. k6 is not installable in the dev loop here,
        // so if the tag still fails to bind, the next nightly goes RED
        // instead of quietly green again. Do not remove it — without it
        // this gate cannot tell "everything passed" from "nothing ran".
        'checks{check_group:csrf_ok}': ['rate>0.99', 'count>0'],
        'checks{check_group:login_ok}': ['rate>0.99', 'count>0'],
        'checks{check_group:session_ok}': ['rate>0.99', 'count>0'],

        // ── Latency: ONLY in the uncontended regime ──
        // Service-time budgets calibrated against a real run rather
        // than guessed (see docs/slos.md → "Calibrating the auth
        // budgets"). Originally set from 97 uncontended DEV-BOX
        // samples: csrf 13.8ms, session 21.8ms, login 793.8ms, E2E
        // 839.2ms — with a note asking for re-validation against CI
        // once a few nightlies had landed.
        //
        // RE-VALIDATED 2026-08-20 against 11 consecutive nightly runs
        // (2026-08-10 → 08-20, ids 31357197165 … 32330454008), reading
        // the {regime:latency} sub-metrics out of each auth-summary.json:
        //
        //   metric        CI p95 range     mean    budget   headroom
        //   csrf           3.0 –   4.7      3.9     500ms      106x
        //   session        5.6 –   8.6      7.3     500ms       58x
        //   login p95    295.0 – 403.6    355.0    1500ms      3.7x
        //   login p99    300.7 – 432.2    385.2    2500ms      5.8x
        //   E2E p95      303.0 – 413.0    365.1    2000ms      4.8x
        //
        // Worst SINGLE login sample in the whole set: 763ms.
        //
        // The first version of this note said "all 143 auth threshold
        // results across those 11 runs reported ok". True, and
        // misleading: 33 of those 143 were the three `checks{check:...}`
        // thresholds, which had ZERO samples and passed vacuously (see
        // the check-group block below). The 110 that carried data all
        // reported ok; the other 33 reported nothing at all.
        //
        // NO NUMBER MOVED, deliberately — and note what that means for
        // the "~2x" the paragraph above used to claim. On CI the ratios
        // are 3.7x–106x, not 2x: the dev-box figures were inflated by
        // host load (three runs put login p95 at 794/1150/1170ms on the
        // same box, same build). So these are NOT tight regression
        // detectors and are not meant to be. They are SLO-CONFORMANCE
        // gates: 1500ms is the login budget docs/slos.md publishes, and
        // the gate sits on the stated SLO rather than being fitted to
        // whatever machine last ran it. Tightening to fit CI would
        // flake on a dev box while catching nothing extra in CI.
        //
        // The accepted cost of that choice, stated plainly: a
        // BCRYPT_COST 12 -> 14 bump (~4x) still trips 1500ms; a 12 -> 13
        // (~2x) would not. If we ever want that sensitivity the right
        // instrument is a run-over-run delta check on the summary
        // artifact, not a lower absolute budget — a different gate, and
        // a different issue.
        'http_req_duration{regime:latency,step:csrf}': ['p(95)<500'],
        'http_req_duration{regime:latency,step:login}': ['p(95)<1500', 'p(99)<2500'],
        'http_req_duration{regime:latency,step:session}': ['p(95)<500'],
        'auth_full_login_ms{regime:latency}': ['p(95)<2000', 'p(99)<3000'],

        // ── Capacity: ONLY in the saturated regime ──
        // A COUNT over a fixed-length window, which is a throughput
        // assertion that — unlike a k6 `rate` threshold, which divides
        // by TOTAL test duration — is not diluted by the other
        // scenario's share of the run.
        'auth_success_count{regime:saturation}': [`count>${CAPACITY_FLOOR}`],

        // NOTE: there is deliberately NO http_req_duration threshold on
        // {regime:saturation}. Under overload, latency is set by the
        // arrival rate this file chooses, not by the code under test;
        // gating it would assert against our own load profile. The
        // observed saturation latency still reaches the summary
        // artifact for trend tracking.
    },
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    // Cookie jar isolation: each iteration creates its own jar inside
    // the iteration function so we measure cold-start login every time.
    discardResponseBodies: false,
};

/**
 * One cold login: csrf → callback/credentials → session.
 * Shared by both regimes so they exercise byte-identical code; only
 * the pacing around it differs.
 *
 * @param {string} regime tag applied to the custom metrics, so the
 *                        thresholds above can address each regime.
 */
function coldLogin(regime) {
    // Per-iteration jar — guarantees no carry-over from a previous
    // iteration's session cookie. This is what makes the run a real
    // login test rather than a session-reuse test.
    const jar = http.cookieJar();
    const params = { jar };

    const t0 = Date.now();

    // ── 1. CSRF token ──
    const csrfRes = http.get(`${cfg.baseUrl}/api/auth/csrf`, {
        ...params,
        tags: { step: 'csrf' },
    });
    const csrfOk = check(
        csrfRes,
        {
            'csrf 200': (r) => r.status === 200,
            'csrf has token': (r) => {
                try {
                    const t = r.json('csrfToken');
                    return typeof t === 'string' && t.length > 0;
                } catch (_e) {
                    return false;
                }
            },
        },
        { check_group: 'csrf_ok' },
    );
    if (!csrfOk) {
        authFailureCount.add(1, { regime });
        return;
    }
    const csrfToken = csrfRes.json('csrfToken');

    // ── 2. POST credentials ──
    const loginRes = http.post(
        `${cfg.baseUrl}/api/auth/callback/credentials`,
        {
            csrfToken,
            email: cfg.email,
            password: cfg.password,
            callbackUrl: `${cfg.baseUrl}/dashboard`,
            json: 'true',
        },
        { ...params, tags: { step: 'login' } },
    );
    const loginOk = check(
        loginRes,
        {
            'login 2xx': (r) => r.status >= 200 && r.status < 400,
            'login no error url': (r) => {
                try {
                    const u = r.json('url');
                    return typeof u === 'string' && !u.includes('error=');
                } catch (_e) {
                    return false;
                }
            },
        },
        { check_group: 'login_ok' },
    );
    if (!loginOk) {
        authFailureCount.add(1, { regime });
        return;
    }

    // ── 3. Verify session is live ──
    const sessionRes = http.get(`${cfg.baseUrl}/api/auth/session`, {
        ...params,
        tags: { step: 'session' },
    });
    const sessionOk = check(
        sessionRes,
        {
            'session 200': (r) => r.status === 200,
            'session has user': (r) => {
                try {
                    const email = r.json('user.email');
                    return typeof email === 'string' && email.length > 0;
                } catch (_e) {
                    return false;
                }
            },
        },
        { check_group: 'session_ok' },
    );

    if (sessionOk) {
        authSuccessCount.add(1, { regime });
        authFullLoginMs.add(Date.now() - t0, { regime });
    } else {
        authFailureCount.add(1, { regime });
    }
}

/**
 * Regime 1 — uncontended. No think-time: with `latencyVus` (default 1)
 * VUs looping back-to-back, concurrency is exactly that number, so a
 * request never waits behind another login. Think-time here would only
 * reduce the sample count, not the contention — there isn't any.
 */
export function latencyIteration() {
    coldLogin('latency');
}

/**
 * Regime 2 — saturated. 1s think-time per VU, so with 50 VUs the
 * OFFERED load is ~50 logins/s against a ~2.4/s server: a deliberate
 * ~20x overload standing in for a thundering-herd login burst.
 */
export function saturationIteration() {
    coldLogin('saturation');
    sleep(1);
}

export function handleSummary(data) {
    return {
        stdout: textSummary(data, { indent: ' ', enableColors: true }),
        'tests/load/results/auth-summary.json': JSON.stringify(data, null, 2),
    };
}
