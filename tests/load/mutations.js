// k6 load-test scenario — authenticated mutation baseline.
//
// Two operations per iteration:
//   2. POST /api/t/{slug}/evidence/uploads — multipart, tagged op:upload_evidence
//
// Why a single login in setup()
//   ─────────────────────────────
// The auth scenario (auth.js) measures cold-login throughput. This
// scenario measures mutation throughput; bcrypt is irrelevant. setup()
// performs one login and hands the session cookie to every VU via the
// data object so the iteration loop is purely write-path work.
//
// Test isolation
//   ──────────────
// Every created row carries `[loadtest-<runId>-vu<N>-it<M>]` in its
// title/name field. RUN_ID defaults to `local-<timestamp>` and is
// overridable via `-e RUN_ID=...` (CI sets it to the github.run_id).
// Two consequences:
//   • Easy to bulk-delete locally — see tests/load/README.md cleanup
//     snippet.
//   • In CI the postgres service container is recreated per workflow
//     run, so tagged rows are gone the moment the job finishes.
//     No cross-PR pollution.
//
// Upload uniqueness
//   ─────────────────
// `uploadEvidenceFile` does SHA-256 dedup before persisting the
// FileRecord. Identical bytes across iterations would silently collapse
// to a single row and skew the timing distribution. Each upload here
// embeds runId + VU + iter + nonce in the file content so every
// upload is genuinely unique.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { textSummary } from './vendor/k6-summary.js';
import { loadConfig } from './lib/config.js';
import { login } from './lib/auth.js';

const cfg = loadConfig();
const RUN_ID = __ENV.RUN_ID || `local-${Date.now()}`;

const uploadEvidenceOk = new Counter('mutation_upload_evidence_ok');
const uploadEvidenceFail = new Counter('mutation_upload_evidence_fail');
const mutationLoopMs = new Trend('mutation_loop_ms', true);

export const options = {
    scenarios: {
        mutations: {
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
        // SMOKE-TIER thresholds. These are wider than the SLO targets
        // because the smoke test runs against a cold CI runner with
        // a fresh Redis + PostgreSQL service container — first 30s
        // of traffic catch the JIT, connection-pool warmup, and
        // initial cache fill. The full-scale baselines in the
        // on-demand `load-test.yml` workflow (50/100/200 VU, 2 min)
        // are the canonical SLO gate — see `docs/slos.md` →
        // "Load-Test Validation".
        //
        // The smoke tier exists to catch CATASTROPHIC regressions
        // (the app won't boot, the auth flow is broken, mutations
        // routinely 5xx). It deliberately does NOT enforce SLO
        // targets — those would need warmup + steady-state, which
        // a 30s CI run can't deliver.
        //
        // Concretely: error rate < 20% catches "everything is
        // failing"; latency p95 < 5s catches "app is in a bad way";
        // the per-loop budget < 8s catches a regression in the
        // critical path's compounded latency.
        //
        // The error-rate ceiling is 20% (not 15%) because the smoke
        // run hits a cold CI runner with a single Postgres + Redis
        // service container — multipart-upload concurrency under
        // 10 VUs lands within ~3pp of 15% on a quiet day and tips
        // over on a noisy one. The full-scale baseline in
        // `load-test.yml` (50/100/200 VU, 2 min, post-warmup) is
        // the canonical SLO gate where the tighter targets apply.
        'http_req_failed{op:upload_evidence}': ['rate<0.20'],

        'http_req_duration{op:upload_evidence}': ['p(95)<5000', 'p(99)<8000'],

        // Correctness — relaxed to 80% on the smoke tier (a single
        // retried request can move 200-sample rate noticeably). The
        // full baseline still asserts >98%.
        'checks{check:evidence_uploaded}': ['rate>0.80'],

        // E2E loop — wide enough to absorb cold-start noise but
        // tight enough to catch a doubling regression.
        mutation_loop_ms: ['p(95)<8000'],
    },
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    discardResponseBodies: false,
};

// Single global login — shared via the setup → default data channel
// so the iteration loop never pays the bcrypt cost.
export function setup() {
    const ok = login(cfg);
    if (!ok) {
        throw new Error(
            'mutations.js setup login failed — refusing to run mutation smoke without a session. ' +
            'Verify the SUT is up at ' + cfg.baseUrl + ' with AUTH_TEST_MODE=1.',
        );
    }
    const jar = http.cookieJar();
    const cookies = jar.cookiesForURL(cfg.baseUrl);
    // NextAuth uses the secure-prefix variant on HTTPS; bare on HTTP.
    const tokenName = cookies['next-auth.session-token']
        ? 'next-auth.session-token'
        : '__Secure-next-auth.session-token';
    const tokenArr = cookies[tokenName];
    if (!Array.isArray(tokenArr) || tokenArr.length === 0) {
        throw new Error('login succeeded but no session cookie surfaced in the jar');
    }
    return { tokenName, tokenValue: tokenArr[0], runId: RUN_ID };
}

export default function mutationsIteration(data) {
    const t0 = Date.now();
    const params = {
        cookies: { [data.tokenName]: data.tokenValue },
    };
    const tag = `loadtest-${data.runId}-vu${__VU}-it${__ITER}`;
    const base = `${cfg.baseUrl}/api/t/${cfg.tenant}`;

    // ── 2. Upload evidence (multipart, unique bytes) ──
    const uniqueContent =
        `loadtest evidence\n` +
        `run: ${data.runId}\n` +
        `vu: ${__VU}\n` +
        `iteration: ${__ITER}\n` +
        `ts: ${Date.now()}\n` +
        `nonce: ${Math.random()}\n`;
    const formData = {
        file: http.file(uniqueContent, `${tag}.txt`, 'text/plain'),
        title: `[${tag}] load-test evidence upload`,
        category: 'loadtest',
    };
    const uploadRes = http.post(`${base}/evidence/uploads`, formData, {
        ...params,
        tags: { type: 'mutation', op: 'upload_evidence' },
    });
    const uploadOk = check(
        uploadRes,
        {
            'upload 201': (r) => r.status === 201,
            'upload has id': (r) => {
                try {
                    return typeof r.json('id') === 'string';
                } catch (_e) {
                    return false;
                }
            },
            'upload type is FILE': (r) => {
                try {
                    return r.json('type') === 'FILE';
                } catch (_e) {
                    return false;
                }
            },
        },
        { check: 'evidence_uploaded' },
    );
    if (uploadOk) uploadEvidenceOk.add(1);
    else uploadEvidenceFail.add(1);

    mutationLoopMs.add(Date.now() - t0);
    sleep(0.5);
}

export function handleSummary(summary) {
    return {
        stdout: textSummary(summary, { indent: ' ', enableColors: true }),
        'tests/load/results/mutations-summary.json': JSON.stringify(summary, null, 2),
    };
}
