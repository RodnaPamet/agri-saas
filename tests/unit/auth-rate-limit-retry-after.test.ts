/* eslint-disable @typescript-eslint/no-explicit-any -- NextRequest harness, the
 * codebase's standard pattern for these. */

/**
 * `authRateLimit` never answers a refusal with `Retry-After: 0` (#1398).
 *
 * ## Why a behavioural test and not a guard
 *
 * The tempting test is "the source contains `Math.max(1, …)`", which is a
 * guard over source text and proves nothing about the emitted header. What
 * matters is the value a refused client actually receives, so this drives the
 * real limiter past its ceiling and reads the header off the real 429.
 *
 * ## The positive control is load-bearing here
 *
 * At a limit of 10 the first NINE calls legitimately return `ok` with
 * `retryAfter: 0` — that is correct, not a defect, because there is nothing to
 * wait for. So an assertion that merely reads `>= 1` on every response would
 * pass against a limiter that **never refused at all**, which is the failure
 * this test would most want to catch. §1 therefore pins that a refusal
 * actually happens and at which call, before §2 looks at the value.
 *
 * ## Why this limiter and not the other five
 *
 * It was the only one of six that did not clamp. It is also the
 * PRE-AUTHENTICATION tier (10/min on sign-in and token endpoints, keyed
 * `(IP, ua-hash)`), so its refusals reach clients that have not
 * authenticated — a well-behaved one that honours `Retry-After: 0` retries
 * instantly and burns its next window the moment it opens.
 */
import { NextRequest } from 'next/server';

const ENV_SNAPSHOT: Record<string, string | undefined> = {
    RATE_LIMIT_MODE: process.env.RATE_LIMIT_MODE,
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
    AUTH_TEST_MODE: process.env.AUTH_TEST_MODE,
};
// `memory` so the window is deterministic; `AUTH_TEST_MODE=0` because `=1`
// short-circuits the limiter to `{ ok: true }` and the whole suite would be
// vacuous — the "a control that cannot express failure" trap.
process.env.RATE_LIMIT_MODE = 'memory';
process.env.RATE_LIMIT_ENABLED = '1';
process.env.AUTH_TEST_MODE = '0';

afterAll(() => {
    for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

import { checkAuthRateLimit } from '@/lib/rate-limit/authRateLimit';

/** `/api/auth/signin` is the `high` tier: 10 per minute. */
const HIGH_TIER_LIMIT = 10;

let seq = 0;
/** A distinct caller per test, so windows never bleed between them. */
function req(path = '/api/auth/signin/google'): NextRequest {
    return new NextRequest(`http://localhost:3000${path}`, {
        headers: {
            'x-forwarded-for': `198.51.100.${(seq % 200) + 1}`,
            'user-agent': `retry-after-probe/${seq}`,
        },
    });
}

/** Drive one caller to `n` calls and return every outcome in order. */
async function drive(n: number, path?: string) {
    seq += 1;
    const ip = `198.51.100.${(seq % 200) + 1}`;
    const ua = `retry-after-probe/${seq}`;
    const out: Array<{ ok: boolean; retryAfter: number | null; status: number | null }> = [];
    for (let i = 0; i < n; i++) {
        const r = await checkAuthRateLimit(
            new NextRequest(`http://localhost:3000${path ?? '/api/auth/signin/google'}`, {
                headers: { 'x-forwarded-for': ip, 'user-agent': ua },
            }) as any,
        );
        const hdr = r.response?.headers.get('Retry-After') ?? r.headers?.get('Retry-After') ?? null;
        out.push({
            ok: r.ok,
            retryAfter: hdr === null ? null : Number(hdr),
            status: r.response?.status ?? null,
        });
    }
    return out;
}

describe('§1 the control: a refusal actually happens, and on the expected call', () => {
    it(`the first ${HIGH_TIER_LIMIT} are allowed and the next is refused`, async () => {
        // Without this, every assertion in §2 is satisfied by a limiter that
        // refuses nothing — the 429 branch would simply never execute.
        const outcomes = await drive(HIGH_TIER_LIMIT + 2);
        const allowed = outcomes.filter((o) => o.ok).length;
        const refused = outcomes.filter((o) => !o.ok);

        expect(allowed).toBe(HIGH_TIER_LIMIT);
        expect(refused.length).toBe(2);
        expect(refused[0].status).toBe(429);
    });
});

describe('§2 the window boundary — where the defect actually lives', () => {
    /**
     * The assertion the first draft of this file MISSED, and the reason it is
     * worth saying so: unclamping the memory path reddened nothing, because in
     * an ordinary burst `resetAt = now + 60_000` and `retryAfter` is ~60. A
     * test that asserts `>= 1` on a value that is always 60 cannot fail for
     * the reason it was written.
     *
     * The defect is exactly one millisecond wide. `checkMemoryLimit` resets on
     * a STRICT `now > record.resetAt`, so at `now === resetAt` the window is
     * NOT reset, the count is already over the limit, and
     * `ceil((resetAt - now) / 1000)` is `ceil(0)` — zero. Reaching it needs
     * the clock pinned to the boundary, not a faster loop.
     */
    const REAL_NOW = Date.now;
    afterEach(() => {
        Date.now = REAL_NOW;
    });

    it('at now === resetAt exactly, a refusal still says >= 1', async () => {
        const T = 1_760_000_000_000;
        Date.now = () => T;

        // Fill the window at time T. `resetAt` becomes T + 60_000.
        const first = await drive(HIGH_TIER_LIMIT, '/api/auth/signin/google');
        expect(first.every((o) => o.ok)).toBe(true);

        // The same caller, with the clock pinned to the boundary. `drive`
        // mints a new caller per call, so this one is driven by hand.
        const ip = '198.51.100.250';
        const ua = 'boundary-probe';
        for (let i = 0; i < HIGH_TIER_LIMIT; i++) {
            await checkAuthRateLimit(
                new NextRequest('http://localhost:3000/api/auth/signin/google', {
                    headers: { 'x-forwarded-for': ip, 'user-agent': ua },
                }) as any,
            );
        }

        // Now step to EXACTLY resetAt. `now > resetAt` is false, so the window
        // is not reset and the next call is a refusal with zero time left.
        Date.now = () => T + 60_000;
        const r = await checkAuthRateLimit(
            new NextRequest('http://localhost:3000/api/auth/signin/google', {
                headers: { 'x-forwarded-for': ip, 'user-agent': ua },
            }) as any,
        );

        expect(r.ok).toBe(false);
        const hdr = r.response?.headers.get('Retry-After');
        expect(hdr).not.toBeNull();
        // Unclamped this is `0`. That is the whole defect, and it is only
        // reachable from this one millisecond.
        expect(Number(hdr)).toBeGreaterThanOrEqual(1);
    });

    it('…and one millisecond PAST the boundary the window resets, so it is allowed', async () => {
        // The control for the case above: if the refusal at the boundary were
        // an artifact of the harness rather than of the reset predicate, this
        // would refuse too.
        const T = 1_770_000_000_000;
        Date.now = () => T;
        const ip = '198.51.100.251';
        const ua = 'boundary-control';
        for (let i = 0; i < HIGH_TIER_LIMIT; i++) {
            await checkAuthRateLimit(
                new NextRequest('http://localhost:3000/api/auth/signin/google', {
                    headers: { 'x-forwarded-for': ip, 'user-agent': ua },
                }) as any,
            );
        }
        Date.now = () => T + 60_001;
        const r = await checkAuthRateLimit(
            new NextRequest('http://localhost:3000/api/auth/signin/google', {
                headers: { 'x-forwarded-for': ip, 'user-agent': ua },
            }) as any,
        );
        expect(r.ok).toBe(true);
    });
});

describe('§3 and the refusal never says "retry immediately" in an ordinary burst', () => {
    it('Retry-After on a 429 is an integer >= 1', async () => {
        const outcomes = await drive(HIGH_TIER_LIMIT + 3);
        const refused = outcomes.filter((o) => !o.ok);
        expect(refused.length).toBeGreaterThan(0);

        for (const r of refused) {
            expect(r.retryAfter).not.toBeNull();
            expect(Number.isInteger(r.retryAfter)).toBe(true);
            // `0` tells a conforming client to retry at once, which spends the
            // next window the instant it opens. `Retry-After` is defined as
            // NON-NEGATIVE delta-seconds, so a negative is malformed and a
            // client may discard it for its own default.
            expect(r.retryAfter as number).toBeGreaterThanOrEqual(1);
        }
    });

    it('…on every refusal in a long burst, not just the first', async () => {
        // The clamp sits in one expression shared by every refusal, but a
        // future split into "first refusal" and "subsequent" paths would make
        // this the assertion that notices.
        const outcomes = await drive(HIGH_TIER_LIMIT + 25);
        const refused = outcomes.filter((o) => !o.ok);
        expect(refused.length).toBe(25);
        expect(refused.every((r) => (r.retryAfter ?? 0) >= 1)).toBe(true);
    });

    it('an ALLOWED call may legitimately carry 0 or no header — that is not the defect', async () => {
        // Stated so the clamp is never "fixed" onto the success path. There is
        // nothing to wait for when the request is served, and a `Retry-After`
        // of 1 on a 200 would be wrong in the other direction.
        const outcomes = await drive(3);
        expect(outcomes.every((o) => o.ok)).toBe(true);
        for (const o of outcomes) {
            expect(o.retryAfter === null || o.retryAfter === 0).toBe(true);
        }
    });
});

describe('§4 the other tiers get the same guarantee', () => {
    it.each([
        ['/api/auth/token/refresh', 'high'],
        ['/api/auth/callback/google', 'high'],
    ])('%s (%s tier) clamps too', async (path) => {
        // `classifyEndpoint` puts the native token endpoints in `high`
        // deliberately — an unauthenticated credential exchange is the same
        // abuse position as /signin. A client refused there is a native app
        // mid-refresh, which is the worst place to be told "retry now".
        const outcomes = await drive(HIGH_TIER_LIMIT + 2, path);
        const refused = outcomes.filter((o) => !o.ok);
        expect(refused.length).toBeGreaterThan(0);
        expect(refused.every((r) => (r.retryAfter ?? 0) >= 1)).toBe(true);
    });
});

describe('§5 the harness itself can express failure', () => {
    it('AUTH_TEST_MODE=1 would make every assertion above vacuous', async () => {
        // `checkAuthRateLimit` returns `{ ok: true }` immediately under that
        // flag, so a suite that left it set would pass while never reaching
        // the limiter. Asserting the short-circuit exists is how a future
        // reader knows why this file sets it to '0'.
        process.env.AUTH_TEST_MODE = '1';
        const bypassed = await drive(HIGH_TIER_LIMIT + 5);
        expect(bypassed.every((o) => o.ok)).toBe(true);
        process.env.AUTH_TEST_MODE = '0';

        // And with it off, the same burst refuses — so the flag, not luck, is
        // what separated the two.
        const real = await drive(HIGH_TIER_LIMIT + 5);
        expect(real.some((o) => !o.ok)).toBe(true);
    });
});
