/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these surfaces. */

/**
 * The public-media tier must REFUSE A REQUEST at the Edge — P6.3 (#1812).
 *
 * ## Why this file exists rather than a limiter unit test
 *
 * `tests/unit/scim-rate-limit-enforced.test.ts` makes the argument and this
 * file is the same argument for a new tier: calling
 * `checkPublicMediaRateLimit(req)` directly proves the limiter COUNTS, and
 * cannot observe whether the middleware acts on the result. Delete the
 * enforcement line in `src/middleware.ts` — keeping the counters, dropping the
 * refusal — and a limiter unit test stays green.
 *
 * It also catches the likelier regression for a brand-new tier: somebody
 * deciding the two public prefixes can share one budget. §4 fails in that
 * case, which is the point — `/f/` sits at 60/min precisely because its assets
 * come from `/_next/static/*` and "do not count against the budget", and
 * serving images through an API route makes them count.
 *
 * ## Three ways this file could go vacuously green, each defended below
 *
 *   - `NEXT_TEST_MODE=1` / `AUTH_TEST_MODE=1` / `RATE_LIMIT_ENABLED=0` each
 *     short-circuit `isRateLimitBypassed()`. With any set, 301 requests all
 *     return 200 and nothing 429s. `process.env` leaks between test FILES in a
 *     jest worker, so §0 asserts at run time that none is set.
 *   - `method: 'OPTIONS'` never reaches the tier at all — the CORS preflight
 *     answers 204 unconditionally. Every request here is a GET.
 *   - A request with no `x-forwarded-for` is keyed to the literal
 *     `'127.0.0.1'`, silently sharing one bucket with every other IP-less
 *     request in the worker. `mediaReq()` always sets it.
 */
import { NextRequest } from 'next/server';

// Stub ONLY the other tiers' async budget checks, so a 429 in this file can
// only have come from the media tier. Spreading requireActual keeps the pure
// path predicates real — they decide WHICH stage a request reaches, and a bare
// object literal yields `undefined` for every omitted export, which surfaces
// as "is not a function" once a request gets far enough down the middleware.
jest.mock('@/lib/rate-limit/authRateLimit', () => ({
    ...jest.requireActual('@/lib/rate-limit/authRateLimit'),
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('@/lib/rate-limit/apiReadRateLimit', () => ({
    ...jest.requireActual('@/lib/rate-limit/apiReadRateLimit'),
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOT mocked, deliberately: `publicMediaRateLimit` (the subject),
// `publicReadRateLimit` (so §4 observes the REAL other tier rather than a
// double), `@/lib/security/rate-limit` (the real budgets) and
// `@/lib/auth/guard` (whether the branch is reachable at all).
const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: any[]) => getToken(...a) }));

import middleware from '@/middleware';
import {
    _clearPublicMediaRateLimitMemory,
    isPublicMediaRateLimited,
} from '@/lib/rate-limit/publicMediaRateLimit';
import {
    _clearPublicReadRateLimitMemory,
    isPublicReadRateLimited,
} from '@/lib/rate-limit/publicReadRateLimit';
import { PUBLIC_MEDIA_LIMIT, PUBLIC_READ_LIMIT } from '@/lib/security/rate-limit';

function pinEnv(): void {
    process.env.RATE_LIMIT_MODE = 'memory'; // never build a real Upstash client
    delete process.env.RATE_LIMIT_ENABLED; // Proxy default '1' ⇒ enforced
    process.env.AUTH_TEST_MODE = '0';
    delete process.env.NEXT_TEST_MODE;
}
pinEnv();

const IP = '203.0.113.41';
const HASH = 'b'.repeat(64);

/** A media-tier request. GET, never OPTIONS — see the docblock. */
function mediaReq(ip = IP, pathname = `/api/public/media/${HASH}`) {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method: 'GET',
        headers: { 'x-forwarded-for': ip },
    });
}

beforeEach(() => {
    pinEnv();
    _clearPublicMediaRateLimitMemory();
    _clearPublicReadRateLimitMemory();
    getToken.mockReset();
});

describe('§0 — the bypasses that would make this file vacuous are OFF', () => {
    it('no bypass env var is set', () => {
        expect({
            RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
            AUTH_TEST_MODE: process.env.AUTH_TEST_MODE,
            NEXT_TEST_MODE: process.env.NEXT_TEST_MODE,
        }).toEqual({
            RATE_LIMIT_ENABLED: undefined,
            AUTH_TEST_MODE: '0',
            NEXT_TEST_MODE: undefined,
        });
    });

    it('the budget is the one this file assumes', () => {
        // If somebody retunes the limit, the loop counts below are wrong and
        // this says so instead of the §1 assertion failing confusingly.
        expect(PUBLIC_MEDIA_LIMIT.maxAttempts).toBe(300);
        expect(PUBLIC_MEDIA_LIMIT.windowMs).toBe(60_000);
    });
});

describe('§1 — the middleware REFUSES over-budget media requests', () => {
    it(`request ${PUBLIC_MEDIA_LIMIT.maxAttempts + 1} gets a 429`, async () => {
        for (let i = 0; i < PUBLIC_MEDIA_LIMIT.maxAttempts; i++) {
            const res = await middleware(mediaReq());
            // Not 429 — the handler is not reached in this harness, so what
            // matters is only that the Edge let it past.
            expect(res.status).not.toBe(429);
        }
        const over = await middleware(mediaReq());
        expect(over.status).toBe(429);
    }, 60_000);

    it('a DIFFERENT IP is unaffected — the key is per-IP', async () => {
        for (let i = 0; i < PUBLIC_MEDIA_LIMIT.maxAttempts + 1; i++) {
            await middleware(mediaReq(IP));
        }
        const other = await middleware(mediaReq('198.51.100.9'));
        expect(other.status).not.toBe(429);
    }, 60_000);
});

describe('§2 — the predicate claims the right population', () => {
    it('claims a media child path, and only GET', () => {
        expect(isPublicMediaRateLimited('GET', `/api/public/media/${HASH}`)).toBe(true);
        // A mutating method is somebody else's problem by design: the route
        // exports only GET, and a future mutating export must not inherit
        // this budget silently.
        expect(isPublicMediaRateLimited('POST', `/api/public/media/${HASH}`)).toBe(false);
    });

    it('does NOT claim a sibling that merely shares the spelling', () => {
        // The trailing slash in the prefix. Over-throttling leaks nothing but
        // takes the product down, which is the other failure axis.
        expect(isPublicMediaRateLimited('GET', '/api/public/mediaX')).toBe(false);
        expect(isPublicMediaRateLimited('GET', '/api/public/media-debug')).toBe(false);
    });
});

describe('§3 — the two public tiers are separate buckets', () => {
    it('the public-read tier does not claim media', () => {
        // If it did, media would inherit 60/min and §4 would be impossible.
        expect(isPublicReadRateLimited('GET', `/api/public/media/${HASH}`)).toBe(false);
    });

    it(`§4 — ${PUBLIC_READ_LIMIT.maxAttempts + 1} media requests do NOT 429`, async () => {
        // The regression this file exists to catch for a NEW tier: somebody
        // folding the media prefix into the public-read list. Under that
        // change this fails at request 61, which is exactly the visitor
        // experience the separate budget exists to prevent — a broken image
        // on the ninth or tenth profile, reported as nothing at all.
        for (let i = 0; i < PUBLIC_READ_LIMIT.maxAttempts + 1; i++) {
            const res = await middleware(mediaReq());
            expect(res.status).not.toBe(429);
        }
    }, 60_000);
});
