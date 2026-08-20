/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these surfaces (see tests/unit/cors.test.ts). */

/**
 * The cross-site admin gate must REFUSE A REQUEST — not merely exist in source.
 *
 * WHAT IS UNPROTECTED, and why it matters here:
 *
 * The NextAuth session cookie is `SameSite=lax` and has to stay that way —
 * `SameSite=strict` breaks the OAuth redirect flow every Entra/Google operator
 * signs in through (`admin-session-guard.ts`, "Why not SameSite=strict
 * globally?"). Lax already blocks cross-site POSTs, so this gate is the SECOND
 * layer, not the CSRF control: it is what recovers `strict`-equivalent posture
 * on the admin API surface — including cross-site GETs, which lax permits — for
 * the routes where a forged request is worst. On this product that surface is
 * `/api/t/:slug/admin/*` and `/api/admin/*`: tenant member roles, SCIM tokens,
 * DEK rotation, session revocation, and the БАБХ-facing audit configuration.
 * A farm co-operative's OWNER browsing an untrusted page on rural LTE should
 * not be one cross-origin `fetch` away from having a stranger read the member
 * list of their tenant, and defence in depth means the request dies at the Edge
 * even if the cookie policy is ever loosened by an unrelated change.
 *
 * WHY CI CANNOT CURRENTLY SEE THAT SEAM:
 *
 *   - `tests/guardrails/security-hardening-epic.test.ts:213-230` is TEXTUAL —
 *     four `expect(read('src/middleware.ts')).toContain(...)` assertions. It
 *     proves the strings are in the file, never that they run.
 *   - `tests/unit/admin-cookie-mfa-failclosed.test.ts` calls
 *     `shouldBlockAdminRequest(...)` DIRECTLY. It proves the predicate decides
 *     correctly, never that anything asks it.
 *
 * Both stay green against `if (false && shouldBlockAdminRequest(...))`, and
 * against renaming the header read to `sec-fetch-site-v2` (which still
 * *contains* `'sec-fetch-site'`). That is the classic severed-seam shape: the
 * mechanism is tested, the enforcement point is not. So this file drives the
 * real `src/middleware.ts` end to end — the harness
 * `tests/unit/mfa-gate-enforced.test.ts` and
 * `tests/unit/session-revocation-enforced.test.ts` established.
 *
 * WHAT IT CATCHES: deleting the `src/middleware.ts` block at L242-248,
 * short-circuiting its condition, reading a different header name, narrowing it
 * to mutation methods only (a cross-site GET must still die), widening it past
 * `isApiRoute` (admin PAGES are deliberately NOT gated), moving it below the
 * tenant gate (`/api/admin/diagnostics` is not a tenant path and would never be
 * reached), or changing the refusal string.
 *
 * ON THE REFUSAL STRING: five different 403 bodies are reachable on
 * `/api/t/:slug/admin/…` — `'Admin access required'` (L227),
 * `'Cross-site admin requests are not allowed'` (L246),
 * `'MFA verification required'` (L262), `'no_tenant_access'` (L290),
 * `'cross_tenant_access_denied'` (L299). `expect(res.status).toBe(403)` alone
 * therefore passes for the wrong reason on the very same request. Every refusal
 * below pins the body string; the `role: 'EDITOR'` case at the bottom is the
 * written proof that this precaution is not theoretical.
 */
import { NextRequest } from 'next/server';

// Stub ONLY the async budget checks. `isApiReadRateLimited` and
// `extractTenantSlug` are pure path/method predicates that decide WHICH stage a
// request reaches — `src/middleware.ts:375-376` calls both on a GET to
// `/api/t/…`, which is exactly what the pass-through controls issue. A bare
// object literal drops them (they read back as `undefined`), and the resulting
// `is not a function` hits ONLY the pass-through half: every refusal test would
// still pass, because a refusal returns at L246 long before L375. Spreading
// requireActual keeps them real.
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
// The REAL predicates, imported so the anti-vacuity pins below cannot drift
// from the routing they describe. `shouldBlockAdminRequest` is deliberately NOT
// mocked anywhere in this file — mocking it would test the mock, not the policy.
import { isAdminPath, isPublicPath } from '../../src/lib/auth/guard';
// The real mutation set, so a policy change moves this test with the code
// instead of leaving a hard-coded list behind.
import { MUTATION_METHODS } from '../../src/lib/security/admin-session-guard';

/** Tenant-scoped admin API — the `/^\/api\/t\/[^/]+\/admin/` arm of isAdminPath. */
const ADMIN_API = '/api/t/acme-corp/admin/members';
/**
 * Flat admin API — the `startsWith('/api/admin')` arm.
 *
 * `/api/admin/diagnostics` specifically: four sibling `/api/admin/*` routes
 * (agri-events, news-derived-events, support-schemes, tenants) are in
 * `PUBLIC_PATH_PREFIXES` because they authenticate with `PLATFORM_ADMIN_API_KEY`
 * instead of a cookie, so they return at `src/middleware.ts:117` and never reach
 * this gate at all. Diagnostics is deliberately excluded from that carve-out
 * (guard.ts:65-73) — it uses an admin SESSION — which is what makes it the
 * right probe for this arm.
 */
const FLAT_ADMIN_API = '/api/admin/diagnostics';
/** Admin PAGE — must pass through: the gate is `isApiRoute`-scoped by design. */
const ADMIN_PAGE = '/t/acme-corp/admin/members';
/** Non-admin tenant API — must pass through: the gate is admin-scoped. */
const NON_ADMIN_API = '/api/t/acme-corp/tasks';

/** The one body string that names THIS gate (`src/middleware.ts:246`). */
const CROSS_SITE_REFUSAL = 'Cross-site admin requests are not allowed';
/** The 403 from the role floor immediately above it (`src/middleware.ts:227`). */
const ROLE_REFUSAL = 'Admin access required';

/**
 * A token that is valid in every respect — the ONLY variable in this file is
 * the `sec-fetch-site` header (and, in one deliberate case, the role).
 */
function validToken(overrides: Record<string, unknown> = {}) {
    return {
        userId: 'usr_1',
        sub: 'usr_1', // read at middleware.ts:377 for the read-tier bucket key
        tenantId: 'tnt_1',
        tenantSlug: 'acme-corp',
        // REQUIRED: without an admin role, middleware.ts:225 answers its OWN
        // 403 and the gate under test is never reached.
        role: 'ADMIN',
        userSessionId: 'sess_1',
        // `slug`, NOT `tenantSlug`. The jwt callback builds
        // `{ slug, role, tenantId }` (src/auth.ts:207-210) and
        // `checkTenantAccess` scans `m.slug` (guard.ts:326). With the wrong key
        // every same-origin request below is refused `cross_tenant_access_denied`
        // by the tenant gate — the REFUSAL tests still pass (they return
        // upstream), so only the exact `200` + `x-middleware-next` controls
        // catch it. That asymmetry is why those controls assert an exact 200
        // rather than `not.toBe(403)`.
        memberships: [{ tenantId: 'tnt_1', slug: 'acme-corp', role: 'ADMIN' }],
        ...overrides,
    };
}

/**
 * Never `OPTIONS`: `src/middleware.ts:442` answers any OPTIONS on `/api/` with
 * a 204 preflight before `authMiddleware` runs, so an OPTIONS case would assert
 * nothing about this gate. No `origin` header either — that would switch on the
 * CORS branch and add noise unrelated to the check.
 */
function req(pathname: string, method = 'GET', secFetchSite?: string) {
    const headers: Record<string, string> = {};
    if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite;
    return new NextRequest(`http://localhost:3000${pathname}`, { method, headers });
}

/** The reason string in a `forbiddenJson` body (guard.ts:257-262). */
async function reason(res: Response): Promise<string> {
    return ((await res.json()) as { error?: string }).error ?? '';
}

beforeEach(() => {
    // `mockReset` clears implementations as well as calls (CLAUDE.md testing
    // conventions), so the token must be re-primed here or every request 401s.
    getToken.mockReset();
    getToken.mockResolvedValue(validToken());
});

describe('the probes actually reach the gate (anti-vacuity)', () => {
    // If a future PR adds either path to PUBLIC_PATH_PREFIXES, the middleware
    // returns at L117 before `getToken` is called and EVERY refusal below goes
    // vacuously... loud. These two pins make that fail here, once, with a name.
    it.each([ADMIN_API, FLAT_ADMIN_API])('%s is an admin path and NOT public', (pathname) => {
        expect(isAdminPath(pathname)).toBe(true);
        expect(isPublicPath(pathname)).toBe(false);
    });
});

describe('a cross-site admin API request is refused', () => {
    it('GET on a tenant admin API => 403 FROM THE CROSS-SITE GATE specifically', async () => {
        // Note this is a GET. Lax cookies already stop cross-site mutations;
        // the read is the part this layer adds, and it is the part a narrowing
        // "only mutations matter" refactor would quietly drop.
        const res = await middleware(req(ADMIN_API, 'GET', 'cross-site'), {} as any);

        expect(res.status).toBe(403);
        expect(await reason(res)).toBe(CROSS_SITE_REFUSAL);
        // A refusal is a real response, never a pass-through. `x-middleware-next`
        // is set only on the `NextResponse.next()` at L385/L494.
        expect(res.headers.get('x-middleware-next')).toBeNull();
    });

    it.each(['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])(
        '%s on a tenant admin API => 403 + the cross-site reason',
        async (method) => {
            const res = await middleware(req(ADMIN_API, method, 'cross-site'), {} as any);
            expect(res.status).toBe(403);
            expect(await reason(res)).toBe(CROSS_SITE_REFUSAL);
        },
    );

    it('GET on the FLAT admin API (/api/admin/…) => 403 + the cross-site reason', async () => {
        // Separate arm of `isAdminPath`, and separate ordering proof: this path
        // is not a tenant path, so if the block were ever moved below the
        // tenant-access gate it would never be reached here.
        const res = await middleware(req(FLAT_ADMIN_API, 'GET', 'cross-site'), {} as any);

        expect(res.status).toBe(403);
        expect(await reason(res)).toBe(CROSS_SITE_REFUSAL);
    });

    it.each([...MUTATION_METHODS])(
        'sec-fetch-site: none + %s (direct-navigation mutation) => 403 + the cross-site reason',
        async (method) => {
            // A different arm of the predicate than 'cross-site'
            // (admin-session-guard.ts:68-71): a bookmark or typed URL cannot
            // produce a DELETE, so one is a forged navigation. A mutation that
            // only breaks the 'cross-site' branch still fails here.
            const res = await middleware(req(ADMIN_API, method, 'none'), {} as any);
            expect(res.status).toBe(403);
            expect(await reason(res)).toBe(CROSS_SITE_REFUSAL);
        },
    );

    it('an UNRECOGNISED sec-fetch-site value is refused (unknown blocks)', async () => {
        // admin-session-guard.ts:80 — the default is deny. A future header
        // value, or an attacker-chosen one, must not fall through as allowed.
        const res = await middleware(req(ADMIN_API, 'GET', 'evil-origin'), {} as any);

        expect(res.status).toBe(403);
        expect(await reason(res)).toBe(CROSS_SITE_REFUSAL);
    });
});

describe('the gate is precise — legitimate admin traffic still lands', () => {
    /**
     * THE POSITIVE CONTROLS.
     *
     * Without these, a middleware that refused literally everything would
     * satisfy every refusal above. Each asserts three things together:
     *
     *   1. an EXACT 200 — not `not.toBe(403)`, which a `cross_tenant_access_denied`
     *      or `MFA verification required` 403 would fail while a weaker
     *      assertion sailed past;
     *   2. `x-middleware-next === '1'` — reachable ONLY via the pass-through at
     *      L385 rebuilt at L494, i.e. after L102 said not-public, L128 said
     *      token present, L176 said no `token.error`, L213 said client version
     *      ok, L225 said role ok, L245 said not cross-site, L252 said MFA
     *      satisfied, L281 `checkTenantAccess` returned allow, and L375-382 let
     *      the read budget through;
     *   3. `getToken` was CALLED — which additionally proves L102 did not
     *      short-circuit the request as public (public paths return at L117,
     *      before `getToken` at L123).
     */
    it.each([
        ['same-origin', 'GET'],
        ['same-origin', 'POST'],
        ['same-origin', 'DELETE'],
        ['same-site', 'GET'],
        ['same-site', 'POST'],
        ['none', 'GET'],
        ['none', 'HEAD'],
    ])('sec-fetch-site: %s + %s reaches the route', async (site, method) => {
        const res = await middleware(req(ADMIN_API, method, site), {} as any);

        expect(res.status).toBe(200);
        expect(res.headers.get('x-middleware-next')).toBe('1');
        expect(getToken).toHaveBeenCalled();
    });

    it('an ABSENT sec-fetch-site header is allowed — curl and old browsers keep working', async () => {
        // admin-session-guard.ts:57-60, deliberate: the header is a browser
        // signal, and the session cookie is still required. Operators running
        // `curl` against the admin API from a laptop in a field office send no
        // Sec-Fetch-Site at all; refusing them would be a self-inflicted outage.
        const res = await middleware(req(ADMIN_API, 'POST'), {} as any);

        expect(res.status).toBe(200);
        expect(res.headers.get('x-middleware-next')).toBe('1');
        expect(getToken).toHaveBeenCalled();
    });

    it('a NON-admin tenant API is not gated, even cross-site', async () => {
        // Scope control. Without it, a mutation that 403s every request would
        // satisfy all the refusals above. It also documents the boundary: the
        // task list is protected by the lax cookie, not by this second layer.
        const res = await middleware(req(NON_ADMIN_API, 'GET', 'cross-site'), {} as any);

        expect(res.status).toBe(200);
        expect(res.headers.get('x-middleware-next')).toBe('1');
        expect(getToken).toHaveBeenCalled();
    });

    it('an admin PAGE is not gated, even cross-site — the gate is API-only', async () => {
        // `isApiRoute` at L242. A cross-site *navigation* to an admin page is
        // harmless: the page renders, and every mutation it can issue comes
        // back through the API arm above. Widening the gate past `isApiRoute`
        // would break inbound links into the admin UI, so pin the boundary.
        const res = await middleware(req(ADMIN_PAGE, 'GET', 'cross-site'), {} as any);

        expect(res.status).toBe(200);
        expect(res.headers.get('x-middleware-next')).toBe('1');
        expect(getToken).toHaveBeenCalled();
    });
});

describe('403 on an admin path is ambiguous — this is the disambiguation', () => {
    it('a non-admin role is refused by the ROLE floor, with a different reason', async () => {
        // Same path, same cross-site header, same 403 — a completely different
        // gate (L227). This test exists so the reason assertions in the
        // refusals above can never be "simplified" to `toBe(403)`: that
        // weakened form would pass here too, on a request the gate under test
        // never even saw.
        getToken.mockResolvedValue(validToken({ role: 'EDITOR' }));
        const res = await middleware(req(ADMIN_API, 'GET', 'cross-site'), {} as any);

        // `res.json()` is single-read, so take the body once and assert both
        // directions off it.
        const body = await reason(res);
        expect(res.status).toBe(403);
        expect(body).toBe(ROLE_REFUSAL);
        expect(body).not.toBe(CROSS_SITE_REFUSAL);
    });
});

describe('regression proof — the gate is load-bearing', () => {
    it('the SAME admin mutation is allowed same-origin and refused cross-site', async () => {
        // One differential assertion, identical in every respect but one
        // header. Deleting the middleware block, short-circuiting its
        // condition, or reading a renamed header all fail this immediately —
        // whereas grepping `src/middleware.ts` for the string, as
        // `security-hardening-epic.test.ts` does, survives all three.
        const allowed = await middleware(req(ADMIN_API, 'POST', 'same-origin'), {} as any);
        const refused = await middleware(req(ADMIN_API, 'POST', 'cross-site'), {} as any);

        expect(allowed.status).toBe(200);
        expect(allowed.headers.get('x-middleware-next')).toBe('1');

        expect(refused.status).toBe(403);
        expect(await reason(refused)).toBe(CROSS_SITE_REFUSAL);
    });
});
