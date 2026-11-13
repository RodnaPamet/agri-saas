/**
 * «Вдъхновение» reaches a MECHANISATOR — the CALL SITE, not the function
 * (#2980).
 *
 * ## Why this test exists at all
 *
 * The owner's audience ruling is "every role, mechanisators included", and the
 * reason the non-tenant path satisfies it is a property of
 * `src/middleware.ts` rather than of the guard it calls.
 *
 * `isOperatorAllowedPath` is an ALLOWLIST. Asked about `/api/library/books` it
 * returns FALSE — so a reading of the function alone concludes that an
 * operator is refused.
 *
 * ## TWO gates keep it safe, not one, and #2980 names only the inner one
 *
 * The issue's own analysis — and my first draft of this docblock — cites the
 * inner condition:
 *
 *     const slug = pathname.match(/^\/(?:api\/)?t\/([^/]+)/)?.[1];
 *     if (membership?.role === 'MECHANISATOR' && slug && !isOperatorAllowedPath(...))
 *
 * True, and NOT what does the work here. MEASURED: removing the `slug &&`
 * condition — so the lockdown is asked about every path it reaches — left
 * every case in this file GREEN, because the whole block sits inside an OUTER
 * `if (isTenantPath(pathname))`. The library is excluded before the inner
 * condition is evaluated at all.
 *
 * Only the COMBINED mutation reddens it: drop the `slug &&` guard AND widen
 * the outer gate to admit `/api/library`. That is the defence-in-depth
 * signature — each gate alone suffices, so a single-site mutation correctly
 * survives — and it is strictly better news than the issue claims, because the
 * safety does not rest on one condition somebody could tighten.
 *
 * It matters for the next reader, though: a sentence crediting the inner
 * condition sends them to protect a line that is never reached, and leaves the
 * outer one looking incidental.
 *
 * **I got this wrong twice in this area** — once on #2948 and once on the
 * first reading of #2980 — both times by reading the predicate and not its
 * caller. `existing-is-not-mounted` is the rule, and a prose claim is what it
 * was both times. So this drives the REAL middleware, and the function's own
 * answer is asserted beside it: the two DISAGREE, and that disagreement is the
 * whole mechanism.
 *
 * ## Mocking, copied from `person-path-parity`
 *
 * `requireActual` is spread into both rate-limit modules so the pure path
 * predicates stay real — a bare literal yields `undefined` for every export it
 * omits, which surfaces as "is not a function" the moment a request reaches
 * one.
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
jest.mock('next-auth/jwt', () => ({ getToken: (...a: unknown[]) => getToken(...a) }));

import middleware from '../../src/middleware';
import { isOperatorAllowedPath, isPublicPath } from '../../src/lib/auth/guard';

const LIBRARY_LIST = '/api/library/books';
const LIBRARY_DETAIL = '/api/library/books/sun-tzu-izkustvoto-na-voynata';
/** A tenant API outside the operator allowlist — the comparison case. */
const CONFINED = '/api/t/acme-corp/grain/contracts';

const ENV_SNAPSHOT: Record<string, string | undefined> = {
    RATE_LIMIT_MODE: process.env.RATE_LIMIT_MODE,
    AUTH_TEST_MODE: process.env.AUTH_TEST_MODE,
    NEXT_TEST_MODE: process.env.NEXT_TEST_MODE,
};

function pinEnv(): void {
    process.env.RATE_LIMIT_MODE = 'memory';
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

function operatorToken() {
    return {
        userId: 'usr_mech',
        sub: 'usr_mech',
        tenantId: 'tnt_1',
        tenantSlug: 'acme-corp',
        role: 'MECHANISATOR',
        userSessionId: 'sess_1',
        sessionVersion: 1,
        memberships: [{ slug: 'acme-corp', role: 'MECHANISATOR', tenantId: 'tnt_1' }],
    };
}

function req(pathname: string): NextRequest {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        headers: { 'x-forwarded-for': '203.0.113.44' },
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    pinEnv();
    getToken.mockResolvedValue(operatorToken());
});

describe('nothing here can go vacuously green', () => {
    it('no bypass flag is set', () => {
        // `process.env` leaks between test FILES inside a jest worker, so this
        // is asserted at run time rather than trusted from the preamble.
        expect(process.env.NEXT_TEST_MODE).not.toBe('1');
        expect(process.env.AUTH_TEST_MODE).not.toBe('1');
    });

    it('the library paths are NOT public — otherwise stage 1 returns first', () => {
        // The precondition. If these were public the middleware would return
        // before any role gate, and every assertion below would pass while
        // saying nothing about the confinement. They are signed-in by owner
        // ruling, which is what makes this check meaningful rather than
        // decorative.
        expect(isPublicPath(LIBRARY_LIST)).toBe(false);
        expect(isPublicPath(LIBRARY_DETAIL)).toBe(false);
    });
});

describe('the function and its caller DISAGREE, which is the mechanism', () => {
    it('isOperatorAllowedPath says NO to the library — read alone, it looks refused', () => {
        // Not a defect and not a thing to "fix" by adding the library to the
        // allowlist: that function answers about TENANT paths, and widening it
        // would be answering a question nobody asks.
        expect(isOperatorAllowedPath(LIBRARY_LIST, 'acme-corp')).toBe(false);
        expect(isOperatorAllowedPath(LIBRARY_DETAIL, 'acme-corp')).toBe(false);
    });

    it('and the middleware lets a MECHANISATOR through anyway', async () => {
        for (const pathname of [LIBRARY_LIST, LIBRARY_DETAIL]) {
            const res = await middleware(req(pathname));
            expect(res?.status).not.toBe(403);
            // `toBeNull`, not "does not redirect to my-work": a refusal that
            // redirected ANYWHERE else would satisfy the weaker form while the
            // path stayed unreachable. A pass-through carries no `location`.
            expect(res?.headers.get('location')).toBeNull();
        }
    });

    it('while the SAME token is refused on a confined tenant API', async () => {
        // The positive control, and it is the half that makes the two cases
        // above mean something: a middleware that admitted everything would
        // satisfy them both.
        const res = await middleware(req(CONFINED));
        expect(res?.status).toBe(403);
    });
});
