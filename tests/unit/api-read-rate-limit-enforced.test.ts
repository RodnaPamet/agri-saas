/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these middleware harnesses (see
 * tests/unit/mfa-gate-enforced.test.ts, tests/unit/cors.test.ts). */

/**
 * The API read-tier budget must REFUSE A REQUEST — not merely be importable.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * GAP-17's read tier (`API_READ_LIMIT`, 120/min) has exactly one enforcement
 * point: the eight-line block at `src/middleware.ts:375-382`. Everything a
 * farm operator's phone pulls on a tenant GET — the journal, farm-tasks,
 * locations, exchange listings, the БАБХ-facing regulatory reads — is shielded
 * by that block and by nothing else. If it goes, an anonymous-to-the-DB
 * authenticated caller can drive unbounded reads against a single-VM Postgres
 * that a whole co-operative shares, and the field workers on rural LTE who
 * cannot afford a retry are the ones who notice first.
 *
 * That block was DOUBLY SEVERED from the test suite (issue #631):
 *
 *   - `tests/unit/api-read-rate-limit.test.ts` hand-builds a fake request
 *     (`{ headers: { get } }`) and calls the limiter module directly. It
 *     proves the budget arithmetic, never that anything applies it.
 *   - `tests/guardrails/api-read-rate-limit.test.ts` is `readFileSync` +
 *     regex. It even asserts the ORDERING — via
 *     `src.indexOf('checkTenantAccess(') < src.indexOf('checkApiReadRateLimit(')`
 *     — which is a claim about characters in a file, not about a request.
 *   - Six of the eight suites that import the real `src/middleware.ts`
 *     (`mfa-gate-enforced`, `session-revocation-enforced`,
 *     `bearer-cookie-parity`, `client-version-gate`, `scim-edge-reachability`,
 *     `webhook-edge-reachability`) `jest.mock` `checkApiReadRateLimit` to
 *     `{ ok: true }`. That stub is precisely why line 378 had never once been
 *     executed by a test.
 *
 * So this file imports the REAL limiter module (no stub, not even a partial
 * one — `isApiReadRateLimited` and `extractTenantSlug` are pure predicates
 * that decide WHICH stage a request reaches) and drives the REAL middleware
 * until the budget actually runs out.
 *
 * MUTATION THIS FILE CATCHES (primary): delete `src/middleware.ts:375-382` —
 *
 *     if (isApiReadRateLimited(req.method, pathname)) {
 *         const tenantSlug = extractTenantSlug(pathname);
 *         const userId = (token.sub as string | undefined) ?? null;
 *         const rl = await checkApiReadRateLimit(req, userId, tenantSlug);
 *         if (!rl.ok && rl.response) {
 *             return rl.response;
 *         }
 *     }
 *
 * — leaving the imports at :4-8 in place. `tsconfig.json` sets no
 * `noUnusedLocals`, so that deletion does not even produce a tsc error. The
 * guardrail does notice a wholesale deletion, but only because a STRING
 * vanished from a file — a different claim from "a request was refused", and
 * one that survives every mutation that keeps the symbols and breaks the
 * behaviour (see the three below).
 *
 * 9 of the 12 cases below still pass when the block is deleted — the three
 * that do not are the file's reason to exist:
 *   1. "120 pass, the 121st is a 429 …"
 *   2. "keyed by token.sub …"
 *   3. "keyed by the PATH slug, not token.tenantSlug"
 * The other nine are POSITIVE CONTROLS and precision checks: without them a
 * middleware that refused everything would satisfy the refusal assertions.
 *
 * Three further mutations, each caught by exactly one case:
 *   - move the block above `if (isTenantPath(pathname))` (:279) ⇒
 *     "cross-tenant GETs 403 forever …" fails (the 122nd becomes a 429).
 *   - `const userId = null;` at :377 ⇒ "keyed by token.sub …" fails.
 *   - `const tenantSlug = token.tenantSlug ?? null;` at :376 ⇒
 *     "keyed by the PATH slug …" fails.
 */

// ── Environment ────────────────────────────────────────────────────────────
//
// `@/env` is remapped to `tests/mocks/env.ts` (jest.config.js:196), a live
// Proxy over `process.env` with fallbacks — so these reads are dynamic and
// assignment order relative to the imports does not matter. The VALUES do:
//
//   - RATE_LIMIT_MODE unset ⇒ the proxy answers 'upstash', `init()` builds a
//     `Redis.fromEnv()` client that does NOT throw (it just warns, with
//     url/token undefined), `_limiter.limit()` rejects, and the fail-open
//     catch returns `{ ok: true }` FOREVER. That produces the exact failure
//     signature of a deleted gate — 429 expected, 200 received — and is the
//     single most likely way to mis-diagnose this file.
//   - RATE_LIMIT_ENABLED='0' / AUTH_TEST_MODE='1' / NEXT_TEST_MODE='1' each
//     short-circuit `isBypassed()`. The unit CI job sets none of them, but
//     the `e2e-shard` and `load-smoke` jobs DO set the first two, and a
//     developer shell that exported either turns this whole file
//     green-and-empty. Their env-mock fallbacks ('1' and 'true') are
//     non-bypassing, so DELETING them is the correct move.
function pinRateLimitEnv(): void {
    process.env.RATE_LIMIT_MODE = 'memory';
    delete process.env.RATE_LIMIT_ENABLED;
    delete process.env.AUTH_TEST_MODE;
    delete process.env.NEXT_TEST_MODE;
}
pinRateLimitEnv();

import { NextRequest } from 'next/server';

// Stub ONLY the auth-tier budget check — it fires exclusively on
// `/api/auth/` (src/middleware.ts:457) and no fixture here is on that
// prefix, but the house harnesses stub it and its 429 body is flat
// (`{ error: 'RATE_LIMITED', retryAfterSeconds }`), i.e. confusable with
// the nested read-tier shape. Spreading requireActual keeps every other
// export real: a bare object literal reads back as `undefined` and only
// surfaces as "is not a function" once some path calls one.
jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    ...jest.requireActual('../../src/lib/rate-limit/authRateLimit'),
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE THE ABSENCE. There is deliberately NO
// `jest.mock('.../apiReadRateLimit', …)` here. Copying that block from
// mfa-gate-enforced.test.ts:51-54 would restore the exact severance this
// file exists to close.

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: any[]) => getToken(...a) }));

import middleware from '../../src/middleware';
import {
    _clearApiReadRateLimitMemory,
    checkApiReadRateLimit,
} from '@/lib/rate-limit/apiReadRateLimit';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';

/** Never hard-code 120. A policy change must move this test with the code. */
const MAX = API_READ_LIMIT.maxAttempts;

/**
 * A token that is valid in every respect — the whole point is that it gets
 * all the way to line 375 and is stopped by the BUDGET, not by a gate.
 *
 * `slug`, NOT `tenantSlug`, inside `memberships`: the jwt callback builds
 * `{ slug, role, tenantId }` (src/auth.ts:209-215) and `checkTenantAccess`
 * scans `m.slug` (guard.ts:326). With the wrong key every
 * `/api/t/acme-corp/...` request dies at §5 with a 403 and never reaches the
 * limiter — and `expect(status).not.toBe(401)` would sail straight past it.
 * The P0 control below is what makes that impossible.
 */
function validToken(overrides: Record<string, unknown> = {}) {
    return {
        userId: 'usr_1',
        sub: 'usr_1', // ← line 377 reads token.sub for the bucket key
        tenantId: 'tnt_1',
        tenantSlug: 'acme-corp', // present, but NOT what keys the bucket
        role: 'ADMIN',
        userSessionId: 'sess_1',
        memberships: [{ tenantId: 'tnt_1', slug: 'acme-corp', role: 'ADMIN' }],
        ...overrides,
    };
}

const BOTH_TENANTS = [
    { tenantId: 'tnt_1', slug: 'acme-corp', role: 'ADMIN' },
    { tenantId: 'tnt_2', slug: 'globex', role: 'ADMIN' },
];

/**
 * No headers at all. `getClientIp` (apiReadRateLimit.ts:129-136) falls back to
 * '127.0.0.1', which is what puts every request in the loop into the SAME
 * bucket `rl:api-read:t:acme-corp:ip:127.0.0.1:u:usr_1`. A per-request varying
 * `x-forwarded-for` would hand each request a fresh bucket and no 429 would
 * ever arrive. `x-agrent-client-version` is likewise omitted — an old value
 * 426s at §2c, upstream of the branch under test.
 */
function request(pathname: string, method = 'GET') {
    return new NextRequest(`http://localhost:3000${pathname}`, { method });
}

/** Drive N requests, asserting nothing; returns the LAST response. */
async function drive(count: number, pathname: string, method = 'GET') {
    let last: any;
    for (let i = 0; i < count; i++) {
        last = await middleware(request(pathname, method), {} as any);
    }
    return last;
}

/** The nested read-tier 429 body (apiReadRateLimit.ts:260-268). */
interface ReadLimitBody {
    error: { code: string; scope: string; message: string; retryAfterSeconds: number };
}

const JOURNAL = '/api/t/acme-corp/journal';
const GLOBEX_JOURNAL = '/api/t/globex/journal';

beforeEach(() => {
    getToken.mockReset();
    _clearApiReadRateLimitMemory();
    pinRateLimitEnv();
});

describe('POSITIVE CONTROL — the request actually arrives at the limiter', () => {
    it('a fully valid tenant GET is passed through, so every upstream gate was cleared', async () => {
        // This is the assertion that makes every refusal below meaningful.
        // Seven gates sit above line 375 and each answers with its own status
        // and reason: §2 401 Unauthorized, §2b 401 Unauthorized (+ cleared
        // cookies), §2c 426 client_version_unsupported, §3 403 "Admin access
        // required" / "Cross-site admin requests are not allowed", §4 403 "MFA
        // verification required", §5 403 no_tenant_access /
        // cross_tenant_access_denied / operator_scope, §5b 404 not_found.
        // A 200 carrying `x-middleware-next: 1` — the header Next sets only
        // inside `NextResponse.next()` — is proof none of them fired and the
        // request reached §5c.
        getToken.mockResolvedValue(validToken());
        const res = await middleware(request(JOURNAL), {} as any);

        expect(res.status).toBe(200);
        expect(res.headers.get('x-middleware-next')).toBe('1');
    });
});

describe('the read budget is enforced on tenant-scoped GETs', () => {
    it(`${MAX} pass, the ${MAX + 1}st is a 429 identified as the api-read tier`, async () => {
        // `checkMemory` increments FIRST and compares `count <= maxAttempts`
        // (apiReadRateLimit.ts:170-171), so request MAX is the last 200 and
        // request MAX+1 is the first 429. Assert every one of the allowed
        // requests, not just the last: a gate that started refusing early
        // would otherwise read as a pass.
        getToken.mockResolvedValue(validToken());

        for (let i = 1; i <= MAX; i++) {
            const r = await middleware(request(JOURNAL), {} as any);
            expect(r.status).toBe(200);
        }

        const limited = await middleware(request(JOURNAL), {} as any);
        expect(limited.status).toBe(429);

        // ── the DISTINGUISHING reason ──
        // 429 alone is not enough: the auth tier also answers 429, with a
        // FLAT body (`{ error: 'RATE_LIMITED', retryAfterSeconds }`,
        // authRateLimit.ts:207). `error.scope === 'api-read'` is the only
        // marker that says this refusal came from GAP-17's read tier and not
        // from a neighbouring limiter or gate.
        const body = (await limited.json()) as ReadLimitBody;
        expect(body.error.code).toBe('RATE_LIMITED');
        expect(body.error.scope).toBe('api-read');

        // ── the client's recovery instructions ──
        // A field worker's phone retries on `Retry-After`. Losing this header
        // turns a soft throttle into an app that appears broken on rural LTE.
        const retryAfter = limited.headers.get('Retry-After');
        expect(retryAfter).toMatch(/^\d+$/);
        expect(Number(retryAfter)).toBeGreaterThanOrEqual(1); // forced by :177

        expect(limited.headers.get('X-RateLimit-Limit')).toBe(String(MAX));
        expect(limited.headers.get('X-RateLimit-Remaining')).toBe('0');
        expect(limited.headers.get('X-RateLimit-Reset')).toMatch(/^\d+$/);

        // ── round-trip control ──
        // `x-request-id` is stamped by the OUTER `middleware()` composition
        // (:512), never by the limiter. Its presence proves this 429 is the
        // response a client would actually receive — the limiter's
        // `NextResponse` survived the `isPassThrough` branch at :485-495 —
        // rather than a bare return value observed in isolation.
        expect(limited.headers.get('x-request-id')).toBeTruthy();

        // ── no PII on the wire ──
        // The bucket key contains the user id and the IP; the body must not.
        // CLAUDE.md: "Body never contains IP/userId/tenantSlug."
        const serialised = JSON.stringify(body);
        expect(serialised).not.toContain('usr_1');
        expect(serialised).not.toContain('127.0.0.1');
    });

    it('keyed by token.sub — a second operator on the same IP + tenant has its own budget', async () => {
        // Line 377. Two farm workers sharing one co-operative's NAT address
        // must not be able to throttle each other. Drive the second user all
        // the way to ITS OWN 429 as well, so this case also fails when the
        // block is deleted (a lone `toBe(200)` isolation check would pass
        // vacuously).
        getToken.mockResolvedValue(validToken());
        const exhausted = await drive(MAX + 1, JOURNAL);
        expect(exhausted.status).toBe(429);

        getToken.mockResolvedValue(validToken({ sub: 'usr_2', userId: 'usr_2' }));
        const firstForSecondUser = await middleware(request(JOURNAL), {} as any);
        expect(firstForSecondUser.status).toBe(200);

        const secondUserLimited = await drive(MAX, JOURNAL);
        expect(secondUserLimited.status).toBe(429);
        expect(((await secondUserLimited.json()) as ReadLimitBody).error.scope).toBe('api-read');
    });

    it('keyed by the PATH slug, not token.tenantSlug', async () => {
        // Line 376 reads the slug out of the URL. An operator who belongs to
        // two tenants must get two budgets: exhausting the co-op's journal
        // must not lock them out of their own farm's. If the wiring used
        // `token.tenantSlug` ('acme-corp' for this token) the globex request
        // would inherit the exhausted bucket and 429 immediately.
        getToken.mockResolvedValue(validToken({ memberships: BOTH_TENANTS }));

        const acmeLimited = await drive(MAX + 1, JOURNAL);
        expect(acmeLimited.status).toBe(429);

        const firstGlobex = await middleware(request(GLOBEX_JOURNAL), {} as any);
        expect(firstGlobex.status).toBe(200);
        expect(firstGlobex.headers.get('x-middleware-next')).toBe('1');

        const globexLimited = await drive(MAX, GLOBEX_JOURNAL);
        expect(globexLimited.status).toBe(429);
        expect(((await globexLimited.json()) as ReadLimitBody).error.scope).toBe('api-read');
    });
});

describe('ordering — the budget sits AFTER the tenant-access gate', () => {
    it('cross-tenant GETs 403 forever and never burn the target budget', async () => {
        // The BEHAVIOURAL half of what the guardrail asserts textually
        // (`src.indexOf('checkTenantAccess(') < src.indexOf('checkApiReadRateLimit(')`,
        // tests/guardrails/api-read-rate-limit.test.ts:163-175). If §5c were
        // hoisted above §5, an unauthorised caller could exhaust a tenant's
        // read budget from outside it — a denial of service against a farm
        // they have no membership in — and the 122nd request would come back
        // 429 instead of 403.
        getToken.mockResolvedValue(validToken()); // acme-corp only

        for (let i = 0; i < MAX + 1; i++) {
            const r = await middleware(request(GLOBEX_JOURNAL), {} as any);
            expect(r.status).toBe(403);
        }

        const last = await middleware(request(GLOBEX_JOURNAL), {} as any);
        expect(last.status).toBe(403);
        // The distinguishing reason: §5's cross-tenant arm, not §4's MFA 403,
        // not §3's admin 403, not the MECHANISATOR `operator_scope` 403.
        expect(((await last.json()) as { error: string }).error).toBe('cross_tenant_access_denied');

        // Prove the bucket the refused requests would have charged is still
        // untouched, by asking the limiter directly with the same key
        // components (ip 127.0.0.1, user usr_1, tenant globex).
        const probe = await checkApiReadRateLimit(request(GLOBEX_JOURNAL), 'usr_1', 'globex');
        expect(probe.ok).toBe(true);
    });

    it('unauthenticated traffic is refused at §2 and never charges a bucket', async () => {
        // Anonymous floods must not be able to pre-exhaust a real operator's
        // budget before the operator has even signed in.
        getToken.mockResolvedValue(null);

        for (let i = 0; i < MAX + 1; i++) {
            const r = await middleware(request(JOURNAL), {} as any);
            expect(r.status).toBe(401);
        }

        const last = await middleware(request(JOURNAL), {} as any);
        expect(last.status).toBe(401);
        expect(((await last.json()) as { error: string }).error).toBe('Unauthorized');

        const probe = await checkApiReadRateLimit(request(JOURNAL), 'usr_1', 'acme-corp');
        expect(probe.ok).toBe(true);
    });
});

describe('the tier is precise — it must not throttle traffic it does not own', () => {
    // What each of these four actually exercises is NOT uniform, and the
    // difference is worth stating so the next reader does not over-read this
    // block:
    //   - `/api/health`, `/api/livez`, `/api/readyz` are in
    //     PUBLIC_PATH_PREFIXES (guard.ts:21-23), so `authMiddleware` returns
    //     at :117 long before §5c. Their non-429 is guaranteed by the
    //     public-path gate, not by EXCLUDED_PATHS.
    //   - `/api/docs` is NOT public, so it does reach line 375 — and is
    //     refused by `pathname.startsWith('/api/t/')` (:70), again not by
    //     EXCLUDED_PATHS.
    //   Which means the EXCLUDED_PATHS loop (:77-81) is currently unreachable
    //   dead code: nothing can both start with `/api/t/` and equal
    //   `/api/health`. The value of these four cases is the END-TO-END claim
    //   CLAUDE.md makes — "operators must keep monitoring access during
    //   attacks" — not coverage of that loop.
    it.each(['/api/health', '/api/livez', '/api/readyz', '/api/docs'])(
        'operator probe %s is never throttled',
        async (probePath) => {
            getToken.mockResolvedValue(validToken());
            for (let i = 0; i < MAX + 1; i++) {
                const r = await middleware(request(probePath), {} as any);
                expect(r.status).not.toBe(429);
            }
        },
    );

    it('mutations on the same path are untouched — they have their own tier', async () => {
        // The read tier is GET-only (apiReadRateLimit.ts:69). POST/PUT/PATCH/
        // DELETE are budgeted by `withApiErrorHandling`'s mutation tier; if
        // the read tier also caught them a farm worker filing journal entries
        // would be double-charged.
        getToken.mockResolvedValue(validToken());
        for (let i = 0; i < MAX + 1; i++) {
            const r = await middleware(request(JOURNAL, 'POST'), {} as any);
            expect(r.status).not.toBe(429);
        }
    });

    it('map vector tiles are untouched — pan/zoom bursts must not tear the map', async () => {
        // `.pbf` skip at apiReadRateLimit.ts:76. Tiles are still auth'd and
        // tenant-scoped (§2 + §5 ran above), and browser/edge-cacheable, but
        // a single pan across a parcel map fires far more than 120 requests
        // a minute.
        getToken.mockResolvedValue(validToken());
        const tile = '/api/t/acme-corp/locations/loc_1/tiles/10/1/2.pbf';
        for (let i = 0; i < MAX + 1; i++) {
            const r = await middleware(request(tile), {} as any);
            expect(r.status).not.toBe(429);
        }
    });
});
