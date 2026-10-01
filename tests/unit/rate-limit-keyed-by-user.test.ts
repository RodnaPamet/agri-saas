/**
 * An authenticated mutation is keyed by USER, not by IP alone.
 *
 * ## The invariant, and why it was not holding
 *
 * `buildRateLimitKey`'s docblock:
 *
 *   > CGNAT rationale — DO NOT "simplify" the authenticated key to IP-only.
 *   > […] carrier-grade NAT puts *thousands* of unrelated subscribers behind
 *   > ONE public IPv4. […] every authenticated preset MUST keep the userId.
 *
 * Measured on `main` before this change: of the **346** route files wrapped in
 * `withApiErrorHandling`, **3** passed a `getUserId` resolver. The remaining
 * **343** produced `<scope>:ip:<ip>:anon`, which is what that paragraph
 * forbids. On a mobile-first product in Bulgaria, one farmer's busy morning —
 * or one abuser — spent the whole budget for every other subscriber on the
 * same carrier egress.
 *
 * The mechanism worked. It was OPT-IN, and an invariant that holds only when
 * 346 route authors each remember it is not an invariant.
 *
 * ## Why this test drives the real wrapper
 *
 * The sibling `tests/unit/mutation-rate-limit.test.ts` calls
 * `buildRateLimitKey` directly and proves the key FORMAT. It cannot see
 * whether anything supplies a userId to it — which is exactly how 343 routes
 * came to pass a null. So this file goes through `withApiErrorHandling`, with
 * the real `resolveRateLimitScope` and the real `enforceRateLimit`, and
 * asserts on the key the limiter is actually handed.
 *
 * `checkRateLimitDistributed` is the one thing stubbed, because it is the
 * storage round-trip and it receives the finished key — the observable this
 * file is about.
 */
import { NextRequest } from 'next/server';

// ── Bypasses off, or the limiter never runs ──────────────────────────
//
// `isRateLimitBypassed` has FOUR clauses, and the fourth is the one that
// matters here: it bypasses whenever NODE_ENV === 'test' unless
// RATE_LIMIT_ENABLED is explicitly '1'. Clearing the other three flags is not
// enough — under jest the limiter stays off, every key below would be one that
// was never built, and the file would pass while testing nothing.
beforeAll(() => {
    process.env.RATE_LIMIT_MODE = 'memory';
    delete process.env.AUTH_TEST_MODE;
    delete process.env.NEXT_TEST_MODE;
    // `RATE_LIMIT_ENABLED='1'` is REQUIRED, not merely "not 0". The fourth
    // clause of `isRateLimitBypassed` bypasses whenever NODE_ENV === 'test'
    // unless this is explicitly '1' — so deleting the three flags leaves the
    // limiter off, and every assertion here would read a key that was never
    // built. That is what the first control catches.
    process.env.RATE_LIMIT_ENABLED = '1';
});

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: unknown[]) => getToken(...a) }));

const checkRateLimitDistributed = jest.fn();
jest.mock('@/lib/rate-limit/mutationRateLimit', () => ({
    checkRateLimitDistributed: (...a: unknown[]) => checkRateLimitDistributed(...a),
    resetRateLimitDistributed: jest.fn(),
    __resetMutationLimitersForTests: jest.fn(),
}));

import { withApiErrorHandling } from '@/lib/errors/api';

/** The key `enforceRateLimit` handed the store on the last call. */
function lastKey(): string {
    expect(checkRateLimitDistributed).toHaveBeenCalled();
    return checkRateLimitDistributed.mock.calls.at(-1)?.[0] as string;
}

function post(path = 'https://app.agrent.bg/api/t/acme/journal'): NextRequest {
    return new NextRequest(path, {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.7', 'content-type': 'application/json' },
    });
}

beforeEach(() => {
    getToken.mockReset();
    checkRateLimitDistributed.mockReset();
    // Always allow — this file is about the KEY, not the verdict.
    checkRateLimitDistributed.mockResolvedValue({
        allowed: true,
        limit: 60,
        remaining: 59,
        retryAfterMs: 0,
        resetAt: Date.now() + 60_000,
    });
});

describe('an authenticated mutation is keyed by user, not IP alone', () => {
    it('control: the limiter is actually reached (bypasses are off)', () => {
        // Every assertion below reads the key the store was given. If the
        // bypass were still on, `checkRateLimitDistributed` would never be
        // called and `lastKey()` would throw rather than quietly pass.
        expect(process.env.RATE_LIMIT_ENABLED).toBe('1');
        expect(process.env.AUTH_TEST_MODE).toBeUndefined();
        expect(process.env.NEXT_TEST_MODE).toBeUndefined();
    });

    it('carries u:<sub> with no opt-in from the route', async () => {
        // THE REGRESSION TEST. The route passes no `getUserId` — exactly like
        // 343 of 346 route files — and must still be keyed by user.
        getToken.mockResolvedValue({ sub: 'usr_abc' });
        const handler = withApiErrorHandling(async () => new Response('{}', { status: 200 }));

        await handler(post(), { params: Promise.resolve({}) });

        expect(lastKey()).toBe('api-mutation:ip:203.0.113.7:u:usr_abc');
        expect(lastKey()).not.toContain('anon');
    });

    it('two users behind ONE carrier IP get separate buckets', async () => {
        // The CGNAT case in one assertion: same egress IP, different users,
        // different keys. Under the old behaviour both were
        // `…:ip:203.0.113.7:anon` and they shared a budget.
        const handler = withApiErrorHandling(async () => new Response('{}', { status: 200 }));

        getToken.mockResolvedValue({ sub: 'usr_one' });
        await handler(post(), { params: Promise.resolve({}) });
        const first = lastKey();

        getToken.mockResolvedValue({ sub: 'usr_two' });
        await handler(post(), { params: Promise.resolve({}) });
        const second = lastKey();

        expect(first).not.toBe(second);
        expect(first).toContain('u:usr_one');
        expect(second).toContain('u:usr_two');
        // ...and the IP half is genuinely shared, or the test proves nothing.
        expect(first).toContain('ip:203.0.113.7');
        expect(second).toContain('ip:203.0.113.7');
    });

    it('an unauthenticated caller still keys anon', async () => {
        getToken.mockResolvedValue(null);
        const handler = withApiErrorHandling(async () => new Response('{}', { status: 200 }));

        await handler(post(), { params: Promise.resolve({}) });

        expect(lastKey()).toBe('api-mutation:ip:203.0.113.7:anon');
    });

    it('a token decode that THROWS keys anon rather than 500ing the write', async () => {
        // Fail soft. An unreadable cookie must not turn a mutation into a 500,
        // and must not fail open either — anon is the tighter bucket.
        getToken.mockRejectedValue(new Error('JWEDecryptionFailed'));
        const handler = withApiErrorHandling(async () => new Response('{}', { status: 200 }));

        const res = await handler(post(), { params: Promise.resolve({}) });

        expect(res.status).toBe(200);
        expect(lastKey()).toBe('api-mutation:ip:203.0.113.7:anon');
    });

    it('an explicit getUserId still OVERRIDES the default', async () => {
        // The three routes that pass a resolver do so because the id bounding
        // the budget is not the caller's. That must keep working.
        getToken.mockResolvedValue({ sub: 'usr_admin' });
        const handler = withApiErrorHandling(
            async () => new Response('{}', { status: 200 }),
            { rateLimit: { getUserId: () => 'usr_target' } },
        );

        await handler(post(), { params: Promise.resolve({}) });

        expect(lastKey()).toContain('u:usr_target');
        expect(lastKey()).not.toContain('usr_admin');
    });

    it('getBucket still replaces the caller key, and skips the decode', async () => {
        // #1161: a bucketed route caps a SHARED resource, so the identity is
        // irrelevant — and resolving it would be a JWE decode thrown away.
        getToken.mockResolvedValue({ sub: 'usr_abc' });
        const handler = withApiErrorHandling(
            async () => new Response('{}', { status: 200 }),
            { rateLimit: { scope: 'exchange-message', getBucket: () => 't:acme' } },
        );

        await handler(post(), { params: Promise.resolve({}) });

        expect(lastKey()).toBe('exchange-message:t:acme');
        // The decode is skipped entirely on this path.
        expect(getToken).not.toHaveBeenCalled();
    });

    it('a GET is not rate-limited by this tier, and pays no decode', async () => {
        const handler = withApiErrorHandling(async () => new Response('{}', { status: 200 }));

        await handler(
            new NextRequest('https://app.agrent.bg/api/t/acme/journal', { method: 'GET' }),
            { params: Promise.resolve({}) },
        );

        expect(checkRateLimitDistributed).not.toHaveBeenCalled();
        expect(getToken).not.toHaveBeenCalled();
    });
});
