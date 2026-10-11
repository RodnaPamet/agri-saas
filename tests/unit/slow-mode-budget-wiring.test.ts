/**
 * P5.5a — slow mode reaches the limiter, and reaches ONLY what it should
 * (#1596).
 *
 * The sibling `tests/unit/slow-mode-policy.test.ts` pins the policy as a pure
 * function. This file drives the real `withApiErrorHandling` and asserts on
 * the CONFIG the store is handed, because the policy being right says nothing
 * about whether any route reaches it — which is the `rate-limit-keyed-by-user`
 * lesson verbatim: that mechanism worked and 343 of 346 routes never used it.
 *
 * Three negatives matter as much as the positive, and each is a place where
 * applying slow mode would be actively wrong rather than merely unnecessary:
 *
 *   - a route with an EXPLICIT preset keeps it (every such preset today is
 *     already tighter, so overriding would LOOSEN the route);
 *   - a BUCKETED route is untouched (the bucket caps a shared resource, so
 *     narrowing it for one caller throttles everyone sharing it);
 *   - a `getUserId` OVERRIDE route is untouched (the id bounding that budget
 *     is the TARGET user, not the caller).
 *
 * `checkRateLimitDistributed` is the one thing stubbed — it receives the
 * finished key and config, which is the observable here.
 */
import { NextRequest } from 'next/server';

// ── Bypasses off, or the limiter never runs ──────────────────────────
//
// `RATE_LIMIT_ENABLED='1'` is REQUIRED, not merely "not 0": the fourth clause
// of `isRateLimitBypassed` bypasses whenever NODE_ENV === 'test' unless this
// is explicitly '1'. Without it the store is never called and every assertion
// below would read a config that was never built.
beforeAll(() => {
    process.env.RATE_LIMIT_MODE = 'memory';
    delete process.env.AUTH_TEST_MODE;
    delete process.env.NEXT_TEST_MODE;
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
import {
    API_MUTATION_LIMIT,
    SLOW_MODE_MUTATION_LIMIT,
    LOGIN_LIMIT,
} from '@/lib/security/rate-limit';

const DAY = 24 * 60 * 60 * 1000;

/** The config the store was handed on the last call. */
function lastConfig(): { maxAttempts: number } {
    expect(checkRateLimitDistributed).toHaveBeenCalled();
    const call = checkRateLimitDistributed.mock.calls.at(-1)!;
    // The config rides alongside the key; find it by shape rather than by
    // position, so an argument-order change fails loudly instead of reading
    // `undefined.maxAttempts` as a pass.
    const found = call.find(
        (a: unknown) => typeof a === 'object' && a !== null && 'maxAttempts' in a,
    );
    expect(found).toBeDefined();
    return found as { maxAttempts: number };
}

function lastKey(): string {
    return checkRateLimitDistributed.mock.calls.at(-1)?.[0] as string;
}

function post(path = 'https://app.agrent.bg/api/t/acme/journal'): NextRequest {
    return new NextRequest(path, {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.7', 'content-type': 'application/json' },
    });
}

/** A token for an account that is verified and established. */
function establishedToken() {
    return {
        sub: 'usr_established',
        emailVerifiedAt: Date.now() - 400 * DAY,
        accountCreatedAt: Date.now() - 400 * DAY,
    };
}

/** A token for an account that is verified but only a day old. */
function newToken() {
    return {
        sub: 'usr_new',
        emailVerifiedAt: Date.now() - DAY,
        accountCreatedAt: Date.now() - DAY,
    };
}

const ok = async () => new Response('{}', { status: 200 });

beforeEach(() => {
    getToken.mockReset();
    checkRateLimitDistributed.mockReset();
    checkRateLimitDistributed.mockResolvedValue({
        allowed: true,
        limit: 60,
        remaining: 59,
        retryAfterMs: 0,
        resetAt: Date.now() + 60_000,
    });
});

describe('slow mode narrows the default mutation tier', () => {
    it('control: the limiter is actually reached (bypasses are off)', async () => {
        // Without this, every assertion below would be about a call that never
        // happened, and `lastConfig()` would throw rather than pass quietly.
        expect(process.env.RATE_LIMIT_ENABLED).toBe('1');
        getToken.mockResolvedValue(establishedToken());
        await withApiErrorHandling(ok)(post(), { params: Promise.resolve({}) });
        expect(checkRateLimitDistributed).toHaveBeenCalled();
    });

    it('an ESTABLISHED account gets the full budget', async () => {
        getToken.mockResolvedValue(establishedToken());
        await withApiErrorHandling(ok)(post(), { params: Promise.resolve({}) });

        expect(lastConfig().maxAttempts).toBe(API_MUTATION_LIMIT.maxAttempts);
    });

    it('a NEW account gets the reduced budget', async () => {
        getToken.mockResolvedValue(newToken());
        await withApiErrorHandling(ok)(post(), { params: Promise.resolve({}) });

        expect(lastConfig().maxAttempts).toBe(SLOW_MODE_MUTATION_LIMIT.maxAttempts);
        // And strictly tighter, so the preset cannot be edited into a no-op.
        expect(SLOW_MODE_MUTATION_LIMIT.maxAttempts)
            .toBeLessThan(API_MUTATION_LIMIT.maxAttempts);
    });

    it('an UNVERIFIED but old account gets the reduced budget', async () => {
        getToken.mockResolvedValue({
            sub: 'usr_unverified',
            emailVerifiedAt: null,
            accountCreatedAt: Date.now() - 400 * DAY,
        });
        await withApiErrorHandling(ok)(post(), { params: Promise.resolve({}) });

        expect(lastConfig().maxAttempts).toBe(SLOW_MODE_MUTATION_LIMIT.maxAttempts);
    });

    it('a PRE-P5.5a session keeps the full budget', async () => {
        // The deploy-day case: a token minted before the claims existed. This
        // must not throttle, or every logged-in user is slowed on release.
        getToken.mockResolvedValue({ sub: 'usr_old_session' });
        await withApiErrorHandling(ok)(post(), { params: Promise.resolve({}) });

        expect(lastConfig().maxAttempts).toBe(API_MUTATION_LIMIT.maxAttempts);
    });

    it('keys the slow bucket separately, so the two are attributable', async () => {
        getToken.mockResolvedValue(newToken());
        await withApiErrorHandling(ok)(post(), { params: Promise.resolve({}) });

        expect(lastKey()).toContain('slow');
        expect(lastKey()).toContain('u:usr_new');
    });
});

describe('slow mode does NOT reach the three places it would be wrong', () => {
    it('leaves a route with an EXPLICIT preset alone', async () => {
        // Every explicit preset today is already tighter than the slow tier,
        // so overriding one would LOOSEN that route for a slow-mode account.
        getToken.mockResolvedValue(newToken());
        const handler = withApiErrorHandling(ok, {
            rateLimit: { config: LOGIN_LIMIT, scope: 'explicit' },
        });

        await handler(post(), { params: Promise.resolve({}) });

        expect(lastConfig().maxAttempts).toBe(LOGIN_LIMIT.maxAttempts);
        expect(lastConfig().maxAttempts)
            .not.toBe(SLOW_MODE_MUTATION_LIMIT.maxAttempts);
    });

    it('leaves a BUCKETED route alone', async () => {
        // `getBucket` REPLACES the per-caller key: the budget caps a shared
        // resource, so narrowing it for one caller throttles every caller
        // sharing that bucket.
        getToken.mockResolvedValue(newToken());
        const handler = withApiErrorHandling(ok, {
            rateLimit: { getBucket: () => 'shared-resource-1' },
        });

        await handler(post(), { params: Promise.resolve({}) });

        expect(lastConfig().maxAttempts).toBe(API_MUTATION_LIMIT.maxAttempts);
    });

    it('leaves a getUserId OVERRIDE route alone', async () => {
        // That option exists because the id bounding the budget is NOT the
        // caller — it is a target user. The caller's account state is not a
        // statement about the target's budget.
        getToken.mockResolvedValue(newToken());
        const handler = withApiErrorHandling(ok, {
            rateLimit: { getUserId: () => 'usr_target' },
        });

        await handler(post(), { params: Promise.resolve({}) });

        expect(lastConfig().maxAttempts).toBe(API_MUTATION_LIMIT.maxAttempts);
    });

    it('leaves an ANONYMOUS caller on the default tier', async () => {
        // Slow mode is a statement about an ACCOUNT, and there is none here.
        // An anon caller is keyed per-IP, so applying a reduced per-account
        // budget would punish a whole CGNAT egress — the exact defect
        // `rate-limit-identity` was written to remove.
        getToken.mockResolvedValue(null);
        await withApiErrorHandling(ok)(post(), { params: Promise.resolve({}) });

        expect(lastConfig().maxAttempts).toBe(API_MUTATION_LIMIT.maxAttempts);
    });

    it('leaves the caller on the default tier when the token is unreadable', async () => {
        // Fail SOFT, as `resolveRequestIdentity` promises. A thrown decode
        // must not become a 500 on a write path.
        getToken.mockRejectedValue(new Error('bad JWE'));
        await withApiErrorHandling(ok)(post(), { params: Promise.resolve({}) });

        expect(lastConfig().maxAttempts).toBe(API_MUTATION_LIMIT.maxAttempts);
    });
});
