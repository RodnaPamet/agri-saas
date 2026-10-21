// 1,000 concurrent SSE streams — P7.10 (#1999).
//
// ── Not the production VM ──
//
// #1999 is explicit, and the reason belongs at the top of the file where
// somebody about to run it will read it: the production VM is `e2` class and
// SHARED with the playerz stack. A number measured there would be wrong (it
// competes with another product) and the run could affect a live service. So
// `BASE_URL` has no default — this script refuses to start rather than pick a
// target, and `scripts/seed-load-streams.ts` refuses without a typed phrase.
//
// ── One account per VU, because the cap is per PERSON ──
//
// The shape the other scenarios in this directory use — N VUs behind one
// login — cannot measure this one. `/api/me/stream` caps streams at three per
// PERSON (`acquireStreamSlot` keys on the user with no tenant term, which is
// what makes #1991's "3 streams per user" true for somebody in three farms).
// A thousand VUs on one account would hold three streams and take 997
// refusals, and a refusal is a 204 rather than an error — a green run
// measuring three streams.
//
// So 1,000 concurrent streams needs at least 334 distinct people. This uses
// one account per VU, from `scripts/seed-load-streams.ts --users <VUS>`, so
// that the arithmetic needs no explaining at the far end and no VU ever
// contends with itself.
//
// ── Why every login happens in setup(), and never in an iteration ──
//
// Two independent reasons, either of which is sufficient:
//
//   1. **The jar does not survive an iteration.** k6 resets the per-VU cookie
//      jar between iterations while module state survives them. `lists.js`
//      "spent its whole life 401-ing on every iteration after the first" on
//      exactly that, and its docblock is the record. So the session token is
//      extracted in `setup()` and re-attached explicitly on every request.
//   2. **bcrypt would be the thing measured.** Hashes run at the production
//      cost (12) — ~300ms of CPU each. A thousand of those during the ramp
//      would compete with the streams being opened, and the TTFB would be a
//      measurement of password hashing. Paid once, before the clock starts.
//
// The cost is a long `setup()`: a thousand serial logins is several minutes,
// which is why `setupTimeout` is 15m and overridable.
//
// ── What is measured, and what is not ──
//
// MEASURES: time to first byte on `/api/me/stream` while ~VUS streams are held
// open — `http_req_waiting`, recorded as `stream_ttfb`. That is the right
// reading of the criterion: a new stream opening promptly while a thousand are
// held is where connection pools, the event loop and Caddy's own limits show.
//
// DOES NOT MEASURE: how long an EVENT takes to reach a held stream under load.
// That needs an SSE client that can read frames while k6 keeps the VU busy —
// xk6-sse, a binary this repo does not build. Said plainly rather than letting
// a green run imply a property it never tested: a pass here means "a thousand
// streams can be held and a new one still opens fast", not "delivery stays
// under a second at a thousand streams".
//
// ── Why every held request "fails" ──
//
// An SSE response never ends, so each hold ends in a k6 timeout BY DESIGN and
// `http_req_failed` is meaningless here — the thresholds deliberately omit it.
// A real failure is a non-timeout status, which `stream_rejected` counts.
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { fail } from 'k6';

import { textSummary } from './vendor/k6-summary.js';

const BASE = __ENV.BASE_URL;
const PASSWORD = __ENV.LOAD_TEST_PASSWORD;
/** How long one VU holds its stream. Concurrency is VUS, not VUS x this. */
const HOLD = __ENV.STREAM_HOLD || '45s';
const VUS = Number(__ENV.VUS || 1000);
/** RFC 2606 reserved TLD — matches `scripts/seed-load-streams.ts`. */
const EMAIL_DOMAIN = 'load.invalid';

/** A stream the server refused with something other than 204 — a real failure. */
const rejected = new Counter('stream_rejected');
/**
 * A 204. Three causes, all of which invalidate the run rather than failing one
 * request: the flag is off, the session has no lineage, or the per-person slot
 * cap refused it — which at one stream per account would mean slots are not
 * released on disconnect. Thresholded at zero for that reason.
 */
const refused204 = new Counter('stream_refused_204');
/** Time to first byte on a stream opened under the full held population. */
const ttfb = new Trend('stream_ttfb', true);

export const options = {
    // A thousand serial bcrypt logins. See the docblock.
    setupTimeout: __ENV.SETUP_TIMEOUT || '15m',
    scenarios: {
        hold: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                // A slow ramp on purpose: a thousand simultaneous TLS
                // handshakes would measure the handshake, not the steady state
                // the criterion is about.
                { duration: __ENV.RAMP_UP || '60s', target: VUS },
                { duration: __ENV.DURATION || '3m', target: VUS },
                { duration: __ENV.RAMP_DOWN || '30s', target: 0 },
            ],
            gracefulRampDown: '30s',
        },
    },
    thresholds: {
        // The criterion.
        stream_ttfb: ['p(95)<1000'],
        // A refusal is a failure whatever its latency.
        stream_rejected: ['count==0'],
        // See `refused204` — a non-zero count means the run measured nothing.
        stream_refused_204: ['count==0'],
    },
};

/**
 * NextAuth v4 credentials login for one account, returning its session cookie
 * value. The two-step flow mirrors `lib/auth.js`, which cannot be reused
 * directly: it takes its email from the shared config and returns a boolean,
 * and this needs a different email per call and the token itself.
 */
function loginAndExtractToken(email) {
    const csrfRes = http.get(`${BASE}/api/auth/csrf`, { tags: { step: 'csrf' } });
    if (csrfRes.status !== 200) return null;
    const csrfToken = csrfRes.json('csrfToken');
    if (typeof csrfToken !== 'string' || csrfToken.length === 0) return null;

    const loginRes = http.post(
        `${BASE}/api/auth/callback/credentials`,
        {
            csrfToken,
            email,
            password: PASSWORD,
            callbackUrl: `${BASE}/dashboard`,
            json: 'true',
        },
        { tags: { step: 'login' } },
    );
    if (loginRes.status < 200 || loginRes.status >= 400) return null;
    const url = loginRes.json('url');
    // NextAuth reports a bad credential as a 200 whose redirect URL carries
    // `error=`, so the status alone cannot tell a failed login from a good one.
    if (typeof url !== 'string' || url.includes('error=')) return null;

    const cookies = http.cookieJar().cookiesForURL(BASE);
    const name = cookies['next-auth.session-token']
        ? 'next-auth.session-token'
        : '__Secure-next-auth.session-token';
    const arr = cookies[name];
    if (!arr || arr.length === 0) return null;
    return { name, value: arr[0] };
}

export function setup() {
    if (!BASE) {
        fail(
            'BASE_URL is required and has no default. #1999 says a THROWAWAY VM: the ' +
                'production host is e2-class and shared with another product, so a ' +
                'number measured there is both wrong and risky.',
        );
    }
    if (!PASSWORD) {
        fail(
            'LOAD_TEST_PASSWORD is required — the same value passed to ' +
                'scripts/seed-load-streams.ts. There is no default.',
        );
    }

    const tokens = [];
    let name = null;
    for (let i = 1; i <= VUS; i++) {
        // The jar holds one session cookie at a time, so each token is read
        // before the next login overwrites it.
        const session = loginAndExtractToken(`loadstream+${i}@${EMAIL_DOMAIN}`);
        if (!session) {
            fail(
                `setup: login failed for loadstream+${i}@${EMAIL_DOMAIN} after ` +
                    `${tokens.length} successes. Refusing to run: a short account pool ` +
                    `means fewer streams than VUS, reported as VUS. Seed with ` +
                    `\`npx tsx scripts/seed-load-streams.ts --users ${VUS} --enable-flag\`.`,
            );
        }
        name = session.name;
        tokens.push(session.value);
        if (i % 100 === 0) console.log(`setup: ${i}/${VUS} signed in`);
    }
    return { tokenName: name, tokens };
}

export default function (data) {
    // One account per VU. `idInTest` is unique across the whole test run, which
    // a per-scenario counter would not be if a second scenario were ever added.
    const token = data.tokens[exec.vu.idInTest - 1];
    if (!token) {
        // Fewer tokens than VUs can only mean VUS changed between setup and
        // here, which is not possible in one run — so this is a bug, not a
        // seeding problem, and silently holding no stream would under-report
        // the population.
        rejected.add(1);
        return;
    }

    const res = http.get(`${BASE}/api/me/stream`, {
        headers: { accept: 'text/event-stream' },
        // Re-attached explicitly: the jar does not survive the iteration.
        cookies: { [data.tokenName]: token },
        // The hold. A timeout here is the expected outcome — see the header.
        timeout: HOLD,
        tags: { name: 'me-stream' },
    });

    // status 0 is k6's "did not complete", which for a held SSE stream means it
    // was still open when the timeout elapsed — success, and `waiting` on it is
    // a real TTFB.
    if (res.status === 0 || res.status === 200) {
        ttfb.add(res.timings.waiting);
        return;
    }
    if (res.status === 204) {
        refused204.add(1);
        return;
    }
    rejected.add(1);
}

export function handleSummary(data) {
    return {
        stdout: textSummary(data, { indent: ' ', enableColors: true }),
        'tests/load/results/realtime-streams-summary.json': JSON.stringify(data, null, 2),
    };
}
