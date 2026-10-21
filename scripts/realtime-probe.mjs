#!/usr/bin/env node
/**
 * Assert that a realtime event really arrives — P7.9 (#1998).
 *
 * ## Why an end-to-end probe and not a health check
 *
 * Everything in P7 can be code-complete and silent. The notifications SSE
 * channel spent months fully built — route, bus, client, guard — carrying zero
 * events in production, and nothing reported it: the gate was a
 * `NEXT_PUBLIC_*` flag that could not be set in any image (#1982), and the
 * bell's REST fallback kept the UI updating, so a dead channel and a healthy
 * one looked identical from outside.
 *
 * A probe that checked the endpoint returned 200 would have passed throughout.
 * So this opens a real stream as a real authenticated client, causes a real
 * event, and asserts that exact event arrives within a bound.
 *
 * The pattern has recurred three times in this repo — the vitals beacon
 * (#1940), the CSP report sink (#704), and this channel — which is why the
 * probe is written as if it will happen again.
 *
 * ## The four outcomes, and why two of them are not failures
 *
 *   OK            — the event arrived. Exit 0.
 *   OFF           — disabled by decision. Exit 0, reported distinctly.
 *   UNCONFIGURED  — this probe has no credentials. Exit 1, its OWN issue title.
 *   BROKEN        — anything else. Exit 1, and the workflow opens an issue.
 *
 * OFF matters because the gate is a `notifications.sse` flag row (#1984) and a
 * disabled channel answers 204. A probe that treated 204 as failure would page
 * on an intentional state; one that treated it as success would stay silent
 * through a real outage. So 204 is its own verdict, and the probe says which
 * of the two it saw rather than collapsing them.
 *
 * UNCONFIGURED was folded into BROKEN, and the collision was real rather than
 * cosmetic. The workflow deduplicates by ISSUE TITLE so that an hourly probe
 * failing for a day comments on one issue instead of opening 24 — which means
 * two causes sharing a title share a thread. With no secrets set, the first
 * thing this monitor would ever have said is "a realtime event is not
 * arriving", and a genuine outage weeks later would have been a comment on
 * that same issue, under that same title, with the channel having been fine
 * the whole time in between.
 *
 * `/api/webhooks/resend/route.ts` already records this distinction for the
 * same reason, one layer down: `no-secret` answers 503 and a bad signature
 * 401, because "one means this deployment has not configured the feed, the
 * other means something is posting to it that cannot sign. Collapsing them
 * would hide an unconfigured endpoint behind what looks like an attack."
 *
 * It still exits 1. An unconfigured probe is not a working probe, and exiting
 * 0 would make "nobody finished the setup" indistinguishable from "the channel
 * is healthy" — the exact substitution this script exists to prevent.
 *
 * ## Why it does not use EventSource
 *
 * There is no `EventSource` in Node. The stream is read with `fetch` and a
 * byte reader, which also means this probe exercises the wire format rather
 * than a browser's interpretation of it — frames are parsed here, so a
 * malformed frame fails the probe instead of being quietly skipped by a
 * tolerant client.
 */
const BASE = process.env.PROBE_BASE_URL ?? 'https://app.agrent.bg';
const EMAIL = process.env.PROBE_EMAIL;
const PASSWORD = process.env.PROBE_PASSWORD;
/** How long the event has to arrive. Generous: the bound is a fault, not latency. */
const ARRIVE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 20_000);

/** Print a verdict line the workflow greps, then exit. */
function verdict(state, detail) {
    // One line, machine-readable first field. The workflow reads this rather
    // than the exit code alone, because OFF and OK share an exit code and the
    // issue body needs to say which.
    console.log(`PROBE_RESULT=${state} ${detail}`);
    process.exit(state === 'OK' || state === 'OFF' ? 0 : 1);
}

/**
 * Sign in with the credentials provider and keep the session COOKIE.
 *
 * A cookie rather than a bearer token, and the reason is the refresh flow
 * rather than a preference. `POST /api/auth/token` exchanges an existing
 * cookie session for a bearer pair, and `POST /api/auth/token/refresh`
 * ROTATES the refresh token on every use — so a refresh token held in a CI
 * secret is stale after one run, and presenting the old one again is detected
 * as a replay and revokes the session. That is correct behaviour for a stolen
 * token and useless for an hourly probe.
 *
 * Static credentials and the cookie flow have neither problem. The probe
 * account needs no write permission; it needs to be in the cohort the
 * `notifications.sse` flag is narrowed to, or the stream will correctly
 * answer 204 and the probe will report OFF for ever.
 */
async function signIn() {
    if (!EMAIL || !PASSWORD) {
        verdict(
            'UNCONFIGURED',
            'PROBE_EMAIL or PROBE_PASSWORD is not set — the probe cannot authenticate',
        );
    }

    // NextAuth requires a CSRF token and its cookie on the callback.
    const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
    if (!csrfRes.ok) verdict('BROKEN', `csrf fetch failed: ${csrfRes.status}`);
    const { csrfToken } = await csrfRes.json();
    let cookies = collectCookies(csrfRes, '');
    if (!csrfToken) verdict('BROKEN', 'csrf endpoint returned no token');

    const form = new URLSearchParams({
        csrfToken,
        email: EMAIL,
        password: PASSWORD,
        // `json: true` makes NextAuth answer with a URL rather than a 302, so
        // a failure is visible in the body instead of as a redirect to an
        // error page the probe would have to parse.
        json: 'true',
    });
    const signInRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies },
        body: form,
        redirect: 'manual',
    });
    cookies = collectCookies(signInRes, cookies);

    // The session cookie is the evidence, not the status: NextAuth answers 200
    // with an error URL on bad credentials.
    if (!/next-auth\.session-token|__Secure-next-auth\.session-token/.test(cookies)) {
        const body = await signInRes.text().catch(() => '');
        verdict(
            'BROKEN',
            `sign-in produced no session cookie (${signInRes.status}): ${body.slice(0, 200)}`,
        );
    }
    return cookies;
}

/** Merge `set-cookie` from a response into a cookie header string. */
function collectCookies(res, existing) {
    const jar = new Map();
    for (const pair of existing.split('; ').filter(Boolean)) {
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    // `getSetCookie` keeps the headers separate; a joined `set-cookie` cannot
    // be split safely because `Expires` contains a comma.
    for (const raw of res.headers.getSetCookie?.() ?? []) {
        const first = raw.split(';')[0];
        const eq = first.indexOf('=');
        if (eq > 0) jar.set(first.slice(0, eq), first.slice(eq + 1));
    }
    return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function main() {
    const cookie = await signIn();
    const auth = { cookie };

    // 1. Open the stream. A 204 is the channel saying "off by decision" — per
    //    the EventSource specification a non-200 fails the connection without
    //    a reconnect, which is why the route answers 204 rather than 403.
    const stream = await fetch(`${BASE}/api/me/stream`, { headers: auth });
    if (stream.status === 204) {
        verdict('OFF', 'the stream answered 204 — the notifications.sse flag is off for this caller');
    }
    if (!stream.ok || !stream.body) {
        verdict('BROKEN', `stream open failed: ${stream.status}`);
    }
    const ct = stream.headers.get('content-type') ?? '';
    if (!ct.includes('text/event-stream')) {
        verdict('BROKEN', `stream content-type is "${ct}", not text/event-stream`);
    }

    // 2. Cause an event, AFTER the stream is open. Before it, and the event
    //    would be published to nobody — the bus has no retention, by design.
    const probe = await fetch(`${BASE}/api/me/probe-event`, { method: 'POST', headers: auth });
    if (!probe.ok) {
        verdict('BROKEN', `probe-event failed: ${probe.status} ${(await probe.text()).slice(0, 200)}`);
    }
    const { id: expected } = await probe.json();
    if (typeof expected !== 'string') {
        verdict('BROKEN', 'probe-event returned no id to match against');
    }

    // 3. Read until that exact id arrives. Matching the id and not merely
    //    "something arrived" is what separates a working transport from an
    //    unrelated notification landing inside the window.
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + ARRIVE_TIMEOUT_MS;
    let buffered = '';
    let frames = 0;

    while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const next = await Promise.race([
            reader.read(),
            new Promise((r) => setTimeout(() => r({ timedOut: true }), remaining)),
        ]);
        if (next.timedOut) break;
        if (next.done) {
            verdict('BROKEN', `the stream closed after ${frames} frame(s) without the probe event`);
        }
        buffered += decoder.decode(next.value, { stream: true });

        for (const line of buffered.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            frames += 1;
            let frame;
            try {
                frame = JSON.parse(line.slice(6));
            } catch {
                verdict('BROKEN', `a data: line was not JSON: ${line.slice(0, 120)}`);
            }
            if (frame.id === expected) {
                reader.cancel().catch(() => {});
                verdict('OK', `the probe event arrived (kind=${frame.kind}, ${frames} frame(s) read)`);
            }
        }
    }

    reader.cancel().catch(() => {});
    verdict(
        'BROKEN',
        `the probe event did not arrive within ${ARRIVE_TIMEOUT_MS}ms (${frames} frame(s) read, expected id ${expected})`,
    );
}

main().catch((err) => {
    // Any throw is BROKEN. A probe that exited 0 on its own crash would be the
    // thing it exists to prevent.
    verdict('BROKEN', `the probe threw: ${err instanceof Error ? err.message : String(err)}`);
});
