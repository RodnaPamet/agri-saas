/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these surfaces (see tests/unit/cors.test.ts). */

/**
 * The org-access gate must REFUSE A REQUEST — not merely compute a verdict.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `token.orgMemberships` has exactly one reader in `src/` — the `§5b
 * Org-access gate (GAP O4-1)` block in `src/middleware.ts`. Measured, not
 * assumed: running every suite in this repo that imports the real middleware
 * (`tests/integration/auth-ratelimit.test.ts`, `tests/unit/{bearer-cookie-
 * parity,client-version-gate,cors,mfa-gate-enforced,scim-edge-reachability,
 * session-revocation-enforced,webhook-edge-reachability}.test.ts`) under
 * `--collectCoverageFrom=src/middleware.ts` showed `if (isOrgPath(pathname))`
 * evaluated 11 times with its TRUE ARM TAKEN ZERO TIMES — branch `[0, 11]`,
 * and every statement inside it at 0 hits. `checkOrgAccess` had never once
 * been called from the middleware by any test in the repo.
 *
 * The reason CI never noticed is the part worth remembering:
 *
 *   - `tests/integration/middleware-org-gate.test.ts` drives the PURE helper
 *     `checkOrgAccess(pathname, memberships, truncated)` directly and asserts
 *     on its returned string. It never constructs a request, so it cannot
 *     observe whether anything acts on that string.
 *   - `tests/unit/middleware-org-route-structural.test.ts` is a `readFileSync`
 *     + regex ratchet (its own docblock line 4: "Static-file checks (no Edge
 *     runtime…)"). It proves the block is PRESENT in source, never that it
 *     RUNS.
 *   - The integration file's docblock hands the missing half off to
 *     `tests/unit/middleware-org-route.test.ts` — a file that has never
 *     existed in any commit on any ref of this repo. The promise was the only
 *     thing standing where the crossing test should have been. THIS FILE is
 *     what that sentence was describing.
 *
 * Same severed-seam shape as `token.error` before
 * `session-revocation-enforced.test.ts` and `token.mfaPending` before
 * `mfa-gate-enforced.test.ts`: the mechanism is tested, the enforcement point
 * is not.
 *
 * WHAT IT PROTECTS, in this product's terms. An Organization is the
 * hub-and-spoke layer above tenants — a cooperative, an agro-holding, a group
 * of farms filing together. `/org/:slug/**` carries the cross-farm portfolio
 * dashboard, the member roster, the tenant list, and the org AUDIT LOG, which
 * is where БАБХ-relevant activity across every member farm is aggregated.
 * A slug is a guessable string. Without this gate, the Edge hands a probing
 * operator's request straight to the app tier for any org slug they can type.
 *
 * THE 404 IS DELIBERATE, AND IS THE POINT. Both failure verdicts —
 * `no_org_access` (the user belongs to no org at all) and `cross_org` (the
 * user belongs to a different one) — collapse to ONE external response: 404
 * JSON on the API arm, a 307 to `/no-tenant` on the page arm. That is
 * anti-enumeration parity with `getOrgCtx` (`src/app-layer/context.ts`) and
 * `getOrgServerContext`, both of which answer a bare `NotFoundError` /
 * `notFound()`. A 403 would be honest and would leak: it distinguishes "this
 * cooperative exists and you are not in it" from "no such cooperative", which
 * is exactly the signal a competitor probing slugs wants. The tests below
 * therefore assert the two verdicts are BYTE-IDENTICAL to the caller, not
 * merely that both are refused.
 *
 * SCOPE — do not overclaim, and do not "simplify" on this basis. Eleven route
 * files under `src/app/api/org/[orgSlug]/**` and the whole `/org/[orgSlug]`
 * page tree run their own membership check via `getOrgCtx` /
 * `getOrgServerContext`. So deleting this gate is a defence-in-depth loss and
 * an unbudgeted-DB-query loss on every probe, not an instant data leak —
 * which is precisely why the branch sat at `[0, 11]` for its whole life with
 * a green suite. The middleware is the EARLY-REJECTION layer: it refuses
 * before a DB round-trip, which on rural LTE is also the difference between a
 * fast 404 and a spun-up server render.
 *
 * Note also that `isOrgPath` is `startsWith('/org/') || startsWith('/api/org/')`
 * — WITH the trailing slash — so `/api/org` itself (the org list/create route,
 * `src/app/api/org/route.ts`) is not gated here at all and self-gates in its
 * handler. That is intentional, not a hole this file is papering over.
 *
 * MUTATIONS THIS FILE CATCHES (each verified against a scratchpad copy of the
 * middleware, never against the repo source):
 *
 *   M1  delete the whole `§5b` block          → 7 of 14 fail (A1-A5, D1, D2).
 *       There is no typecheck backstop: `tsconfig.json` sets no
 *       `noUnusedLocals`, so `isOrgPath` / `checkOrgAccess` would sit
 *       imported-but-unused without even a tsc error.
 *   M2  `{ status: 404 }` → `{ status: 403 }` → 5 of 14 fail (A1, A2, A3,
 *       A5, D1). The re-leak described above.
 *   M3  `gateResult !== 'allow'` → `=== 'cross_org'` → 3 of 14 fail (A2, A3,
 *       D2). This is why A2 exists SEPARATELY from A1: a spec that only
 *       exercised the cross-org path would rate the no-org-memberships hole
 *       as harmless.
 */
import { NextRequest } from 'next/server';

// Stub ONLY the async budget checks. `isApiReadRateLimited` and
// `extractTenantSlug` are pure path/method predicates that decide WHICH stage
// a request reaches, so replacing them would change the control flow this file
// is trying to observe. Spreading requireActual keeps them real.
//
// This is load-bearing HERE in a way worth spelling out: `isApiReadRateLimited`
// is called on every request that SURVIVES the org gate. A bare object literal
// drops it (reads back as `undefined`), and the resulting "is not a function"
// kills exactly the six allow-path tests — B1, B2, C1, C4, D1, D2 — while all
// five deny tests keep passing, because they return before reaching it. That
// is the precise inversion of what you want: the positive controls die and the
// "the gate works" tests survive.
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

/** The org this token's holder actually belongs to. */
const MEMBER_ORG = 'acme-org';
/** An org they do not belong to — the enumeration probe. */
const OTHER_ORG = 'globex';

/**
 * A token that is valid in every respect. `orgMemberships` is THE CLAIM UNDER
 * TEST; every other field is here so the token is a realistic JWT and so the
 * tenant-path control (C4) is honest.
 *
 * Deliberately carries NO `error`: a stray one turns every deny case into the
 * §2b 401 and every allow case into a 401 too, so the file would pass while
 * observing nothing. Deliberately carries no `orgMembershipsTruncated` either
 * — the middleware reads `=== true`, so absence is the normal state, and C1
 * opts into the truncated branch explicitly.
 */
function validToken(overrides: Record<string, unknown> = {}) {
    return {
        userId: 'usr_1',
        sub: 'usr_1',
        tenantId: 'tnt_1',
        tenantSlug: 'acme-corp',
        role: 'ADMIN',
        userSessionId: 'sess_1',
        // Tenant memberships are NOT read on an org path — `isTenantPath` is
        // false for `/org/**`, so §4 (MFA) and §5 (tenant gate) never execute
        // there. Kept correctly shaped (`{ slug, role, tenantId }`, what
        // `applyMembershipClaims` in src/auth.ts builds) purely so C4's
        // tenant-path request is a real allow rather than an accidental 403.
        memberships: [{ tenantId: 'tnt_1', slug: 'acme-corp', role: 'ADMIN' }],
        // The entry key is `slug` — NOT `orgSlug`, NOT `organizationSlug`.
        // `checkOrgAccess` scans `m.slug`, and `applyMembershipClaims` maps
        // `{ slug: m.organization.slug, role: m.role, organizationId }`.
        //
        // This is the trap in this file, and it fails SILENTLY: forge the key
        // wrong and the scan misses, so the verdict is `cross_org`, so every
        // refusal assertion below still passes — a file testing that a
        // nonexistent claim is rejected. MEASURED with the key rewritten to
        // `orgSlug`: A1-A5 and C1-C4 all stay GREEN, and the only four
        // failures are B1, B2 and the ALLOWED legs of D1/D2 — i.e. nothing
        // but the positive controls. Never ship this file without them.
        orgMemberships: [
            { slug: MEMBER_ORG, role: 'ORG_ADMIN', organizationId: 'org_1' },
        ],
        ...overrides,
    };
}

function req(pathname: string, method = 'GET') {
    // No headers at all: an `origin` would engage CORS, an
    // `x-agrent-client-version` could produce the §3 426, and any path ending
    // in a static extension (.json/.map/…) is public and 200s before the gate.
    return new NextRequest(`http://localhost:3000${pathname}`, { method });
}

/** The reason string in a gate body — the distinguisher, not the status. */
async function reason(res: Response): Promise<string> {
    return ((await res.json()) as { error?: string }).error ?? '';
}

/** `location` as a pathname, so a 307's DESTINATION is what gets asserted. */
function redirectPath(res: Response): string {
    const location = res.headers.get('location');
    return location ? new URL(location).pathname : '';
}

beforeEach(() => getToken.mockReset());

describe('an org path the token does not carry is refused', () => {
    it('A1 cross-org API => 404 with reason `not_found`, from the ORG GATE specifically', async () => {
        // 404 is emitted at exactly ONE place in the whole of
        // `src/middleware.ts` — the org gate's API arm. Every gate that could
        // have run earlier answers 401 (`Unauthorized`), 426
        // (`client_version_unsupported`) or 200; the admin, MFA and
        // tenant-access gates are all `isTenantPath`-scoped and unreachable
        // on `/org/**`. So `404 + 'not_found'` on an org path is proof this
        // request reached the branch and nothing else produced the answer.
        //
        // The token holds a NON-EMPTY org list, so this exercises the
        // `m.slug` scan rather than the empty-list shortcut A2 covers.
        getToken.mockResolvedValue(validToken());
        const res = await middleware(req(`/api/org/${OTHER_ORG}/portfolio`), {} as any);

        expect(res.status).toBe(404);
        expect(await reason(res)).toBe('not_found');
    });

    it('A2 a user with NO org memberships at all is refused the same way', async () => {
        // The `no_org_access` verdict — a distinct arm of `checkOrgAccess`
        // that A1 does not reach. Dropping it (`!== 'allow'` narrowed to
        // `=== 'cross_org'`) lets every org-less account sail through the
        // Edge, leaving only the handler's own check standing.
        getToken.mockResolvedValue(validToken({ orgMemberships: [] }));
        const res = await middleware(req(`/api/org/${MEMBER_ORG}/portfolio`), {} as any);

        expect(res.status).toBe(404);
        expect(await reason(res)).toBe('not_found');
    });

    it('A3 the two refusal verdicts are BYTE-IDENTICAL to the caller (anti-enumeration)', async () => {
        // The behavioural form of what the structural ratchet only asserts
        // about source text. Same URL, two token states: "you are in another
        // co-op" and "you are in no co-op" must be indistinguishable, or the
        // response tells a prober which org slugs are real.
        getToken.mockResolvedValue(validToken());
        const crossOrg = await middleware(req(`/api/org/${OTHER_ORG}/portfolio`), {} as any);

        getToken.mockResolvedValue(validToken({ orgMemberships: [] }));
        const noOrg = await middleware(req(`/api/org/${OTHER_ORG}/portfolio`), {} as any);

        expect(crossOrg.status).toBe(404);
        expect(noOrg.status).toBe(crossOrg.status);
        expect(await noOrg.json()).toEqual(await crossOrg.json());
    });

    it('A4 cross-org PAGE => 307 to /no-tenant — the pathname is the distinguisher', async () => {
        // `toBe(307)` alone would be a false positive waiting to happen: the
        // no-token path (§2) and the `token.error` path (§2b) both answer 307
        // on a page route. Both go to /login. Only the org gate sends the
        // operator to /no-tenant, which is the same landing page a non-member
        // reaches today via the layout's `notFound()` collapse — so a prober
        // cannot tell whether the slug exists.
        getToken.mockResolvedValue(validToken());
        const res = await middleware(req(`/org/${OTHER_ORG}/tenants`), {} as any);

        expect(res.status).toBe(307);
        expect(redirectPath(res)).toBe('/no-tenant');
        expect(res.headers.get('location') ?? '').not.toContain('/login');
    });

    it('A4b the OTHER reachable page 307 goes to /login — proving A4 attributed correctly', async () => {
        // Makes A4's distinguisher concrete rather than assumed: the same URL
        // with no token at all produces the upstream 307, and it lands
        // somewhere else. If both redirects went to the same place, A4 would
        // be asserting nothing about which gate fired.
        getToken.mockResolvedValue(null);
        const res = await middleware(req(`/org/${OTHER_ORG}/tenants`), {} as any);

        expect(res.status).toBe(307);
        expect(redirectPath(res)).toBe('/login');
        expect(redirectPath(res)).not.toBe('/no-tenant');
    });

    it('A5 the gate is method-agnostic — a POST is refused too', async () => {
        // Unlike the read-rate-limit tier immediately below it, this gate is
        // not scoped by method. `/api/org/:slug/tenants` POST is how a farm is
        // attached to a cooperative; a write must not slip past a gate that
        // only inspects GETs.
        getToken.mockResolvedValue(validToken());
        const res = await middleware(req(`/api/org/${OTHER_ORG}/tenants`, 'POST'), {} as any);

        expect(res.status).toBe(404);
        expect(await reason(res)).toBe('not_found');
    });
});

describe('POSITIVE CONTROLS — the earlier gates were passed, and the gate ALLOWED', () => {
    // These are what make the refusals above honest. A middleware that refused
    // everything, or a token forged with the wrong `orgMemberships` entry key,
    // satisfies every assertion in the block above and fails here.

    it('B1 a member API request reaches the application', async () => {
        getToken.mockResolvedValue(validToken());
        const res = await middleware(req(`/api/org/${MEMBER_ORG}/portfolio`), {} as any);

        expect(res.status).toBe(200);
        // §2 + §2b passed: the token was present and carried no `error`.
        expect(res.status).not.toBe(401);
        // No admin / MFA / tenant gate fired on the way down.
        expect(res.status).not.toBe(403);
        // The org gate ALLOWED — i.e. the `m.slug` comparison MATCHED, rather
        // than the whole block being skipped or the token being wrong-shaped.
        expect(res.status).not.toBe(404);
        expect(res.headers.get('location')).toBeNull();
    });

    it('B2 a member PAGE request reaches the application', async () => {
        getToken.mockResolvedValue(validToken());
        const res = await middleware(req(`/org/${MEMBER_ORG}/tenants`), {} as any);

        expect(res.status).toBe(200);
        // No redirect from ANY earlier gate — not /login, not /no-tenant.
        expect(res.headers.get('location')).toBeNull();
    });
});

describe('the gate is precise — it must not refuse traffic it has no business refusing', () => {
    it('C1 a TRUNCATED org list defers to the authoritative server gate', async () => {
        // `orgMemberships` is capped in the JWT (a cookie is a fixed-size
        // credential). A slug-miss against a capped list is not evidence of
        // non-membership, so it must defer rather than deny — otherwise an
        // operator in more orgs than the cap is locked out of the ones that
        // fell off the end.
        getToken.mockResolvedValue(
            validToken({
                orgMemberships: [
                    { slug: 'other-org', role: 'ORG_READER', organizationId: 'org_9' },
                ],
                orgMembershipsTruncated: true,
            }),
        );
        const res = await middleware(req(`/api/org/${MEMBER_ORG}/portfolio`), {} as any);

        expect(res.status).toBe(200);
        expect(res.status).not.toBe(404);
    });

    it('C2 the public org-invite API is NOT 404d — an invitee has no membership yet', async () => {
        // Double-protected: `/api/org/invite/` is a public prefix (short-
        // circuits before the gate) AND `checkOrgAccess` re-checks
        // `isPublicPath`. Lose either carve-out and the endpoint whose entire
        // job is onboarding a new co-op member 404s at the one moment the
        // caller is guaranteed to have zero org memberships.
        getToken.mockResolvedValue(validToken({ orgMemberships: [] }));
        const res = await middleware(req('/api/org/invite/tok_123'), {} as any);

        expect(res.status).toBe(200);
        expect(res.status).not.toBe(404);
    });

    it('C3 `isOrgPath` is prefix-precise — /api/organizations is not an org path', async () => {
        // Catches a "simplification" of `startsWith('/api/org/')` to
        // `includes('/org')`, which would start 404ing unrelated routes for
        // anyone without the matching membership.
        getToken.mockResolvedValue(validToken({ orgMemberships: [] }));
        const res = await middleware(req('/api/organizations'), {} as any);

        expect(res.status).not.toBe(404);
        expect(res.status).toBe(200);
    });

    it('C4 a TENANT path is not gated by orgMemberships — the two gates are keyed apart', async () => {
        // Most farm operators belong to no cooperative at all. If the org gate
        // leaked onto `/api/t/**`, every one of them would lose their own farm.
        getToken.mockResolvedValue(validToken({ orgMemberships: [] }));
        const res = await middleware(req('/api/t/acme-corp/tasks'), {} as any);

        expect(res.status).toBe(200);
        expect(res.status).not.toBe(404);
    });
});

describe('regression proof — the gate is load-bearing', () => {
    it('D1 API: the SAME request is allowed for a member and refused for a non-member', async () => {
        // One differential assertion, identical but for a single slug. Delete
        // the middleware block and this fails immediately — whereas asserting
        // against `checkOrgAccess`'s return value, as the integration file
        // does, would stay green.
        getToken.mockResolvedValue(validToken());
        const allowed = await middleware(req(`/api/org/${MEMBER_ORG}/portfolio`), {} as any);

        getToken.mockResolvedValue(
            validToken({
                orgMemberships: [
                    { slug: OTHER_ORG, role: 'ORG_ADMIN', organizationId: 'org_2' },
                ],
            }),
        );
        const refused = await middleware(req(`/api/org/${MEMBER_ORG}/portfolio`), {} as any);

        expect(allowed.status).toBe(200);
        expect(refused.status).toBe(404);
        expect(await reason(refused)).toBe('not_found');
    });

    it('D2 page: the SAME request is allowed for a member and redirected for a non-member', async () => {
        getToken.mockResolvedValue(validToken());
        const allowed = await middleware(req(`/org/${MEMBER_ORG}/tenants`), {} as any);

        getToken.mockResolvedValue(validToken({ orgMemberships: [] }));
        const refused = await middleware(req(`/org/${MEMBER_ORG}/tenants`), {} as any);

        expect(allowed.status).toBe(200);
        expect(allowed.headers.get('location')).toBeNull();
        expect(refused.status).toBe(307);
        expect(redirectPath(refused)).toBe('/no-tenant');
    });
});
