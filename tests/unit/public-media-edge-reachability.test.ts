/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these surfaces. */

/**
 * `/api/public/media/{hash}` is reachable at the Edge — anonymously, with a
 * cookie, and with a bearer. P6.3 (#1812).
 *
 * ## Why all three, and not just the anonymous case
 *
 * #1812's standing rule is "HTTP test through the real middleware, cookie AND
 * bearer (iOS reads media)", and the parenthesis is the reason. The obvious
 * case is a stranger with a shared link. The one that breaks quietly is a
 * SIGNED-IN reader: the phone fetches the same images while carrying a bearer,
 * and a public path that only works without credentials would fail for exactly
 * the users most likely to look.
 *
 * A credential must therefore be IGNORED here rather than merely tolerated.
 * `isPublicPath` returns before `getToken()` is ever called, which is the
 * property under test — and it is a property of the middleware's control flow,
 * not of the route, so only driving the real middleware can observe it.
 *
 * ## The controls are the point
 *
 * "not 401" is satisfied by a middleware that 401s nothing, so each case has a
 * counterpart that MUST 401: a tenant route with the same credential, and the
 * sibling path `/api/public/mediaX`. The sibling is the sharper one — it proves
 * the prefix's trailing slash is doing its job against the LIVE predicate
 * rather than in a unit test of the list.
 */
import { NextRequest } from 'next/server';

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: any[]) => getToken(...a) }));

// The other tiers' budgets are stubbed so a 429 cannot be mistaken for a 401
// and so 25 requests in a worker cannot trip anything.
jest.mock('@/lib/rate-limit/authRateLimit', () => ({
    ...jest.requireActual('@/lib/rate-limit/authRateLimit'),
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('@/lib/rate-limit/apiReadRateLimit', () => ({
    ...jest.requireActual('@/lib/rate-limit/apiReadRateLimit'),
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('@/lib/rate-limit/publicMediaRateLimit', () => ({
    ...jest.requireActual('@/lib/rate-limit/publicMediaRateLimit'),
    checkPublicMediaRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));

import middleware from '@/middleware';

const HASH = 'a'.repeat(64);
const MEDIA = `/api/public/media/${HASH}`;

/** A request with no credential at all. */
function anon(pathname: string) {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method: 'GET',
        headers: { 'x-forwarded-for': '203.0.113.77' },
    });
}

/** A request carrying a NextAuth session cookie — what the web sends. */
function withCookie(pathname: string) {
    const req = anon(pathname);
    req.cookies.set('next-auth.session-token', 'a-session-token');
    return req;
}

/** A request carrying a bearer — what the phone sends. */
function withBearer(pathname: string) {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method: 'GET',
        headers: {
            'x-forwarded-for': '203.0.113.77',
            authorization: 'Bearer an-access-token',
        },
    });
}

beforeEach(() => {
    getToken.mockReset();
    // Null by default: an unauthenticated visitor, and also what `getToken`
    // returns for a bearer it cannot parse.
    getToken.mockResolvedValue(null);
});

describe('the media route is reachable at the Edge', () => {
    it('anonymously', async () => {
        const res = await middleware(anon(MEDIA));
        expect(res.status).not.toBe(401);
    });

    it('with a session cookie, and WITHOUT consulting the token', async () => {
        const res = await middleware(withCookie(MEDIA));
        expect(res.status).not.toBe(401);
        // The property, not just the outcome: `isPublicPath` returns before
        // `getToken()` is called. A middleware that authenticated first and
        // then decided the path was public would pass the assertion above
        // while making every image fetch cost a token verification.
        expect(getToken).not.toHaveBeenCalled();
    });

    it('with a bearer — the case the phone exercises', async () => {
        const res = await middleware(withBearer(MEDIA));
        expect(res.status).not.toBe(401);
        expect(getToken).not.toHaveBeenCalled();
    });

    it('with a VALID session, which must not be treated differently', async () => {
        // A signed-in farmer looking at another farm's page. Returning a real
        // token here would be the state in which a path that accidentally
        // depended on tenant membership would still pass.
        getToken.mockResolvedValue({
            userId: 'usr_1',
            sub: 'usr_1',
            tenantId: 'tnt_1',
            tenantSlug: 'acme-corp',
            role: 'ADMIN',
        });
        const res = await middleware(withCookie(MEDIA));
        expect(res.status).not.toBe(401);
    });
});

describe('the controls — what MUST still be refused', () => {
    it('a tenant route with no credential 401s', async () => {
        // Without this, every "not 401" above is satisfied by a middleware
        // that refuses nothing at all.
        const res = await middleware(anon('/api/t/acme-corp/journal'));
        expect(res.status).toBe(401);
    });

    it('a SIBLING path that merely shares the spelling 401s', async () => {
        // The trailing slash on `/api/public/media/`, measured against the
        // live predicate. Only a sibling can show that the prefix did not
        // over-match; a child could not.
        for (const sibling of ['/api/public/mediaX', '/api/public/media-debug']) {
            const res = await middleware(anon(sibling));
            expect({ sibling, status: res.status }).toEqual({ sibling, status: 401 });
        }
    });

    it('the BARE path 401s — it has no handler', async () => {
        // Deliberate: `/api/public/media` is gated because nothing serves it,
        // and a 401 is the honest answer for an API path rather than a
        // redirect to a login page an anonymous visitor has no account for.
        const res = await middleware(anon('/api/public/media'));
        expect(res.status).toBe(401);
    });
});
