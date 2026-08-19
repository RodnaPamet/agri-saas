/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these surfaces (see tests/unit/cors.test.ts). */

/**
 * A SCIM request must REACH its handler.
 *
 * ## The bug this file exists for
 *
 * SCIM 2.0 provisioning shipped complete — token minting, hashing, revocation,
 * tenant isolation, an admin UI, Users and Groups endpoints, integration tests.
 * And no SCIM request had EVER reached a handler. `src/middleware.ts` called
 * `getToken()`, which understands only a NextAuth JWE and returned `null` for
 * an opaque `scim_…` bearer, and the next line 401'd it. Okta or Entra
 * configured against this app would have seen nothing but
 * `{"error":"Unauthorized"}` from the first day.
 *
 * ## Why the existing tests could not see it
 *
 * `tests/integration/scim.test.ts` and `scim-isolation.test.ts` import
 * `authenticateScimRequest` from `@/lib/scim/auth` and hand it a `NextRequest`
 * they built themselves. They prove the auth FUNCTION is correct — which it
 * was, all along. Nothing in the suite crossed the middleware, so nothing
 * could observe that the function was never called.
 *
 * That is the same shape as the `token.error` bug (see
 * `tests/unit/session-revocation-enforced.test.ts`) and the dead `iflk_`
 * API-key path: a complete, well-tested mechanism severed at the enforcement
 * seam, with no test spanning the seam. This file spans it.
 *
 * ## What this file does and does not prove
 *
 * It drives the REAL `src/middleware.ts` in-process. That covers the seam and
 * runs on every CI shard. It does NOT open a socket, so it cannot see a Next
 * upgrade that changes how `NextResponse.next()` is serialised — the
 * socket-level backstop is `tests/e2e/scim-provisioning.spec.ts`.
 */
import { NextRequest } from 'next/server';

jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: any[]) => getToken(...a) }));

import middleware, { config } from '../../src/middleware';
import { isPublicPath } from '../../src/lib/auth/guard';

/** A SCIM bearer is opaque, so `getToken` cannot make sense of it. */
const SCIM_BEARER = 'scim_ZmFrZS10b2tlbi1mb3ItdGVzdHM';

function scimRequest(pathname: string, method = 'GET') {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method,
        headers: { authorization: `Bearer ${SCIM_BEARER}` },
    });
}

beforeEach(() => {
    getToken.mockReset();
    // What actually happens in production: next-auth cannot decrypt an opaque
    // bearer, so it yields null. This is the precondition of the whole bug.
    getToken.mockResolvedValue(null);
});

describe('the middleware matcher covers SCIM at all', () => {
    it('compiles the REAL exported matcher and matches a SCIM path', () => {
        // Built from `config.matcher` rather than restating the pattern, so a
        // change to the matcher is caught here instead of silently excluding
        // SCIM from the middleware and making the rest of this file vacuous.
        const re = new RegExp(config.matcher[0]);
        expect(re.test('/api/scim/v2/Users')).toBe(true);
    });
});

describe('a SCIM request passes the Edge instead of being 401d', () => {
    const SCIM_PATHS = [
        '/api/scim/v2/Users',
        '/api/scim/v2/Users/abc123',
        '/api/scim/v2/Groups',
        '/api/scim/v2/Groups/abc123',
        '/api/scim/v2/ServiceProviderConfig',
    ];

    it.each(SCIM_PATHS)('%s is not refused by the middleware', async (pathname) => {
        const res = await middleware(scimRequest(pathname));
        // A pass-through is `NextResponse.next()`, which carries this header.
        // The failure mode being guarded is a 401 whose body is the Edge's
        // generic `{"error":"Unauthorized"}` — the exact response every real
        // SCIM client received before the carve-out.
        expect(res.status).not.toBe(401);
        expect(res.headers.get('x-middleware-next')).toBe('1');
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
        'a %s write also passes — provisioning is not read-only',
        async (method) => {
            const res = await middleware(scimRequest('/api/scim/v2/Users/abc123', method));
            expect(res.status).not.toBe(401);
        },
    );

    it('still 401s a NORMAL api route with the same unusable bearer', async () => {
        // The negative control. Without it, a middleware that stopped
        // rejecting ANYTHING would pass every assertion above.
        const res = await middleware(scimRequest('/api/t/acme-corp/journal'));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('still 401s the ADMIN route that mints SCIM tokens', async () => {
        // `/api/t/:slug/admin/scim` is where a tenant OWNER creates a token.
        // It must stay behind the session gate — if the carve-out ever widened
        // to cover it, anyone could mint themselves a provisioning credential.
        const res = await middleware(scimRequest('/api/t/acme-corp/admin/scim', 'POST'));
        expect(res.status).toBe(401);
    });
});

describe('the carve-out is exactly as wide as intended', () => {
    // `isPublicPath` is a `startsWith` test, so the trailing slash is
    // load-bearing: '/api/scim' (no slash) would also open '/api/scimulator'
    // or any future '/api/scim-admin'. Pin the boundary.
    it.each([
        ['/api/scim/v2/Users', true],
        ['/api/scim/v2/Groups/xyz', true],
        ['/api/scim/v2/ServiceProviderConfig', true],
        ['/api/scimulator', false],
        ['/api/scim-admin/tokens', false],
        ['/api/t/acme/admin/scim', false],
        ['/api/t/acme/journal', false],
    ] as const)('isPublicPath(%s) === %s', (pathname, expected) => {
        expect(isPublicPath(pathname)).toBe(expected);
    });
});
