// DM delivery p95 — P8.9's exit criterion (#2881).
//
// ── What this measures that `realtime-streams.js` cannot ──
//
// That scenario measures stream OPEN TTFB: how long `/api/me/stream` takes to
// answer while N streams are held. This measures DELIVERY: the time from a
// write to the frame arriving on an already-open stream. P8.9's criterion is
// the second one, and nothing in this repo asserted it — an unasserted
// criterion in a phase note reads as satisfied once the phase closes.
//
// The difference is not a detail of instrumentation. A frame that never
// arrives looks exactly like a quiet conversation, which is why this is the
// one P8 property whose failure is invisible.
//
// ── It needs a k6 that stock k6 is not ──
//
// `import sse from 'k6/x/sse'` resolves only in a binary built with
// `xk6 build --with github.com/phymbert/xk6-sse`. Stock k6 cannot read frames
// from a held response at all: `http.get` on an SSE endpoint blocks until the
// request times out, so a VU that opened a stream could not also send into it.
// `.github/workflows/load-test.yml` builds that binary; running this script
// under stock k6 fails at the import rather than silently measuring something
// else, which is the failure mode worth having.
//
// ── ONE VU holds TWO sessions, which is the whole design ──
//
// Delivery is a round trip between two people: A holds the stream, B writes,
// A's stream receives. Splitting that across two VUs would need them to agree
// on a conversation and a clock, and k6 gives VUs no shared mutable state — so
// the delta would have to be computed from two separately-recorded timestamps
// on two different VUs' iterations. One VU holding both sessions makes the
// measurement a subtraction of two instants in the same scope.
//
// `scripts/seed-load-streams.ts --pairs N` creates the accounts and an
// ACCEPTED conversation for each pair. ACCEPTED matters: a REQUEST admits
// exactly one message until accepted, so a load run would measure
// `DM_REQUEST_AWAITING_REPLY` from every VU's second iteration onward.
//
// ── What the number does and does NOT describe ──
//
// Said here because #2881 asks for it and because the figure is easy to quote
// out of context. This measures the SEAM on whatever host runs it, over
// SEEDED pairs. Production had 0 conversations when #2801 measured it, so
// there is no real usage for this to describe — and the production VM is
// `e2`-class and shared with two other products, which is why #1999's refusal
// to default `BASE_URL` is inherited here verbatim.
//
// A pass means "a write reached a held stream within the budget on this host,
// for conversations this script created". It does not mean a farmer's message
// arrives in a second.
//
// ── Why `http_req_failed` is not thresholded ──
//
// The same reason `realtime-streams.js` omits it: an SSE response never ends,
// so the held request always terminates abnormally from k6's point of view.
// A real failure here is a frame that never arrived, which `dm_undelivered`
// counts, or a refused write, which `dm_write_rejected` counts.
import http from 'k6/http';
import sse from 'k6/x/sse';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { fail } from 'k6';

import { textSummary } from './vendor/k6-summary.js';

const BASE = __ENV.BASE_URL;
const PASSWORD = __ENV.LOAD_TEST_PASSWORD;
const PAIRS = Number(__ENV.PAIRS || 25);
/** How long one iteration waits for its own frame before giving up. */
const DELIVERY_TIMEOUT_MS = Number(__ENV.DELIVERY_TIMEOUT_MS || 10000);
/** RFC 2606 reserved TLD — matches `scripts/seed-load-streams.ts`. */
const EMAIL_DOMAIN = 'load.invalid';

/** THE criterion: write → frame, in milliseconds. */
const delivery = new Trend('dm_delivery', true);
/**
 * A write that was accepted and whose frame never arrived inside the timeout.
 *
 * Thresholded at zero, and it is the assertion that stops a fast p95 from
 * being meaningless: a run where 9 of 10 frames are lost and the tenth is
 * quick has an excellent p95 over one sample. A percentile needs its
 * denominator, and this is the denominator's complement.
 */
const undelivered = new Counter('dm_undelivered');
/** The POST itself refused — a broken run, not a slow one. */
const writeRejected = new Counter('dm_write_rejected');
/** A stream the server refused (204 or otherwise) — the run measured nothing. */
const streamRefused = new Counter('dm_stream_refused');
/** Frames that arrived and were NOT the one being waited for. */
const otherFrames = new Counter('dm_other_frames');

export const options = {
    setupTimeout: __ENV.SETUP_TIMEOUT || '15m',
    scenarios: {
        deliver: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: __ENV.RAMP_UP || '20s', target: PAIRS },
                { duration: __ENV.DURATION || '1m', target: PAIRS },
                { duration: __ENV.RAMP_DOWN || '10s', target: 0 },
            ],
            gracefulRampDown: '30s',
        },
    },
    thresholds: {
        // P8.9's exit criterion, as written.
        dm_delivery: ['p(95)<1000'],
        // Without these three the criterion above can pass over nothing.
        dm_undelivered: ['count==0'],
        dm_write_rejected: ['count==0'],
        dm_stream_refused: ['count==0'],
    },
};

/**
 * NextAuth v4 credentials login, returning the session cookie.
 *
 * Duplicated from `realtime-streams.js` rather than shared, and the reason is
 * that file's own: `lib/auth.js` takes its email from the shared config and
 * returns a boolean, while this needs a different email per call and the token
 * itself. Extracting a third copy into `lib/` is the right move the moment a
 * fourth caller appears.
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
    // A bad credential is a 200 whose redirect URL carries `error=`, so the
    // status alone cannot tell a failed login from a good one.
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
            'BASE_URL is required and has no default — inherited from #1999 verbatim: ' +
                'the production host is e2-class and shared with two other products, so a ' +
                'number measured there is both wrong and risky.',
        );
    }
    if (!PASSWORD) {
        fail('LOAD_TEST_PASSWORD is required — the value passed to the seeder. No default.');
    }

    const pairs = [];
    let tokenName = null;
    for (let p = 1; p <= PAIRS; p++) {
        // Accounts (2p-1, 2p) are the pair the seeder joined, in that order.
        const aEmail = `loadstream+${p * 2 - 1}@${EMAIL_DOMAIN}`;
        const bEmail = `loadstream+${p * 2}@${EMAIL_DOMAIN}`;
        // The jar holds one session cookie at a time, so each token is read
        // before the next login overwrites it.
        const a = loginAndExtractToken(aEmail);
        const b = a ? loginAndExtractToken(bEmail) : null;
        if (!a || !b) {
            fail(
                `setup: login failed for pair ${p} (${aEmail} / ${bEmail}) after ` +
                    `${pairs.length} successes. Refusing to run: a short pool means fewer ` +
                    `measured pairs than PAIRS, reported as PAIRS. Seed with ` +
                    `\`npx tsx scripts/seed-load-streams.ts --users ${PAIRS * 2} ` +
                    `--pairs ${PAIRS} --enable-flag\`.`,
            );
        }
        tokenName = a.name;
        // The conversation id is NOT taken from the seeder's state file: k6
        // cannot read it, and a value copied by hand is a value that drifts.
        // `GET /api/social/inbox?source=dm` is what a client would use, and it
        // proves the conversation is reachable BY A as well as existing.
        const inbox = http.get(`${BASE}/api/social/inbox?source=dm`, {
            headers: { Cookie: `${a.name}=${a.value}` },
            tags: { step: 'inbox' },
        });
        if (inbox.status !== 200) {
            fail(
                `setup: GET /api/social/inbox answered ${inbox.status} for ${aEmail}. ` +
                    `403 means social.direct-messages is off — the seeder reports that and ` +
                    `deliberately does not switch it on.`,
            );
        }
        const items = inbox.json('items');
        const conversationId = Array.isArray(items) && items.length > 0 ? items[0].id : null;
        if (!conversationId) {
            fail(
                `setup: ${aEmail} has no DM conversation in its inbox. Seed with ` +
                    `--pairs ${PAIRS}; a run over zero conversations would measure nothing ` +
                    `and its p95 would be empty rather than fast.`,
            );
        }
        pairs.push({ conversationId, aToken: a.value, bToken: b.value });
    }
    console.log(`setup: ${pairs.length} pair(s) signed in and reachable`);
    return { tokenName, pairs };
}

export default function (data) {
    const pair = data.pairs[exec.vu.idInTest - 1];
    if (!pair) {
        // Fewer pairs than VUs can only mean PAIRS changed between setup and
        // here, which one run cannot do — so this is a bug, and holding no
        // stream would under-report the population silently.
        fail(`VU ${exec.vu.idInTest} has no seeded pair (have ${data.pairs.length})`);
    }

    const cookie = `${data.tokenName}=${pair.aToken}`;
    let sentAt = 0;
    let matched = false;
    // Scoped here rather than inside the handler: the check after `sse.open`
    // has to tell "the frame never came" from "there was never going to be
    // one because the write was refused".
    let writeAccepted = false;

    const res = sse.open(
        `${BASE}/api/me/stream`,
        { headers: { Cookie: cookie, Accept: 'text/event-stream' } },
        function (client) {
            client.on('open', function () {
                // WRITE ONLY ONCE THE STREAM IS OPEN. Sending first would
                // measure a frame published before anybody was listening —
                // the bus does not replay a `dm` frame (it carries no `id:`
                // line and bypasses the replay buffer by design), so the
                // frame would simply never arrive and the run would report
                // every delivery as lost.
                sentAt = Date.now();
                const write = http.post(
                    `${BASE}/api/social/conversations/${pair.conversationId}/messages`,
                    JSON.stringify({ body: `load ${exec.vu.idInTest}-${exec.scenario.iterationInTest}` }),
                    {
                        headers: {
                            Cookie: `${data.tokenName}=${pair.bToken}`,
                            'Content-Type': 'application/json',
                        },
                        tags: { step: 'dm-write' },
                    },
                );
                if (write.status === 201 || write.status === 200) {
                    writeAccepted = true;
                } else {
                    writeRejected.add(1);
                    client.close();
                }
            });

            client.on('event', function (event) {
                // The frame's `kind` is a FIELD, not an SSE `event:` name
                // (#2085), so every frame arrives here and the discriminator
                // is in the payload. A client that filtered on the event name
                // would read nothing.
                let frame = null;
                try {
                    frame = JSON.parse(event.data);
                } catch (_err) {
                    otherFrames.add(1);
                    return;
                }
                // Matched on the CONVERSATION id, which is what a `dm` frame
                // carries — never a message id and never content (the body is
                // encrypted at rest and a channel carrying prose would push it
                // through Redis and APNs).
                if (frame && frame.kind === 'dm' && frame.id === pair.conversationId) {
                    delivery.add(Date.now() - sentAt);
                    matched = true;
                    client.close();
                    return;
                }
                otherFrames.add(1);
            });

            client.on('error', function () {
                client.close();
            });

            // A CEILING ON THE WAIT, so a lost frame costs one iteration
            // rather than the run. Without it a VU whose frame never arrives
            // holds its stream until the scenario's graceful stop and records
            // nothing at all — which reads as a clean run with a quietly
            // smaller denominator, the exact shape `dm_undelivered` exists to
            // make visible.
            //
            // The GLOBAL `setTimeout`, not `k6/timers`: the global has been
            // present since k6 0.52 and survives into the v2 line this binary
            // is built on, while the module path is the kind of thing a major
            // moves. And a timer rather than a sleep, because the VU has to
            // stay in the event loop for the `event` handler to fire at all —
            // sleeping would deadlock the thing it is waiting for.
            setTimeout(function () {
                if (!matched) client.close();
            }, DELIVERY_TIMEOUT_MS);
        },
    );

    if (res && res.status && res.status !== 200) {
        // 204 means the flag is off, the session has no lineage, or the
        // per-person slot cap refused it. All three invalidate the run rather
        // than failing one request.
        streamRefused.add(1);
        return;
    }
    // Counted AFTER `sse.open` returns, which it does once the client is
    // closed — by the match, by the error handler, or by the timeout above.
    // A write that was refused is not also counted as undelivered: it never
    // had a frame coming, and double-counting one failure as two would make
    // both counters wrong.
    if (!matched && writeAccepted) undelivered.add(1);
}

export function handleSummary(data) {
    return {
        stdout: textSummary(data, { indent: ' ', enableColors: false }),
        'tests/load/results/realtime-delivery-summary.json': JSON.stringify(data, null, 2),
    };
}
