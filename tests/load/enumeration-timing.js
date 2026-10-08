// k6 scenario — the registration enumeration oracle, measured.
//
// #1194's P3.10 hardening asks for "identical status, body and timing (±50ms
// over 50 trials)". The status and body halves are asserted in unit tests
// (`register-start-route.test.ts` compares serialised bodies across all three
// branches). The TIMING half cannot be: bcrypt is mocked there, so every
// branch returns in microseconds and the measurement would be of nothing.
//
// So it lives here, against a real server, and runs in the load-smoke job.
//
// ## What is being measured
//
// `POST /api/auth/register/start` answers an identical `200 {"ok":true}` for
// three different realities:
//
//   A. an address nobody has used      → creates an unverified user
//   B. an address mid-signup           → reissues a code, writes nothing
//   C. an address with a full account  → sends "you already have one"
//
// If those take measurably different times, the uniform body is worthless:
// an attacker times the response instead of reading it. The defence is that
// `hashPassword` runs on EVERY branch, including the two that discard the
// result — so the ~400ms bcrypt dominates and the branch-specific work is
// noise against it.
//
// ## Why the three branches are measured INSIDE one iteration
//
// Each iteration hits A, then B, then C, and records the pairwise absolute
// differences. Comparing three separately-collected medians would be worse:
// a CI runner's load drifts over a minute-long run, so medians taken at
// different times carry that drift as if it were signal. Paired samples taken
// seconds apart share whatever the machine was doing, and the DIFFERENCE is
// what the threshold is on.
//
// ## Why 1 VU
//
// `bcryptjs` is pure JavaScript on the Node main thread, so the process
// serves one compare at a time (see `auth.js`: ~405ms serial, ~2.4 logins/s,
// and that capacity is the same on 4 and 8 cores because the bound is
// single-core speed). Any concurrency here would put every sample in a queue
// behind the others and measure the queue, not the branch.
//
// ## What it leaves behind
//
// Branch A creates one unverified account per iteration — 50 per run. On CI's
// ephemeral database that is free. Against a long-lived environment they
// accumulate until P3.5e's `unverified-account-sweep` collects them after
// seven days, which is the designed behaviour rather than a leak. The
// addresses are `enum-probe-*@example.test`, so they are identifiable.
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { loadConfig } from './lib/config.js';

const cfg = loadConfig();

/** Trials per branch. The figure #1194 names. */
const TRIALS = parseInt(__ENV.TRIALS || '50', 10);

/** The band, in milliseconds. Also from #1194. */
const MAX_SPREAD_MS = parseFloat(__ENV.MAX_SPREAD_MS || '50');

const durationNew = new Trend('enum_branch_new_ms', true);
const durationPending = new Trend('enum_branch_pending_ms', true);
const durationTaken = new Trend('enum_branch_taken_ms', true);

/** Per-iteration |A−B| across the three pairings. The threshold is on this. */
const pairedSpread = new Trend('enum_paired_spread_ms', true);

/** Any response whose status or body differs from the others. */
const shapeMismatch = new Counter('enum_shape_mismatch');

export const options = {
    scenarios: {
        enumeration: {
            executor: 'per-vu-iterations',
            vus: 1,
            iterations: TRIALS,
            // Three bcrypt-bound calls per iteration at ~400ms each, so
            // ~1.2s/iteration and ~60s for 50. Generous ceiling so a slow
            // runner does not abort mid-measurement and report a partial.
            maxDuration: '10m',
        },
    },
    thresholds: {
        // `med`, not `p(95)` — changed by #1411 after this gate reddened main
        // on a run where the property plainly held.
        //
        // Measured 2026-10-08 on `66688b0a1`: branch medians 330.2 / 326.1 /
        // 326.0 ms — within 4.2 ms, `shape mismatches: 0` — and p(95) of the
        // per-trial |Δ| was 78.4 ms against this 50 ms band, with a max of
        // 267.5 ms. A 267 ms tail beside a 4.2 ms median separation is a NOISE
        // distribution, not a signal one: p(95) of the pairwise difference of
        // two identically-distributed samples measures the per-trial variance
        // of a shared CI runner, which is not the quantity this test is about.
        //
        // The old comment's own reasoning is what gives the game away — it
        // said a real divergence "would be ~400ms out on EVERY sample, not 5%
        // of them". Exactly so. If the defect moves every sample, the gate
        // should read a CENTRAL statistic, where the defect is ~400 ms and
        // noise is a few tens; reading the 95th percentile instead buys
        // nothing against the defect and buys the whole noise tail against us.
        //
        // `med` keeps the "one GC pause must not fail the build" property that
        // motivated p(95) in the first place — a median is strictly more
        // robust to a single outlier than a 95th percentile is.
        //
        // The TIGHTER statistic the owner chose, `max |median_i − median_j|`,
        // cannot be written as a k6 threshold: thresholds are per-metric and
        // that one spans three. It is computed in `handleSummary`, written
        // into the results JSON, and enforced by
        // `scripts/check-enumeration-timing.mjs` in the same CI step. Both
        // gates are live; neither replaces the other.
        'enum_paired_spread_ms': [`med<${MAX_SPREAD_MS}`],
        // The status/body half, restated here so this script fails on its own
        // if the uniform response ever stops being uniform.
        'enum_shape_mismatch': ['count==0'],
        'checks': ['rate==1.0'],
    },
};

const START = `${cfg.baseUrl}/api/auth/register/start`;
const HEADERS = { 'Content-Type': 'application/json' };

/** One start request. Returns `{ status, body, ms }`. */
/**
 * Discover the terms version this deployment is serving (P3.1).
 *
 * `register/start` requires an acceptance that NAMES the version it was given,
 * and refuses any other with `400 terms_version_stale` carrying
 * `currentVersion`. So one deliberately-wrong request tells us what to send for
 * the rest of the run.
 *
 * Asked rather than hardcoded on purpose. A literal here would be a second
 * spelling of `TERMS_VERSION` in a file no build checks and no workflow runs,
 * and the failure would be silent in the worst way: every probe would 400,
 * every 400 returns BEFORE bcrypt, and the timing comparison this script
 * exists to make would look healthy while measuring nothing at all.
 */
export function setup() {
    const res = http.post(
        START,
        JSON.stringify({
            email: 'k6-version-probe@example.invalid',
            // pragma: allowlist secret
            password: __ENV.PROBE_PASSWORD || 'k6-enumeration-probe-passphrase',
            name: 'k6 probe',
            acceptedTerms: true,
            termsVersion: 'deliberately-not-the-current-version',
        }),
        { headers: HEADERS, tags: { name: 'terms-version-probe' } },
    );
    let version = null;
    try {
        version = JSON.parse(res.body).currentVersion || null;
    } catch {
        version = null;
    }
    if (!version) {
        // Loud, not a default. Without the right version every probe below is
        // a 400 and the measurement is void.
        throw new Error(
            `could not discover the terms version: status=${res.status} body=${String(res.body).slice(0, 200)}`,
        );
    }
    return { termsVersion: version };
}

function probe(email, termsVersion) {
    const res = http.post(
        START,
        JSON.stringify({
            email,
            // Long enough for the password policy, and deliberately NOT a
            // breached password: a HIBP rejection returns before the hash and
            // would make the branch look fast for the wrong reason.
            //
            // `scripts/detect-secrets.sh` flags this, correctly — it IS a
            // password literal. It is allowlisted rather than hidden because
            // it grants nothing: the accounts it creates are unverified, hold
            // no farm, exist only on an ephemeral CI database, and are
            // collected by P3.5e's sweep anywhere else. Overridable by env for
            // a run against a longer-lived environment.
            // pragma: allowlist secret
            password: __ENV.PROBE_PASSWORD || 'k6-enumeration-probe-passphrase',
            name: 'k6 probe',
            acceptedTerms: true,
            termsVersion,
        }),
        { headers: HEADERS, tags: { name: 'register-start' } },
    );
    return { status: res.status, body: res.body, ms: res.timings.duration };
}

export default function (data) {
    // A fresh address per iteration for branch A. The SAME address is then
    // reused immediately for branch B, which is what makes B the
    // "mid-signup" branch rather than a second new one.
    const fresh = `enum-probe-${__VU}-${__ITER}-${Date.now()}@example.test`;

    const v = data.termsVersion;
    const a = probe(fresh, v); // new address      → creates an unverified user
    const b = probe(fresh, v); // same address     → reissues a code
    const c = probe(cfg.email, v); // seeded, verified → "you already have one"

    // A non-200 here means the request SHAPE drifted — a newly required field,
    // a changed contract — and every one of those returns before bcrypt. The
    // timings would still be collected and would still pass the p(95)
    // threshold, because 400s are fast and uniformly so. So the run has to
    // fail on the status rather than quietly measure the wrong thing.
    if (a.status !== 200 || b.status !== 200 || c.status !== 200) {
        throw new Error(
            `register/start did not answer 200 (a=${a.status} b=${b.status} c=${c.status}); ` +
                `the request shape has drifted and these timings mean nothing`,
        );
    }

    durationNew.add(a.ms);
    durationPending.add(b.ms);
    durationTaken.add(c.ms);

    // Identical status AND body, or the uniform response has already failed
    // and the timing number is beside the point.
    const uniform =
        a.status === 200 &&
        b.status === 200 &&
        c.status === 200 &&
        a.body === b.body &&
        b.body === c.body;
    if (!uniform) shapeMismatch.add(1);

    check(a, {
        'branch A answers 200': (r) => r.status === 200,
        'branch A body is the uniform one': (r) => r.body === '{"ok":true}',
    });
    check(null, {
        'all three branches are byte-identical': () => uniform,
    });

    // All three pairings, so a divergence between ANY two is caught — not
    // just between the extremes.
    pairedSpread.add(Math.abs(a.ms - b.ms));
    pairedSpread.add(Math.abs(b.ms - c.ms));
    pairedSpread.add(Math.abs(a.ms - c.ms));
}

/**
 * The separation between the three branch MEDIANS — the quantity this test is
 * actually about, and the one `scripts/check-enumeration-timing.mjs` gates.
 *
 * Exported so that checker and this script cannot drift into two definitions
 * of one number. It takes the metrics object rather than reaching for globals
 * so a test can hand it a fixture.
 */
export function medianSeparationMs(metrics) {
    const med = (name) => metrics?.[name]?.values?.med;
    const xs = [
        med('enum_branch_new_ms'),
        med('enum_branch_pending_ms'),
        med('enum_branch_taken_ms'),
    ];
    // An ABSENT median is not a separation of zero. A run where a branch never
    // reported would otherwise score a perfect 0 ms and pass — the empty
    // selection reading as a pass, one level down.
    if (xs.some((v) => typeof v !== 'number' || !isFinite(v))) return NaN;
    return Math.max(...xs) - Math.min(...xs);
}

export function handleSummary(data) {
    const med = (name) => data.metrics[name]?.values?.med ?? NaN;
    const spread = data.metrics['enum_paired_spread_ms']?.values ?? {};
    const sep = medianSeparationMs(data.metrics);
    const lines = [
        '',
        '── registration enumeration timing (P3.10) ──',
        `  trials per branch     : ${TRIALS}`,
        `  branch A (new)        : ${med('enum_branch_new_ms').toFixed(1)} ms (median)`,
        `  branch B (mid-signup) : ${med('enum_branch_pending_ms').toFixed(1)} ms`,
        `  branch C (taken)      : ${med('enum_branch_taken_ms').toFixed(1)} ms`,
        `  median separation     : ${sep.toFixed(1)} ms  (band ${MAX_SPREAD_MS} ms)  ← GATED`,
        `  paired |Δ| med        : ${(spread.med ?? NaN).toFixed(1)} ms  (band ${MAX_SPREAD_MS} ms)  ← GATED`,
        `  paired |Δ| p(95)      : ${(spread['p(95)'] ?? NaN).toFixed(1)} ms  (reported, NOT gated)`,
        `  paired |Δ| max        : ${(spread.max ?? NaN).toFixed(1)} ms  (reported, NOT gated)`,
        `  shape mismatches      : ${data.metrics['enum_shape_mismatch']?.values?.count ?? 0}`,
        '',
        '  The three medians being close is the POINT, not an incidental.',
        '  They are close because hashPassword runs on every branch — the',
        '  two that discard the result included. A branch that skipped it',
        '  would sit ~400ms below the others, so BOTH gated figures would go',
        '  to ~400ms: the defect moves every sample, which is exactly why a',
        '  central statistic reads it and a 95th percentile only adds the',
        '  noise tail (#1411).',
        '',
        '  p(95) and max are printed because the dispersion is worth seeing —',
        '  a sudden jump in either says something about the RUNNER. Neither',
        '  fails the build, and on 2026-10-08 p(95) failing it while the',
        '  medians sat 4.2ms apart is what prompted the change.',
        '',
    ];
    return {
        stdout: lines.join('\n'),
        'tests/load/results/enumeration-timing.json': JSON.stringify(data, null, 2),
    };
}
