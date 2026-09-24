/**
 * A tenant API key must REACH its handler.
 *
 * ## The bug this exists to stop recurring
 *
 * An `iflk_` key never authenticated a request, on any deployment, from the
 * day the feature shipped until 2026-09-24. `src/middleware.ts` called
 * `getToken()`, which accepts an `Authorization: Bearer` header and then runs
 * the value through NextAuth's JWE decode. An `iflk_` token is not a JWE, so
 * decode threw, `getToken` returned null, and the middleware answered
 * `401 {"error":"Unauthorized"}` before any handler — and therefore before
 * `verifyApiKey` — ran. The admin UI minted keys throughout and told operators
 * to copy them.
 *
 * ## Why it survived so long
 *
 * The only CI signal was a source-text grep for `API_KEY_PREFIX`, and it
 * stayed green for the entire life of the bug, because the constant existed
 * and was used — just never reached. A test that reads source cannot tell
 * "wired" from "reachable".
 *
 * So this file drives the REAL middleware and asserts behaviour: the request
 * is passed onward, the neighbouring paths are not, and a request without the
 * credential is still refused. Its sibling
 * `tests/guards/tenant-api-routes-self-authenticate.test.ts` proves the other
 * half — that what lies beyond the carve-out authenticates. Neither
 * substitutes for the other.
 */
import { NextRequest } from 'next/server';

jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));

const checkApiKeyRateLimit = jest.fn();
jest.mock('../../src/lib/rate-limit/apiKeyRateLimit', () => ({
    ...jest.requireActual('../../src/lib/rate-limit/apiKeyRateLimit'),
    checkApiKeyRateLimit: (...a: unknown[]) => checkApiKeyRateLimit(...a),
}));

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: unknown[]) => getToken(...a) }));

import middleware from '../../src/middleware';

const KEY = 'Bearer iflk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function get(pathname: string, headers: Record<string, string> = {}) {
    return new NextRequest(`http://localhost:3000${pathname}`, { method: 'GET', headers });
}

beforeEach(() => {
    getToken.mockReset();
    // The precondition of the whole bug: a machine client has no session
    // cookie, and next-auth cannot make a token out of an `iflk_` string.
    getToken.mockResolvedValue(null);
    checkApiKeyRateLimit.mockReset();
    checkApiKeyRateLimit.mockResolvedValue({ ok: true });
});

describe('an API-key request passes the Edge', () => {
    it('GET /api/t/<slug>/journal with an iflk_ bearer is not refused', async () => {
        const res = await middleware(get('/api/t/acme-corp/journal', { authorization: KEY }));
        expect(res.status).not.toBe(401);
        // `NextResponse.next()` — the request was allowed onward.
        expect(res.headers.get('x-middleware-next')).toBe('1');
    });

    it('the same request WITHOUT the bearer is still refused', async () => {
        // Negative control. Without it, a middleware that stopped refusing
        // anything would satisfy the assertion above.
        const res = await middleware(get('/api/t/acme-corp/journal'));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('a bearer that is not an API key is still refused', async () => {
        // The carve-out keys on the `iflk_` prefix, not on the mere presence
        // of an Authorization header — otherwise any bearer would walk in.
        const res = await middleware(
            get('/api/t/acme-corp/journal', { authorization: 'Bearer not-an-api-key' }),
        );
        expect(res.status).toBe(401);
    });

    it('does NOT claim paths outside /api/t', async () => {
        // The carve-out is bounded, and the assertion has to be about what THIS
        // change claims rather than about the response.
        //
        // `/api/scim/…` and `/api/admin/tenants` are already public at the Edge
        // for their own documented reasons, so they pass onward whatever this
        // carve-out does; asserting a 401 there failed, and the failure was the
        // test's, not the code's. What must hold is that the API-key path was
        // never entered for them — `checkApiKeyRateLimit` is the observable
        // that says so, because the carve-out cannot admit a request without
        // consulting it first.
        for (const pathname of ['/api/admin/tenants', '/api/scim/v2/Users', '/api/tenants']) {
            checkApiKeyRateLimit.mockClear();
            await middleware(get(pathname, { authorization: KEY }));
            expect(checkApiKeyRateLimit).not.toHaveBeenCalled();
        }
    });

    it('refuses a non-public path outside /api/t that carries a key', async () => {
        // The status-level half, on a path that has no carve-out of its own:
        // `/api/t` without the trailing slash would also claim `/api/tenants`.
        const res = await middleware(get('/api/tenants', { authorization: KEY }));
        expect(res.status).toBe(401);
    });

    it('a page route is not opened by an API key', async () => {
        // Pages redirect rather than 401, so assert on the carve-out's own
        // signal instead of a status: the request must not be passed onward
        // as authenticated.
        const res = await middleware(get('/t/acme-corp/journal', { authorization: KEY }));
        expect(res.headers.get('x-middleware-next')).not.toBe('1');
    });
});

describe('the carve-out is budgeted', () => {
    it('a rate-limited key gets 429, not a free pass', async () => {
        // The carve-out makes /api/t a surface where an anonymous caller
        // reaches a key-hash comparison. If the limiter's refusal were
        // computed and dropped, the budget would not exist.
        const { NextResponse } = await import('next/server');
        checkApiKeyRateLimit.mockResolvedValue({
            ok: false,
            response: NextResponse.json({ error: 'Too many requests' }, { status: 429 }),
        });
        const res = await middleware(get('/api/t/acme-corp/journal', { authorization: KEY }));
        expect(res.status).toBe(429);
    });

    it('the limiter is consulted for API-key requests and not for others', async () => {
        await middleware(get('/api/t/acme-corp/journal', { authorization: KEY }));
        expect(checkApiKeyRateLimit).toHaveBeenCalledTimes(1);

        checkApiKeyRateLimit.mockClear();
        await middleware(get('/api/t/acme-corp/journal'));
        expect(checkApiKeyRateLimit).not.toHaveBeenCalled();
    });
});
