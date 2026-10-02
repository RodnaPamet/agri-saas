/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these middleware harnesses (see
 * tests/unit/mfa-gate-enforced.test.ts). */

/**
 * P1.6 — the PERSON-scoped paths are gated, and the gates REFUSE A REQUEST.
 *
 * ── what was wrong ──
 *
 * The MFA block in `src/middleware.ts` was wrapped in `isTenantPath(pathname)`
 * alone, and the MECHANISATOR lockdown keys on the tenant slug in the URL. A
 * person-scoped path has no slug and is not a tenant path, so BOTH gates were
 * structurally unable to fire on `/account/`, `/onboarding/`, `/api/me/` and
 * `/api/social/`:
 *
 *   · a session that had authenticated but not cleared its second factor
 *     reached a person's own account — which is the session a stolen first
 *     factor produces, and that account is what it is most useful against;
 *   · the one persona deliberately confined to a single screen reached every
 *     person-scoped surface in the product.
 *
 * ── the thing that makes this file necessary rather than nice ──
 *
 * THREE of the four prefixes have no routes at all. Measured 2026-10-02: only
 * `/account/` exists (6 files under `src/app/account/`); `/api/me/`,
 * `/api/social/` and `/onboarding/` have none. So a test that discovered its
 * subjects from the filesystem would cover one prefix and report success for
 * four — an empty selection passing as a pass, which is this repo's recurring
 * defect. Every case below therefore drives a SYNTHETIC pathname through the
 * REAL `src/middleware.ts`, and §1 prints the population it covers so the
 * denominator is visible on every run.
 *
 * Gate-before-routes is the intended order: a surface added later is behind
 * these gates by default rather than needing someone to remember.
 */
import { NextRequest } from 'next/server';

// Stub ONLY the async budget checks whose policies this file does not test.
// Spreading requireActual keeps the pure path/method predicates real — a bare
// object literal yields `undefined` for every export it omits, which surfaces
// as "is not a function" the moment a request reaches one.
jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    ...jest.requireActual('../../src/lib/rate-limit/authRateLimit'),
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    ...jest.requireActual('../../src/lib/rate-limit/apiReadRateLimit'),
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
// publicReadRateLimit is deliberately NOT mocked — §3 tests it for real.

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: any[]) => getToken(...a) }));

import middleware from '../../src/middleware';
import {
    isPersonPath,
    isOperatorBlockedPersonPath,
    personSurfaceOf,
} from '../../src/lib/auth/guard';
import { _clearPublicReadRateLimitMemory } from '../../src/lib/rate-limit/publicReadRateLimit';
import { PUBLIC_READ_LIMIT } from '../../src/lib/security/rate-limit';

const ENV_SNAPSHOT: Record<string, string | undefined> = {
    RATE_LIMIT_MODE: process.env.RATE_LIMIT_MODE,
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
    AUTH_TEST_MODE: process.env.AUTH_TEST_MODE,
    NEXT_TEST_MODE: process.env.NEXT_TEST_MODE,
};

function pinEnv(): void {
    process.env.RATE_LIMIT_MODE = 'memory'; // never build a real Upstash client
    delete process.env.RATE_LIMIT_ENABLED; // default '1' ⇒ enforced
    process.env.AUTH_TEST_MODE = '0';
    delete process.env.NEXT_TEST_MODE;
}
pinEnv();

afterAll(() => {
    for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

/** An explicit IP so §3's bucket is not shared with a neighbouring suite. */
const IP = '203.0.113.21';

/** The four person prefixes, as the paths a real caller would hit. */
const PERSON_PATHS = {
    account: '/account/security',
    onboarding: '/onboarding/farm',
    apiMe: '/api/me/profile',
    apiSocial: '/api/social/feed',
} as const;

function req(pathname: string, method = 'GET', ip = IP): NextRequest {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method,
        headers: { 'x-forwarded-for': ip },
    });
}

/**
 * A valid session. `memberships` entries use `slug`, NOT `tenantSlug` — the jwt
 * callback builds `{ slug, role, tenantId }` and the gates scan `m.slug`.
 */
function token(overrides: Record<string, unknown> = {}) {
    return {
        userId: 'usr_1',
        sub: 'usr_1',
        tenantId: 'tnt_1',
        tenantSlug: 'acme-corp',
        role: 'ADMIN',
        userSessionId: 'sess_1',
        sessionVersion: 1,
        memberships: [{ slug: 'acme-corp', role: 'ADMIN', tenantId: 'tnt_1' }],
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    pinEnv();
    _clearPublicReadRateLimitMemory();
    getToken.mockResolvedValue(token());
});

describe('§0 — nothing here can go vacuously green', () => {
    it('no bypass flag is set', () => {
        // `process.env` leaks between test FILES inside a jest worker, so this
        // is asserted at run time rather than trusted from the preamble. With
        // any of these set, §3's 61 requests all return 200 and nothing 429s.
        expect(process.env.NEXT_TEST_MODE).not.toBe('1');
        expect(process.env.AUTH_TEST_MODE).not.toBe('1');
        expect(process.env.RATE_LIMIT_ENABLED).not.toBe('0');
        expect(process.env.RATE_LIMIT_MODE).toBe('memory');
    });

    it('a person path is NOT a public path — otherwise stage 1 returns first', () => {
        // The precondition for §1 and §2: if any of these were public, the
        // middleware would return at stage 1 and every gate below would be
        // unreachable while the assertions still passed.
        const { isPublicPath } = jest.requireActual('../../src/lib/auth/guard');
        for (const p of Object.values(PERSON_PATHS)) {
            expect(isPublicPath(p)).toBe(false);
        }
    });
});

describe('§1 — MFA parity on person paths', () => {
    it('covers FOUR prefixes, three of which have no routes yet', () => {
        // The denominator, printed as an assertion. Three of these prefixes are
        // gated before they exist, which is the intended order — and the reason
        // every case here uses a synthetic path instead of discovering one.
        expect(Object.keys(PERSON_PATHS)).toHaveLength(4);
        for (const p of Object.values(PERSON_PATHS)) {
            expect(isPersonPath(p)).toBe(true);
        }
    });

    it.each(Object.entries(PERSON_PATHS))(
        'an MFA-pending session is refused on %s',
        async (_name, pathname) => {
            getToken.mockResolvedValue(token({ mfaPending: true }));
            const res = await middleware(req(pathname));
            if (pathname.startsWith('/api/')) {
                expect(res?.status).toBe(403);
            } else {
                expect(res?.status).toBe(307);
                expect(res?.headers.get('location')).toContain('/auth/mfa');
            }
        },
    );

    it.each(Object.entries(PERSON_PATHS))(
        'a CLEARED session passes %s — the positive control',
        async (_name, pathname) => {
            // Without this, a middleware that refused everything would satisfy
            // every refusal above.
            getToken.mockResolvedValue(token({ mfaPending: false }));
            const res = await middleware(req(pathname));
            expect(res?.status).not.toBe(403);
            // `toBeNull`, not "does not contain /auth/mfa" — for the same
            // reason as §2's ALLOWS cases: a refusal that redirected ANYWHERE
            // else would satisfy the weaker form while the path stayed
            // unreachable. A pass-through carries no `location`.
            expect(res?.headers.get('location')).toBeNull();
        },
    );

    it('a page redirect carries the ORIGINAL path as `next`', async () => {
        getToken.mockResolvedValue(token({ mfaPending: true }));
        const res = await middleware(req(PERSON_PATHS.account));
        const loc = new URL(res!.headers.get('location')!);
        expect(loc.pathname).toBe('/t/acme-corp/auth/mfa');
        expect(loc.searchParams.get('next')).toBe(PERSON_PATHS.account);
    });

    it('a TENANTLESS mfa-pending session lands on /no-tenant, not the page', async () => {
        // The branch that would otherwise fall through: no slug in the path and
        // none in the token means there is no MFA page to send them to, and
        // falling through would make the gate a no-op for the one case it
        // cannot classify.
        getToken.mockResolvedValue(
            token({ mfaPending: true, tenantSlug: undefined, memberships: [] }),
        );
        const res = await middleware(req(PERSON_PATHS.account));
        expect(res?.status).toBe(307);
        expect(new URL(res!.headers.get('location')!).pathname).toBe('/no-tenant');
    });
});

describe('§2 — the operator lockdown reaches the SOCIAL half only', () => {
    const operator = () =>
        token({ memberships: [{ slug: 'acme-corp', role: 'MECHANISATOR', tenantId: 'tnt_1' }] });

    it('refuses an operator-only session on /api/social/', async () => {
        getToken.mockResolvedValue(operator());
        const res = await middleware(req(PERSON_PATHS.apiSocial));
        expect(res?.status).toBe(403);
        expect(await res!.clone().json()).toEqual({ error: 'operator_scope' });
    });

    it.each([PERSON_PATHS.account, PERSON_PATHS.onboarding, PERSON_PATHS.apiMe])(
        'ALLOWS an operator on %s — they must reach their own account',
        async (pathname) => {
            // Owner ruling: the lockdown keeps a field device off the FARM's
            // data, not off the person's own identity. Blocking `/account/`
            // would mean an operator could never change their own password.
            getToken.mockResolvedValue(operator());
            const res = await middleware(req(pathname));

            // `not.toBe(403)` ALONE IS NOT ENOUGH, and mutation testing is how
            // I found that out. Widening the operator block to every person
            // path reddened only the `/api/me/` case: the two PAGE paths are
            // refused by a REDIRECT to '/', which is a 307 and satisfies
            // "not 403" perfectly. So an operator locked out of
            // `/account/security` — the exact thing the ruling is about —
            // would have passed. A pass-through carries no `location` at all.
            expect(res?.status).not.toBe(403);
            expect(res?.headers.get('location')).toBeNull();
        },
    );

    it('a NON-operator reaches /api/social/ — so the refusal is about the role', async () => {
        getToken.mockResolvedValue(token());
        const res = await middleware(req(PERSON_PATHS.apiSocial));
        expect(res?.status).not.toBe(403);
    });

    it('a user with NO memberships reaches /api/social/', async () => {
        // `[].every(…)` is true, so without the length guard the person
        // mid-onboarding — the primary caller of these surfaces — reads as
        // operator-only and is refused.
        getToken.mockResolvedValue(token({ memberships: [] }));
        const res = await middleware(req(PERSON_PATHS.apiSocial));
        expect(res?.status).not.toBe(403);
    });

    it('an operator at ONE farm and an editor at another is not operator-only', async () => {
        getToken.mockResolvedValue(
            token({
                memberships: [
                    { slug: 'acme-corp', role: 'MECHANISATOR', tenantId: 'tnt_1' },
                    { slug: 'other-farm', role: 'EDITOR', tenantId: 'tnt_2' },
                ],
            }),
        );
        const res = await middleware(req(PERSON_PATHS.apiSocial));
        expect(res?.status).not.toBe(403);
    });

    it('FAILS OPEN on a truncated membership list', async () => {
        // The Edge has no database and the list is capped, so "every entry is
        // MECHANISATOR" over a TRUNCATED list can be true while the user holds
        // a non-operator membership past the cap. Being wrong here locks a
        // legitimate user out, so the Edge defers and `getUserCtx` makes the
        // authoritative call against the database.
        getToken.mockResolvedValue({ ...operator(), membershipsTruncated: true });
        const res = await middleware(req(PERSON_PATHS.apiSocial));
        expect(res?.status).not.toBe(403);
    });
});

describe('§3 — the public read tier (60/min/IP)', () => {
    const INVITE = '/api/invites/tok_abc123';

    it('the preset is 60 per minute', () => {
        expect(PUBLIC_READ_LIMIT.maxAttempts).toBe(60);
        expect(PUBLIC_READ_LIMIT.windowMs).toBe(60_000);
    });

    it('60 pass and the 61st is a 429', async () => {
        // No token is set up: this gate sits inside the public-path branch,
        // BEFORE getToken, so no session of any shape can reach or break it.
        for (let i = 0; i < PUBLIC_READ_LIMIT.maxAttempts; i++) {
            const res = await middleware(req(INVITE));
            expect(res?.status).not.toBe(429);
        }
        const blocked = await middleware(req(INVITE));
        expect(blocked?.status).toBe(429);
        expect(blocked?.headers.get('Retry-After')).toBeTruthy();
    });

    it('a second IP has its OWN budget', async () => {
        for (let i = 0; i < PUBLIC_READ_LIMIT.maxAttempts + 1; i++) {
            await middleware(req(INVITE));
        }
        const other = await middleware(req(INVITE, 'GET', '198.51.100.9'));
        expect(other?.status).not.toBe(429);
    });

    it('a POST is NOT limited by this tier', async () => {
        // An invite acceptance is a mutation and already budgeted by
        // withApiErrorHandling; double-charging it here would make accepting an
        // invite fail for a reason nobody could find.
        for (let i = 0; i < PUBLIC_READ_LIMIT.maxAttempts + 5; i++) {
            const res = await middleware(req(INVITE, 'POST'));
            expect(res?.status).not.toBe(429);
        }
    });

    it.each(['/api/health', '/api/livez', '/api/readyz', '/api/metrics', '/api/auth/session'])(
        'never throttles %s',
        async (pathname) => {
            // Probes must answer WHILE an attacker hammers the API, and
            // /api/auth carries session polling that a 60/min cap would break
            // across browser tabs.
            for (let i = 0; i < PUBLIC_READ_LIMIT.maxAttempts + 5; i++) {
                const res = await middleware(req(pathname));
                expect(res?.status).not.toBe(429);
            }
        },
    );
});

describe('§4 — the predicates have teeth at their boundaries', () => {
    it('a sibling prefix is NOT a person path', () => {
        // The `/api/scim` vs `/api/scimulator` hazard. A bare
        // `startsWith('/account')` would match `/accounts`, opening a gate over
        // a path nobody considered.
        for (const p of ['/accounts', '/accounts/x', '/api/members', '/api/mex', '/onboardings']) {
            expect(isPersonPath(p)).toBe(false);
        }
    });

    it('the bare prefix IS a person path', () => {
        for (const p of ['/account', '/onboarding', '/api/me', '/api/social']) {
            expect(isPersonPath(p)).toBe(true);
        }
    });

    it('only the social half is operator-blocked, and it classifies both ways', () => {
        expect(isOperatorBlockedPersonPath('/api/social/feed')).toBe(true);
        expect(isOperatorBlockedPersonPath('/social/profile')).toBe(true);
        expect(isOperatorBlockedPersonPath('/account/security')).toBe(false);
        expect(isOperatorBlockedPersonPath('/api/me/profile')).toBe(false);
        // `/socialise` must not inherit the social lockdown.
        expect(isOperatorBlockedPersonPath('/socialise')).toBe(false);

        expect(personSurfaceOf('/api/social/feed')).toBe('social');
        expect(personSurfaceOf('/account/security')).toBe('account');
    });

    it('a tenant path is untouched by either predicate', () => {
        // P1.6 must not change the tenant scope's behaviour.
        expect(isPersonPath('/t/acme-corp/journal')).toBe(false);
        expect(isOperatorBlockedPersonPath('/t/acme-corp/my-work')).toBe(false);
    });
});
