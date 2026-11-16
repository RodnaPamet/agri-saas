// Channel feed p95 against a 2,000-member channel — P9.10's exit criterion (#2944).
//
// ── What this measures, and the number it must print beside the percentile ──
//
// «a 2,000-member channel at p95 ≤2s». Two halves, and only one of them is a
// percentile. #2944 is explicit that the DENOMINATOR goes beside it: #2881
// reported p95 36.19ms against a 1000ms budget over 59 round trips, and the
// trip count is what showed the harness had actually done something. A p95
// over four requests is not a measurement, and it looks identical to a p95
// over four thousand.
//
// So `channel_feed_requests` is a counter with a THRESHOLD, not a stat. A run
// that cannot reach the floor fails rather than reporting a beautiful latency
// over nothing — the `an-empty-window-passes-a-negated-assertion` shape.
//
// ── The 2,000 is the channel's SIZE, not the reader count ──
//
// `ChannelMembership.userId` has no relation to `User` (P9.1), so the members
// are 2,000 rows and no accounts; `scripts/seed-load-channels.ts` writes them
// and verifies the count back. The READERS are the VUs, logging in as the
// accounts `seed-load-streams.ts` already creates. Conflating the two would
// mean seeding 2,000 real users to satisfy a size criterion.
//
// ── The flag must be ON or this measures the refusal ──
//
// `social.channels` is default-OFF and every feed read then answers 404
// through `assertFeatureEnabled` — deliberately, which is exactly why it is a
// trap: 404s are fast, and a run that measured 2,000 refusals would report a
// magnificent p95. The seeder enables it with `--enable-flag` and restores the
// prior state on teardown. This script ALSO checks it: a 404 fails the check
// rather than being quietly excluded, so the refusal cannot pass as a result.
//
// ── The cookie jar resets between iterations ──
//
// `lists.js` carries this in full: k6 resets the jar between iterations while
// module state survives them, so a `loggedIn` flag stays true after the
// cookies have gone and every iteration past the first runs unauthenticated.
// One login in `setup()`, cookie re-attached explicitly per request.
//
// Run:
//   k6 run -e VUS=50 -e DURATION=2m -e CHANNEL_ID=ch-load-p910-… tests/load/channel-feed.js
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

import { loadConfig } from './lib/config.js';
import { login } from './lib/auth.js';

const cfg = loadConfig();

/** The channel the seeder made. Without it there is nothing to read. */
const CHANNEL_ID = __ENV.CHANNEL_ID || '';

/**
 * The floor the request counter must clear.
 *
 * Derived, not guessed: VUS x DURATION / (one request + 250ms think-time) is
 * several thousand at the documented 50 VUs / 2m, so a floor of 200 is ~2% of
 * the expected volume. Low enough never to fail a healthy short run, high
 * enough that a harness which authenticated once and then 404'd cannot reach
 * it.
 */
const MIN_REQUESTS = Number(__ENV.MIN_REQUESTS || 200);

const feedLatency = new Trend('channel_feed_latency', true);
const feedRequests = new Counter('channel_feed_requests');
const feedSuccess = new Rate('channel_feed_success');
/** Counted SEPARATELY so a flag-off run is legible rather than merely failing. */
const feedRefusals = new Counter('channel_feed_refusals');

export const options = {
    scenarios: {
        feed: {
            executor: 'constant-vus',
            vus: Number(__ENV.VUS || 50),
            duration: __ENV.DURATION || '2m',
        },
    },
    thresholds: {
        // THE CRITERION.
        'channel_feed_latency{endpoint:posts}': ['p(95)<2000'],
        // THE DENOMINATOR. Without this the criterion above passes over an
        // empty population, which is the whole reason #2944 asks for the trip
        // count beside the percentile.
        channel_feed_requests: [`count>=${MIN_REQUESTS}`],
        // And the reads must have WORKED. A run of 404s has a superb p95.
        channel_feed_success: ['rate>0.99'],
    },
};

export function setup() {
    if (!CHANNEL_ID) {
        throw new Error(
            'CHANNEL_ID is unset. Run scripts/seed-load-channels.ts first and pass the id it ' +
                'prints — without it this would read a channel that does not exist and measure ' +
                'the 404 path.',
        );
    }

    const ok = login(cfg);
    if (!ok) {
        throw new Error(
            'channel-feed.js setup login failed — refusing to run without a session. ' +
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

    // A POSITIVE CONTROL before the run starts: one real read, asserted.
    // Without it a misconfigured flag or a wrong CHANNEL_ID produces a full
    // run of refusals whose only symptom is a threshold failure at the end,
    // which reads as "the app is slow" rather than "the harness was pointed at
    // nothing". Fail here instead, with the status in the message.
    const probe = http.get(
        `${cfg.baseUrl}/api/social/channels/${CHANNEL_ID}/posts?limit=20`,
        { cookies: { [tokenName]: tokenArr[0] } },
    );
    if (probe.status !== 200) {
        throw new Error(
            `setup probe got ${probe.status} from the channel feed, not 200. ` +
                (probe.status === 404
                    ? 'A 404 here is almost certainly `social.channels` being OFF — the seeder ' +
                      'takes --enable-flag. It is deliberate, not a cache problem, and a run ' +
                      'started now would measure the refusal.'
                    : 'Nothing is worth measuring until this reads 200.'),
        );
    }

    return { tokenName, tokenValue: tokenArr[0] };
}

export default function channelFeedIteration(data) {
    const auth = { cookies: { [data.tokenName]: data.tokenValue } };

    group('channel:feed', () => {
        const r = http.get(
            `${cfg.baseUrl}/api/social/channels/${CHANNEL_ID}/posts?limit=20`,
            { ...auth, tags: { type: 'channel', endpoint: 'posts' } },
        );

        feedRequests.add(1);
        feedLatency.add(r.timings.duration, { endpoint: 'posts' });
        if (r.status === 404 || r.status === 403) feedRefusals.add(1);

        const ok = check(r, {
            'feed 200': (res) => res.status === 200,
            'feed returns rows': (res) => {
                try {
                    const j = res.json();
                    return Array.isArray(j) || (j && typeof j === 'object');
                } catch (_e) {
                    return false;
                }
            },
        });
        feedSuccess.add(ok);
    });

    // 250ms think-time, matching `lists.js` so the two scenarios' RPS are
    // comparable at the same VU count.
    sleep(0.25);
}

export function handleSummary(data) {
    // The criterion AND its denominator, on one line, because a percentile
    // reported without the trip count is the thing #2944 asks not to happen.
    const trips = data.metrics.channel_feed_requests
        ? data.metrics.channel_feed_requests.values.count
        : 0;
    const p95 = data.metrics['channel_feed_latency{endpoint:posts}']
        ? data.metrics['channel_feed_latency{endpoint:posts}'].values['p(95)']
        : (data.metrics.channel_feed_latency
            ? data.metrics.channel_feed_latency.values['p(95)']
            : NaN);
    const refusals = data.metrics.channel_feed_refusals
        ? data.metrics.channel_feed_refusals.values.count
        : 0;
    const line =
        `[channel-feed] p95=${Number(p95).toFixed(1)}ms over ${trips} round trip(s), ` +
        `${refusals} refusal(s), budget 2000ms, floor ${MIN_REQUESTS} trips\n`;
    return { stdout: line };
}
