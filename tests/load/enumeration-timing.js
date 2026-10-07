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
        // THE assertion. p(95) rather than max: one sample can be hit by a GC
        // pause or a container scheduling blip, and failing the build on a
        // single outlier would make this test something people disable.
        // p(95) over 150 paired differences still catches a real divergence —
        // a branch that genuinely skipped bcrypt would be ~400ms out on
        // EVERY sample, not 5% of them.
        'enum_paired_spread_ms': [`p(95)<${MAX_SPREAD_MS}`],
        // The status/body half, restated here so this script fails on its own
        // if the uniform response ever stops being uniform.
        'enum_shape_mismatch': ['count==0'],
        'checks': ['rate==1.0'],
    },
};

const START = `${cfg.baseUrl}/api/auth/register/start`;
const HEADERS = { 'Content-Type': 'application/json' };

/** One start request. Returns `{ status, body, ms }`. */
function probe(email) {
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
        }),
        { headers: HEADERS, tags: { name: 'register-start' } },
    );
    return { status: res.status, body: res.body, ms: res.timings.duration };
}

export default function () {
    // A fresh address per iteration for branch A. The SAME address is then
    // reused immediately for branch B, which is what makes B the
    // "mid-signup" branch rather than a second new one.
    const fresh = `enum-probe-${__VU}-${__ITER}-${Date.now()}@example.test`;

    const a = probe(fresh); // new address      → creates an unverified user
    const b = probe(fresh); // same address     → reissues a code
    const c = probe(cfg.email); // seeded, verified → "you already have one"

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

export function handleSummary(data) {
    const med = (name) => data.metrics[name]?.values?.med ?? NaN;
    const spread = data.metrics['enum_paired_spread_ms']?.values ?? {};
    const lines = [
        '',
        '── registration enumeration timing (P3.10) ──',
        `  trials per branch     : ${TRIALS}`,
        `  branch A (new)        : ${med('enum_branch_new_ms').toFixed(1)} ms (median)`,
        `  branch B (mid-signup) : ${med('enum_branch_pending_ms').toFixed(1)} ms`,
        `  branch C (taken)      : ${med('enum_branch_taken_ms').toFixed(1)} ms`,
        `  paired |Δ| p(95)      : ${(spread['p(95)'] ?? NaN).toFixed(1)} ms  (band ${MAX_SPREAD_MS} ms)`,
        `  paired |Δ| max        : ${(spread.max ?? NaN).toFixed(1)} ms`,
        `  shape mismatches      : ${data.metrics['enum_shape_mismatch']?.values?.count ?? 0}`,
        '',
        '  The three medians being close is the POINT, not an incidental.',
        '  They are close because hashPassword runs on every branch — the',
        '  two that discard the result included. A branch that skipped it',
        '  would sit ~400ms below the others and the p(95) threshold would',
        '  fail on every sample rather than a few.',
        '',
    ];
    return {
        stdout: lines.join('\n'),
        'tests/load/results/enumeration-timing.json': JSON.stringify(data, null, 2),
    };
}
