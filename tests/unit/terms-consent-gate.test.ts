/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these middleware harnesses (see
 * tests/unit/person-path-parity.test.ts). */

/**
 * The terms-consent gate HOLDS a session with no recorded acceptance, and lets
 * everything else through (P3.1 / #1376).
 *
 * ── why a gate exists at all ──
 *
 * Consent is captured by `POST /api/auth/register/start`. A first-time Google
 * sign-in creates its `User` row through `PrismaAdapter` inside NextAuth, so it
 * passes no route of ours and records nothing — measured on main: eight sites
 * create a `User`, one records `acceptedTermsAt`. Stamping consent on the OAuth
 * callback was the obvious fix and the wrong one: it files an agreement nobody
 * gave, which is worse than the null, because a null honestly means "we do not
 * know". So the product asks.
 *
 * ── what this file drives, and why synthetically ──
 *
 * Every case puts a SYNTHETIC pathname through the REAL `src/middleware.ts`,
 * for the reason `person-path-parity` does: a test that discovered its subjects
 * from the filesystem would cover whichever prefixes happen to have routes
 * today and report success for the rest — an empty selection passing as a pass.
 *
 * The population is printed on every run so the denominator is visible.
 *
 * ── the two assertions that matter most are the NEGATIVE ones ──
 *
 * A gate that redirects everything is not a gate, it is an outage. So this
 * asserts a consented session passes, AND that the allowlisted paths stay
 * reachable while pending — because a hold with no exit is a trap: sign-out
 * has to work, and the terms have to be readable by the person being asked to
 * accept them.
 */
import { NextRequest } from 'next/server';

jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    ...jest.requireActual('../../src/lib/rate-limit/authRateLimit'),
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    ...jest.requireActual('../../src/lib/rate-limit/apiReadRateLimit'),
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: any[]) => getToken(...a) }));

import middleware from '../../src/middleware';
import { isTermsAllowedPath } from '../../src/lib/auth/guard';

const ENV_SNAPSHOT: Record<string, string | undefined> = {
    RATE_LIMIT_MODE: process.env.RATE_LIMIT_MODE,
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
    AUTH_TEST_MODE: process.env.AUTH_TEST_MODE,
};
process.env.RATE_LIMIT_MODE = 'memory';
delete process.env.RATE_LIMIT_ENABLED;
process.env.AUTH_TEST_MODE = '0';

afterAll(() => {
    for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

const IP = '203.0.113.44';
const SLUG = 'acme';

/** Paths the gate must cover — one tenant, one person, one of each API. */
const GATED = {
    tenantPage: `/t/${SLUG}/dashboard`,
    tenantApi: `/api/t/${SLUG}/journal`,
    personPage: '/account/security',
    personApi: '/api/me/profile',
    // The farm-creation write specifically. Added after a peer measured zero
    // references to terms in `POST /api/me/farms` and in
    // `usecases/farm-creation.ts` — both true — and concluded a native client
    // could create a farm for somebody who never accepted. The measurement is
    // right and the conclusion does not follow: neither the route nor the
    // usecase needs to mention terms, because `/api/me/` is an
    // `isPersonPath` and the Edge gate refuses it with 403 before the handler
    // runs. The middleware matcher covers everything but static assets, so
    // this holds for a bare `fetch` exactly as it does for a navigation.
    //
    // Pinned as its own case rather than left implied by the `/api/me/profile`
    // row: it is the write a client is most likely to reach for, and "the
    // prefix covers it" is an argument, whereas this is a test.
    farmCreate: '/api/me/farms',
} as const;

/** Paths that must stay reachable while a session is held. */
const ALLOWED_WHILE_PENDING = [
    '/accept-terms',
    '/api/auth/accept-terms',
    '/api/auth/signout',
    '/terms',
    '/privacy',
] as const;

function req(pathname: string, method = 'GET'): NextRequest {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method,
        headers: { 'x-forwarded-for': IP },
    });
}

function token(overrides: Record<string, unknown> = {}) {
    return {
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: SLUG,
        role: 'OWNER',
        memberships: [{ slug: SLUG, role: 'OWNER', tenantId: 'tenant-1' }],
        mfaPending: false,
        termsPending: false,
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('§1 the population this covers', () => {
    it('prints the gated paths and the allowlist', () => {
        // Visible denominator. If either list shrinks to nothing, the suite
        // below is vacuous and this line is where that shows.
        // eslint-disable-next-line no-console -- the denominator IS the output
        console.log(
            `[terms-gate] gated=${Object.keys(GATED).length} ` +
                `(${Object.values(GATED).join(', ')}) ` +
                `allowed=${ALLOWED_WHILE_PENDING.length}`,
        );
        expect(Object.keys(GATED).length).toBeGreaterThan(0);
        expect(ALLOWED_WHILE_PENDING.length).toBeGreaterThan(0);
    });
});

describe('§2 a pending session is HELD', () => {
    it.each(Object.entries(GATED))('%s is not served', async (_label, pathname) => {
        getToken.mockResolvedValue(token({ termsPending: true }));
        const res = await middleware(req(pathname) as any);

        // Either shape is a refusal; which one depends on API vs page.
        expect([302, 307, 403]).toContain(res.status);
    });

    it('a PAGE is redirected to /accept-terms carrying where it was going', async () => {
        getToken.mockResolvedValue(token({ termsPending: true }));
        const res = await middleware(req(GATED.tenantPage) as any);

        const location = res.headers.get('location');
        expect(location).toContain('/accept-terms');
        // So accepting returns somebody to what they were trying to reach.
        expect(location).toContain(`next=${encodeURIComponent(GATED.tenantPage)}`);
    });

    it('an API route is refused with JSON, not a redirect', async () => {
        // A fetch following a 302 to an HTML page is how a client ends up
        // parsing a login page as JSON.
        getToken.mockResolvedValue(token({ termsPending: true }));
        const res = await middleware(req(GATED.tenantApi) as any);
        expect(res.status).toBe(403);
    });
});

describe('§3 and everything else is NOT held — the controls', () => {
    it.each(Object.entries(GATED))(
        '%s is served once consent is recorded',
        async (_label, pathname) => {
            // Without this, a gate that refused every request would satisfy
            // every assertion in §2.
            getToken.mockResolvedValue(token({ termsPending: false }));
            const res = await middleware(req(pathname) as any);
            expect([302, 307, 403]).not.toContain(res.status);
        },
    );

    it.each(ALLOWED_WHILE_PENDING)('%s stays reachable while pending', async (pathname) => {
        // A hold with no exit is a trap. Sign-out must work, and the terms
        // must be readable by the person being asked to accept them.
        getToken.mockResolvedValue(token({ termsPending: true }));
        const res = await middleware(req(pathname) as any);
        const location = res.headers.get('location') ?? '';
        expect(location).not.toContain('/accept-terms');
    });

    it('an ABSENT claim does not hold — old tokens degrade gracefully', async () => {
        // Sessions minted before this shipped carry no `termsPending`. The gate
        // tests `=== true`, so an absent claim reads as not-pending and those
        // users are not locked out mid-session; the next token re-mint resolves
        // it from the column.
        getToken.mockResolvedValue(token({ termsPending: undefined }));
        const res = await middleware(req(GATED.tenantPage) as any);
        expect([302, 307, 403]).not.toContain(res.status);
    });
});

describe('§4 MFA comes first', () => {
    it('a session that is BOTH pending goes to the MFA challenge, not the terms page', async () => {
        // Ordering, not generosity: MFA is a security control and consent is a
        // compliance record, so a session with an outstanding second factor
        // clears that before being asked to agree to anything.
        getToken.mockResolvedValue(token({ mfaPending: true, termsPending: true }));
        const res = await middleware(req(GATED.tenantPage) as any);
        const location = res.headers.get('location') ?? '';
        expect(location).toContain('/auth/mfa');
        expect(location).not.toContain('/accept-terms');
    });

    it('the allowlist exempts the MFA paths, so the two cannot deadlock', () => {
        // Asserted on the predicate rather than through the middleware: this is
        // the property that keeps the gates safe if their ORDER is ever changed,
        // and it should hold independently of today's ordering.
        expect(isTermsAllowedPath(`/t/${SLUG}/auth/mfa`)).toBe(true);
        expect(isTermsAllowedPath(`/api/t/${SLUG}/security/mfa/verify`)).toBe(true);
    });
});

describe('§5 the allowlist is not a prefix in disguise', () => {
    it('a sibling sharing a spelling is NOT exempt', () => {
        // `/accept-terms` is matched exactly, so a future
        // `/accept-terms-and-conditions` does not inherit the exemption — the
        // same narrowing `matchesPublicPrefix` applies to public prefixes.
        expect(isTermsAllowedPath('/accept-terms')).toBe(true);
        expect(isTermsAllowedPath('/accept-terms-later')).toBe(false);
        expect(isTermsAllowedPath('/termsomething')).toBe(false);
    });

    it('a gated path is not accidentally on it', () => {
        for (const pathname of Object.values(GATED)) {
            expect(isTermsAllowedPath(pathname)).toBe(false);
        }
    });
});
