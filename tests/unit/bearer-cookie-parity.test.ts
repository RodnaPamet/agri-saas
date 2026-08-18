/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken). Standard pattern for this
 * surface; see tests/unit/cors.test.ts. */

/**
 * A bearer must get the SAME tenant-access answer as a cookie.
 *
 * This is the requirement most likely to be satisfied in appearance and broken
 * in fact, so it is asserted DIFFERENTIALLY: the identical claims are presented
 * once as a cookie and once as a bearer, and the two answers are compared to
 * each other rather than each to a hand-written expectation. A test that
 * asserted "bearer returns allow" would pass just as happily against an
 * implementation that returned allow for everything.
 *
 * The case that matters most is `membershipsTruncated`. `checkTenantAccess`
 * returns 'allow' for an unlisted slug when the list was capped, deferring the
 * real decision to the DB-backed server gate (guard.ts). A user in more than
 * MAX_JWT_MEMBERSHIPS tenants therefore depends on that deferral — and before
 * the bearer principal existed, the gate it deferred TO had no principal under
 * a bearer, so the same request succeeded with a cookie and 401'd with a token.
 */
import { NextRequest } from 'next/server';
import { checkTenantAccess, MAX_JWT_MEMBERSHIPS_PROBE } from './__bearer-parity-helpers';

jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
// Mock ALL THREE names middleware imports from this module. Mocking only
// `checkApiReadRateLimit` leaves `isApiReadRateLimited` undefined, which throws
// inside middleware and produces a failure that looks like an auth bug.
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ allowed: true, ok: true }),
    isApiReadRateLimited: jest.fn().mockReturnValue(false),
    extractTenantSlug: (p: string) => (p.match(/^\/api\/t\/([^/]+)/)?.[1] ?? null),
}));

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: any[]) => getToken(...a) }));

import middleware from '../../src/middleware';

/** Identical claims; only the transport differs. */
function claims(overrides: Record<string, unknown> = {}) {
    return {
        userId: 'usr_parity',
        sub: 'usr_parity',
        tenantId: 'tnt_1',
        tenantSlug: 'acme-corp',
        role: 'ADMIN',
        userSessionId: 'sess_parity',
        memberships: [{ tenantId: 'tnt_1', tenantSlug: 'acme-corp', slug: 'acme-corp', role: 'ADMIN' }],
        membershipsTruncated: false,
        ...overrides,
    };
}

function reqWith(pathname: string, headers: Record<string, string> = {}) {
    return new NextRequest(`http://localhost:3000${pathname}`, { method: 'GET', headers });
}

beforeEach(() => getToken.mockReset());

/**
 * Drive middleware twice with the same claims — once as if a cookie carried
 * them, once as if a bearer did — and return both outcomes for comparison.
 *
 * getToken is the SINGLE locator for both transports in the real code
 * (next-auth/jwt reads the cookie, then falls back to the Authorization
 * header), which is exactly why one mock faithfully represents both.
 */
async function bothTransports(pathname: string, tokenClaims: Record<string, unknown>) {
    getToken.mockResolvedValue(tokenClaims);
    const viaCookie = await middleware(reqWith(pathname), {} as any);

    getToken.mockResolvedValue(tokenClaims);
    const viaBearer = await middleware(
        reqWith(pathname, { authorization: 'Bearer fake.jwe.value' }),
        {} as any,
    );

    return {
        cookie: { status: viaCookie.status, location: viaCookie.headers.get('location') },
        bearer: { status: viaBearer.status, location: viaBearer.headers.get('location') },
    };
}

describe('bearer and cookie receive identical tenant-access decisions', () => {
    it('a member of the tenant is allowed on BOTH transports', async () => {
        const r = await bothTransports('/api/t/acme-corp/tasks', claims());
        expect(r.bearer).toEqual(r.cookie);
        expect(r.bearer.status).not.toBe(401);
    });

    it('a NON-member is refused on BOTH transports, identically', async () => {
        const r = await bothTransports(
            '/api/t/other-farm/tasks',
            claims({ memberships: [{ slug: 'acme-corp' }], membershipsTruncated: false }),
        );
        expect(r.bearer).toEqual(r.cookie);
        expect(r.bearer.status).toBeGreaterThanOrEqual(400);
    });

    it('THE TRUNCATED CASE: an unlisted slug defers on BOTH transports', async () => {
        // The >50-tenant user. Middleware must return 'allow' and hand the
        // decision to the DB-backed gate for a bearer exactly as for a cookie.
        // Before the bearer principal existed the two diverged HERE: middleware
        // allowed both, then the server gate had no principal for the bearer.
        const r = await bothTransports(
            '/api/t/tenant-51/tasks',
            claims({
                memberships: Array.from({ length: MAX_JWT_MEMBERSHIPS_PROBE }, (_, i) => ({
                    slug: `tenant-${i}`,
                })),
                membershipsTruncated: true,
            }),
        );
        expect(r.bearer).toEqual(r.cookie);
        expect(r.bearer.status).not.toBe(403);
    });

    it('a revoked session is refused on BOTH transports', async () => {
        const r = await bothTransports('/api/t/acme-corp/tasks', claims({ error: 'SessionRevoked' }));
        expect(r.bearer).toEqual(r.cookie);
        expect(r.bearer.status).toBe(401);
    });
});

describe('checkTenantAccess itself is transport-blind', () => {
    // The unit beneath the middleware: it takes claims, not a request, so it
    // CANNOT know the transport. Asserting that directly is what makes the
    // differential tests above meaningful rather than coincidental.
    it('returns the same answer for the same claims, however they arrived', () => {
        const memberships = [{ slug: 'acme-corp' }];
        expect(checkTenantAccess('/api/t/acme-corp/x', memberships, false))
            .toBe(checkTenantAccess('/api/t/acme-corp/x', memberships, false));
        expect(checkTenantAccess('/api/t/nope/x', memberships, true)).toBe('allow');
        expect(checkTenantAccess('/api/t/nope/x', memberships, false)).not.toBe('allow');
    });
});
