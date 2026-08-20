/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these surfaces (see tests/unit/cors.test.ts). */

/**
 * The MECHANISATOR operator lockdown must REFUSE A REQUEST — not merely
 * compute an allowlist.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `operator_scope` — the code the lockdown refuses an API call with — occurs
 * in exactly ONE place in the whole repository, `src/middleware.ts:325`, and
 * in ZERO test files (issue #628). The branch that emits it was unreachable
 * from every harness that drives the real middleware.
 *
 * What it protects, in this product's terms: MECHANISATOR is the
 * machine-operator / sprayer persona — the person on the tractor holding a
 * phone on rural LTE. The role exists so a farm can hand a device to a
 * seasonal operator without handing over the farm. The lockdown confines that
 * session to the "My work" queue, the field-operation completion flow and the
 * fields map, and refuses everything else: the journal that feeds БАБХ
 * regulatory reporting, the grain contracts, the exchange listings, the lease
 * register carrying third-party lessor names and ЕИК. The stripped app shell
 * and the minimal permission set are defence in depth — THIS branch is the
 * load-bearing part, and it lives in the middleware, where only a real
 * request can reach it.
 *
 * The reason CI never noticed is the part worth remembering:
 *
 *   - `tests/unit/operator-lockdown.test.ts` imports the pure predicate
 *     `isOperatorAllowedPath` from `@/lib/auth/guard` and asserts against
 *     THAT. It never constructs a request and never imports the middleware,
 *     so it stays green with the entire enforcement block deleted. The
 *     mechanism is tested; the enforcement point is not — the same severed
 *     seam as `token.error` before `session-revocation-enforced.test.ts` and
 *     `token.mfaPending` before `mfa-gate-enforced.test.ts`.
 *   - Every suite that DOES drive the real middleware forges a token carrying
 *     `role: 'ADMIN'` or `'EDITOR'`, so the true-arm of the lockdown is
 *     unreachable by construction from the only harness that could reach it.
 *     No seed, fixture or e2e helper creates a MECHANISATOR membership.
 *
 * MUTATIONS THIS FILE CATCHES (all four were run against a copy of
 * `src/middleware.ts`, not reasoned about):
 *   - delete the whole lockdown block (lines 307-330) → 6 of 11 fail;
 *   - drop the `!` on `isOperatorAllowedPath` → 8 of 11 fail, which is what
 *     makes the allow-side assertions non-decorative;
 *   - weaken the API arm to a generic `forbiddenJson()` — still 403, body
 *     `{"error":"Forbidden"}` → the 5 tests that pin the reason string fail.
 *     That is the direct proof a status-only test would have shipped it;
 *   - the plausible "simplification" of `membership?.role` to `token.role`,
 *     dropping the per-slug `memberships.find` → EXACTLY ONE test fails, the
 *     multi-tenant control. Without it that refactor ships silently and locks
 *     a multi-tenant operator out of a tenant where they are an ADMIN.
 *
 * There is no typecheck backstop either: `tsconfig.json` sets no
 * `noUnusedLocals`, so deleting the block would leave `isOperatorAllowedPath`
 * imported-but-unused in `src/middleware.ts` without even a tsc error.
 *
 * READ THE STATUS CODES WITH SUSPICION. Five gates sit upstream of the
 * lockdown and answer on these same URLs — several with the SAME status:
 * 401 `Unauthorized`, 426 `client_version_unsupported`, 403
 * `Admin access required`, 403 `MFA verification required`, 403
 * `no_tenant_access`, 403 `cross_tenant_access_denied`, 307 → `/login`,
 * 307 → `/t/:slug/auth/mfa`, 307 → `/no-tenant`. So every refusal below pins
 * the BODY CODE (`operator_scope`) or the redirect PATHNAME
 * (`/t/:slug/my-work`), never the bare status; and every allow-side
 * assertion is `toBe(200)`, because `not.toBe(403)` passes on a 401 and on a
 * 307 as well. The POSITIVE CONTROLS at the bottom are what prove the forged
 * token actually cleared those five gates — without them a middleware that
 * refused everything would satisfy the refusal assertions.
 */
import { NextRequest } from 'next/server';
import { Role } from '@prisma/client';

// Stub ONLY the async budget checks. `isApiReadRateLimited` and
// `extractTenantSlug` are pure path/method predicates that decide WHICH stage
// a request reaches, so replacing them would change the control flow this
// file is trying to observe. Spreading requireActual keeps them real — a bare
// object literal silently yields `undefined` for every export it omits.
//
// That failure is asymmetric here and worth naming: the read-tier limiter
// sits AFTER the lockdown, so a bare-object mock would leave the four DENIAL
// tests green (they return at :325/:327-329) and blow up only the ALLOW side
// with "isApiReadRateLimited is not a function". Half-green, in the direction
// that hides the thing you care about.
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
import { checkApiReadRateLimit } from '../../src/lib/rate-limit/apiReadRateLimit';

const SLUG = 'acme-corp';
const OTHER_SLUG = 'globex';

/** Where the lockdown sends an operator who wandered off their screen. */
const MY_WORK = `/t/${SLUG}/my-work`;

/**
 * A token that is valid in every respect EXCEPT the membership role.
 *
 * Deliberately carries NO `error` and NO `mfaPending`: either one produces a
 * refusal from an upstream gate that is status-identical to the lockdown's
 * (401 / 307 → `/login`, or 403 / 307 → the MFA challenge), which is exactly
 * how one severed gate hid behind another before #635.
 *
 * `role` is the PRIMARY membership's role (src/auth.ts builds it that way),
 * so it is kept consistent with `memberships[0]` — a token whose primary role
 * disagrees with its first membership cannot exist in production and would
 * make the admin gate behave differently here than it does live. The lockdown
 * does NOT read this field; the multi-tenant control below is what proves it.
 */
function tokenWithRole(role: Role, overrides: Record<string, unknown> = {}) {
    return {
        userId: 'usr_1',
        sub: 'usr_1',
        tenantId: 'tnt_1',
        tenantSlug: SLUG,
        role,
        userSessionId: 'sess_1',
        // `slug`, NOT `tenantSlug`. The jwt callback builds
        // `{ slug, role, tenantId }` (src/auth.ts:207-210) and the lockdown's
        // own `memberships?.find((m) => m.slug === slug)` scans `m.slug`.
        // With the wrong key the TENANT-ACCESS gate one stage upstream 403s
        // `cross_tenant_access_denied` on the API and 307s to `/no-tenant` on
        // the page — both indistinguishable BY STATUS from the lockdown's own
        // answers, so the denial tests would pass for the wrong reason while
        // the lockdown was never executed. That is the trap PR #635 fixed;
        // the EDITOR control below is what turns it into a loud failure.
        memberships: [{ tenantId: 'tnt_1', slug: SLUG, role }],
        ...overrides,
    };
}

/** The persona under lockdown. Imported from the Prisma enum, not spelled
 *  inline, so renaming the role in `prisma/schema/enums.prisma` breaks this
 *  file at compile time instead of quietly disarming it. */
const operatorToken = (o: Record<string, unknown> = {}) =>
    tokenWithRole(Role.MECHANISATOR, o);
/** The control persona: same request, same tenant, one role apart. */
const editorToken = (o: Record<string, unknown> = {}) => tokenWithRole(Role.EDITOR, o);

function req(pathname: string, method = 'GET') {
    // The origin is load-bearing: the page arm builds its redirect from
    // `req.nextUrl.origin`, so the `location` header is absolute.
    // No headers at all — `x-agrent-client-version` below the floor would
    // answer 426, a cross-site `sec-fetch-site` would answer its own 403, and
    // OPTIONS would be answered by the CORS preflight at 204.
    return new NextRequest(`http://localhost:3000${pathname}`, { method });
}

/** The `error` code in a middleware JSON refusal body. */
async function reason(res: Response): Promise<string> {
    return ((await res.json()) as { error?: string }).error ?? '';
}

/** Redirect target, or '' when the response is not a redirect. */
const loc = (res: Response) => res.headers.get('location') ?? '';

beforeEach(() => {
    getToken.mockReset();
    jest.mocked(checkApiReadRateLimit).mockClear();
});

describe('an out-of-scope request from a MECHANISATOR is refused', () => {
    it('tenant API => 403, and 403 FROM THE LOCKDOWN specifically', async () => {
        // The status alone is worthless. The tenant-access gate immediately
        // upstream answers 403 on this exact URL with
        // `cross_tenant_access_denied`, and the admin + MFA gates answer 403
        // with strings of their own. `operator_scope` is the only code that
        // means "we stopped you because you are a machine operator", and it
        // exists nowhere else in `src/`.
        getToken.mockResolvedValue(operatorToken());
        const res = await middleware(req(`/api/t/${SLUG}/journal`), {} as any);

        expect(res.status).toBe(403);
        expect(await reason(res)).toBe('operator_scope');
    });

    it('tenant page => 307 to the operator My-work screen, not to /login or /no-tenant', async () => {
        // Compare the PATHNAME, not `toContain('/my-work')`: `toContain`
        // would also match `/my-workshop` and would not distinguish the
        // origin. And 307 by itself is meaningless — `/login`,
        // `/t/:slug/auth/mfa` and `/no-tenant` are all 307 from earlier gates.
        getToken.mockResolvedValue(operatorToken());
        const res = await middleware(req(`/t/${SLUG}/dashboard`), {} as any);

        expect(res.status).toBe(307);
        expect(new URL(loc(res)).pathname).toBe(MY_WORK);
    });

    it('a MUTATION is refused identically — the lockdown is not a read-tier artefact', async () => {
        // Also proves the refusal is not the API read rate limiter, which
        // sits after the lockdown and only ever sees GETs. An operator who
        // can POST to the journal can write the БАБХ record.
        getToken.mockResolvedValue(operatorToken());
        const res = await middleware(req(`/api/t/${SLUG}/journal`, 'POST'), {} as any);

        expect(res.status).toBe(403);
        expect(await reason(res)).toBe('operator_scope');
    });

    it('prefix spoofing does not slip past the allowlist, on either surface', async () => {
        // Pins the `(\/|$|\?)` boundary in the API arm and the exact-equality
        // page arm through the real wiring. `farm-tasks-evil` is not
        // `farm-tasks`; `my-workshop` is not `my-work`.
        getToken.mockResolvedValue(operatorToken());

        for (const spoof of [`/api/t/${SLUG}/farm-tasks-evil`, `/api/t/${SLUG}/tasksomething`]) {
            const res = await middleware(req(spoof), {} as any);
            expect(res.status).toBe(403);
            expect(await reason(res)).toBe('operator_scope');
        }

        const page = await middleware(req(`/t/${SLUG}/my-workshop`), {} as any);
        expect(page.status).toBe(307);
        expect(new URL(loc(page)).pathname).toBe(MY_WORK);
    });
});

describe('the lockdown is precise — it must not stop the operator doing the job', () => {
    it('the queue, completion, task-status, fields and tile APIs all pass', async () => {
        // `toBe(200)`, never `not.toBe(403)`: five statuses (200, 307, 401,
        // 403, 426) are reachable on these URLs, so a negative assertion
        // would call a 401 a pass. Every path here is something the sprayer
        // needs mid-field on a bad LTE connection.
        getToken.mockResolvedValue(operatorToken());

        const allowed: ReadonlyArray<readonly [string, string]> = [
            ['GET', `/api/t/${SLUG}/farm-tasks`],
            // The query string never reaches the predicate — `nextUrl.pathname`
            // has already stripped it — so this passes via the `$` alternative,
            // not the `\?` one. (The `\?` branch belongs to the pure-predicate
            // suite; do not claim it is exercised here.)
            ['GET', `/api/t/${SLUG}/farm-tasks?open=1`],
            ['GET', `/api/t/${SLUG}/tasks/t1/status`],
            ['POST', `/api/t/${SLUG}/field-operations/t1`],
            ['GET', `/api/t/${SLUG}/locations`],
            ['GET', `/api/t/${SLUG}/agro/ndvi-tiles`],
        ];

        for (const [method, path] of allowed) {
            const res = await middleware(req(path, method), {} as any);
            expect([method, path, res.status]).toEqual([method, path, 200]);
        }
    });

    it('the My-work, field and locations pages pass with NO redirect', async () => {
        // A redirect here would be a loop: the lockdown would be bouncing the
        // operator away from the one screen it is bouncing them towards.
        getToken.mockResolvedValue(operatorToken());

        for (const path of [MY_WORK, `/t/${SLUG}/field/task-1`, `/t/${SLUG}/locations`]) {
            const res = await middleware(req(path), {} as any);
            expect([path, res.status]).toEqual([path, 200]);
            expect([path, loc(res)]).toEqual([path, '']);
        }
    });

    it('the role match is EXACT — a lowercase role is not a MECHANISATOR', async () => {
        // Pins the `===` against a well-meaning "case-insensitive tidy-up".
        // The comparison is against the Prisma enum literal; anything else is
        // a different persona and must not be silently locked down.
        getToken.mockResolvedValue(
            tokenWithRole('mechanisator' as Role),
        );
        const res = await middleware(req(`/api/t/${SLUG}/journal`), {} as any);

        expect(res.status).toBe(200);
    });
});

describe('positive controls — proof the earlier gates were actually cleared', () => {
    it('CONTROL: the SAME request from an EDITOR is allowed', async () => {
        // The load-bearing control. Reaching 200 on this URL means the forged
        // token cleared the JWT gate, the `token.error` gate, the client
        // version gate, the MFA gate AND the tenant-access gate, and that the
        // request travelled all the way past the lockdown into the read-tier
        // limiter. Without it, a middleware that refused everything — or a
        // token whose `memberships` used the wrong key — would satisfy every
        // refusal assertion above.
        getToken.mockResolvedValue(editorToken());
        const res = await middleware(req(`/api/t/${SLUG}/journal`), {} as any);

        expect(res.status).toBe(200);
        // "When you mock a module, assert the mock was CALLED": the read-tier
        // limiter is downstream of the lockdown, so this call happening at
        // all is independent evidence the request got past line 323.
        expect(jest.mocked(checkApiReadRateLimit)).toHaveBeenCalled();
    });

    it('CONTROL: a genuine cross-tenant refusal carries a DIFFERENT code', async () => {
        // Proves the two 403s on this surface are distinguishable, so
        // `operator_scope` above is a real discriminator and not a
        // coincidence of the harness. This operator has no globex membership
        // at all, so the tenant gate stops them one stage earlier.
        getToken.mockResolvedValue(operatorToken());
        const res = await middleware(req(`/api/t/${OTHER_SLUG}/journal`), {} as any);

        expect(res.status).toBe(403);
        expect(await reason(res)).toBe('cross_tenant_access_denied');
    });

    it('CONTROL: the gate reads the membership for THIS URL\'s slug, not token.role', async () => {
        // A contractor who sprays for one farm and manages another. The
        // primary membership (and therefore `token.role`) is MECHANISATOR,
        // but in globex they are an ADMIN and must not be locked down there.
        //
        // This is the ONLY assertion in the file that fails when someone
        // "simplifies" `membership?.role === 'MECHANISATOR'` to
        // `token.role === 'MECHANISATOR'` — in a single-membership token the
        // two agree, so every other test here survives that refactor.
        getToken.mockResolvedValue(
            operatorToken({
                memberships: [
                    { tenantId: 'tnt_1', slug: SLUG, role: Role.MECHANISATOR },
                    { tenantId: 'tnt_2', slug: OTHER_SLUG, role: Role.ADMIN },
                ],
            }),
        );

        const asAdmin = await middleware(req(`/api/t/${OTHER_SLUG}/journal`), {} as any);
        expect(asAdmin.status).toBe(200);

        const asOperator = await middleware(req(`/api/t/${SLUG}/journal`), {} as any);
        expect(asOperator.status).toBe(403);
        expect(await reason(asOperator)).toBe('operator_scope');
    });
});

describe('regression proof — the lockdown is load-bearing', () => {
    it('the identical request is allowed one membership role apart', async () => {
        // A single differential assertion: same URL, same method, same token
        // shape, one field changed. If the enforcement block is deleted this
        // fails immediately — whereas asserting `isOperatorAllowedPath`
        // directly, as tests/unit/operator-lockdown.test.ts does, stays green
        // through the deletion and through all three narrower mutants.
        getToken.mockResolvedValue(editorToken());
        const allowed = await middleware(req(`/api/t/${SLUG}/journal`), {} as any);

        getToken.mockResolvedValue(operatorToken());
        const refused = await middleware(req(`/api/t/${SLUG}/journal`), {} as any);

        expect(allowed.status).toBe(200);
        expect(refused.status).toBe(403);
        expect(await reason(refused)).toBe('operator_scope');
    });
});
