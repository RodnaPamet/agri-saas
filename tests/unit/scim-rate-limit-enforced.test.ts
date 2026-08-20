/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these surfaces (see tests/unit/cors.test.ts). */

/**
 * The SCIM tier must REFUSE A REQUEST at the Edge — not merely compute a budget.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `src/middleware.ts:113-116` is the ONLY place in `src/` where this tier ever
 * returns a 429 to a caller:
 *
 *     if (isScimRateLimited(pathname)) {
 *         const rl = await checkScimRateLimit(req);
 *         if (!rl.ok && rl.response) return rl.response;   // ← line 115
 *     }
 *
 * Nothing in the suite crossed it. Three files look like they cover this and
 * none of them do:
 *
 *   - `tests/unit/scim-rate-limit.test.ts` calls `checkScimRateLimit(req)`
 *     DIRECTLY. It proves the limiter counts; it cannot observe whether the
 *     middleware acts on the result.
 *   - `tests/unit/scim-edge-reachability.test.ts` drives the real middleware
 *     but makes ~9 requests against a 300/600 budget — it can never trip.
 *   - `tests/unit/webhook-edge-reachability.test.ts` asserts the PREDICATE
 *     `isScimRateLimited(pathname) === true` and stops there.
 *
 * And there is no guard backstop: nothing under `tests/` greps
 * `src/middleware.ts` for `checkScimRateLimit`. Delete line 115 — keeping the
 * counters, dropping the enforcement — and all three suites stay green.
 *
 * WHY IT MATTERS HERE. `/api/scim/`, the signed-webhook prefixes
 * (`/api/stripe/webhook`, `/api/storage/av-webhook`,
 * `/api/integrations/webhooks/`) and the platform-admin routes
 * (`/api/admin/tenants`, …) sit in `PUBLIC_PATH_PREFIXES` on purpose: their
 * credentials are an opaque bearer hashed in the database, a Stripe
 * signature, an HMAC over the raw body, a constant-time admin key — none of
 * which `getToken()` can verify and none of which the Edge has a database to
 * check. So these are the surfaces where an ANONYMOUS caller from the open
 * internet reaches a credential comparison. A SCIM bearer provisions and
 * de-provisions the whole membership of a tenant — the agronomists and field
 * workers whose actions the hash-chained audit trail attributes in the logs a
 * БАБХ inspection reads back. Unbudgeted, that comparison is a brute-force
 * oracle, and every failed attempt also writes a warn log from a handler.
 *
 * The per-IP half is the one carrying the security claim. A per-bearer budget
 * is the obvious design and it is useless against the attack it looks like it
 * stops: a caller who rotates a fresh guess every request gets a fresh
 * per-bearer bucket every request and is never limited. Only
 * `SCIM_IP_LIMIT` binds — and it is deliberately double the per-bearer budget
 * because several tenants' Entra syncs egress from one shared Microsoft IP
 * pool, so the ceiling has to fit more than one honest sync at a time. §3
 * below is therefore the assertion this file exists for; §2 alone describes a
 * limiter an attacker walks straight past.
 *
 * WHAT THIS FILE CATCHES. Deleting the whole block at L113-116, or the
 * narrower and far likelier regression of deleting only line 115. Under
 * either, §2 §3 §4 §5 §6 fail with `Expected: 429, Received: 200`, while the
 * two control blocks (§1 and §7) stay green — which is exactly what a control
 * is for.
 *
 * THREE WAYS THIS FILE COULD GO VACUOUSLY GREEN, all defended against below:
 *   - `NEXT_TEST_MODE=1` / `AUTH_TEST_MODE=1` / `RATE_LIMIT_ENABLED=0` each
 *     short-circuit `isBypassed()` (scimRateLimit.ts:182-187). With any of
 *     them set, hundreds of rotating-bearer requests all return 200 and
 *     nothing ever 429s. `process.env` leaks between test FILES in a jest
 *     worker, so §0 asserts at run time that none of them is set.
 *   - `method: 'OPTIONS'` never reaches line 113 — the CORS preflight at
 *     `src/middleware.ts:442` answers 204 unconditionally. Every request here
 *     is a GET.
 *   - A request with no `x-forwarded-for` is keyed to the literal
 *     `'127.0.0.1'` (scimRateLimit.ts:124), silently sharing one 600/min
 *     bucket with every other IP-less request in the worker. `scimReq()`
 *     always sets it.
 */
import { NextRequest } from 'next/server';

// Stub ONLY the async budget checks of the OTHER two tiers, so a 429 in this
// file can only have come from the SCIM tier. `isApiReadRateLimited` and
// `extractTenantSlug` are pure path/method predicates that decide WHICH stage
// a request reaches, so replacing them would change the control flow this
// file is trying to observe — and a bare object literal silently yields
// `undefined` for every export it omits, which surfaces as "is not a
// function" the moment a request gets far enough down the middleware to call
// one (here: the authed-tenant control in §7). Spreading requireActual keeps
// them real.
jest.mock('@/lib/rate-limit/authRateLimit', () => ({
    ...jest.requireActual('@/lib/rate-limit/authRateLimit'),
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('@/lib/rate-limit/apiReadRateLimit', () => ({
    ...jest.requireActual('@/lib/rate-limit/apiReadRateLimit'),
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOT mocked, deliberately: `@/lib/rate-limit/scimRateLimit` (the subject),
// `@/lib/security/rate-limit` (the real budgets), `@/lib/auth/guard` (whether
// the branch is reachable at all), and the CSP / header / CORS modules (what
// proves the 429 survives the outer post-processing at L508-527 intact).
const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: any[]) => getToken(...a) }));

import middleware from '@/middleware';
import { _clearScimRateLimitMemory } from '@/lib/rate-limit/scimRateLimit';
import { SCIM_LIMIT, SCIM_IP_LIMIT } from '@/lib/security/rate-limit';

// `@/env` is remapped by jest to `tests/mocks/env.ts`, which is a live Proxy
// over `process.env` — it reads at ACCESS time, not import time, so these
// writes take effect whenever they happen. They are repeated in `beforeEach`
// because `_clearScimRateLimitMemory()` also resets the module's `_initialized`
// latch, so `RATE_LIMIT_MODE` has to be right at the start of every test.
const ENV_SNAPSHOT: Record<string, string | undefined> = {
    RATE_LIMIT_MODE: process.env.RATE_LIMIT_MODE,
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
    AUTH_TEST_MODE: process.env.AUTH_TEST_MODE,
    NEXT_TEST_MODE: process.env.NEXT_TEST_MODE,
};

function pinEnv(): void {
    process.env.RATE_LIMIT_MODE = 'memory'; // never build a real Upstash client
    delete process.env.RATE_LIMIT_ENABLED; // Proxy default '1' ⇒ enforced
    process.env.AUTH_TEST_MODE = '0'; // scimRateLimit.ts:184
    delete process.env.NEXT_TEST_MODE; // scimRateLimit.ts:185 (read off process.env directly)
}

pinEnv();

/**
 * A single, explicit client IP.
 *
 * Without `x-forwarded-for`, `getClientIp` falls back to `x-real-ip` and then
 * to the literal `'127.0.0.1'` — so every IP-less request in the worker would
 * share one bucket and the per-bearer test would start tripping the IP
 * ceiling on a neighbouring test's traffic.
 */
const IP = '203.0.113.7';

/** A SCIM-tier request. GET, never OPTIONS — see the docblock. */
function scimReq(bearer: string, pathname = '/api/scim/v2/Users', ip = IP) {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method: 'GET',
        headers: {
            authorization: `Bearer ${bearer}`, // hashed into the per-bearer key
            'x-forwarded-for': ip, // the per-IP key
        },
    });
}

/** A plain request with no bearer — for the controls and the scope check. */
function plainReq(pathname: string, ip?: string) {
    return new NextRequest(`http://localhost:3000${pathname}`, {
        method: 'GET',
        ...(ip ? { headers: { 'x-forwarded-for': ip } } : {}),
    });
}

/**
 * A token that is valid in every respect.
 *
 * Only §7 needs one: the gate under test sits at L113, INSIDE the
 * `isPublicPath` early-return and BEFORE the `getToken()` call at L123, so no
 * token of any shape can help reach it or break it.
 */
function validToken(overrides: Record<string, unknown> = {}) {
    return {
        userId: 'usr_1',
        sub: 'usr_1',
        tenantId: 'tnt_1',
        tenantSlug: 'acme-corp',
        role: 'ADMIN',
        userSessionId: 'sess_1',
        // `slug`, NOT `tenantSlug`. The jwt callback builds
        // `{ slug, role, tenantId }` (src/auth.ts:209-215) and
        // `checkTenantAccess` scans `m.slug` (guard.ts:326). With the wrong
        // key this control returns 403 `cross_tenant_access_denied` instead
        // of 200 and quietly stops proving anything.
        memberships: [{ tenantId: 'tnt_1', slug: 'acme-corp', role: 'ADMIN' }],
        // No `error`, no `mfaPending` — either one refuses the control
        // upstream of the point it is meant to demonstrate.
        ...overrides,
    };
}

/**
 * Exhaust the per-IP ceiling from `IP` with a fresh bearer each request, and
 * PROVE it is exhausted before the caller asserts anything about the paths
 * that follow.
 *
 * The proof is not ceremony. Without it, §5 ("/login is not budgeted") and §6
 * ("webhooks share the tier") would both pass against a middleware that had
 * stopped enforcing altogether — the whole point of §5 is that /login is 200
 * *while the ceiling is blown*, which is a claim about two things at once.
 */
async function exhaustIpCeilingFromIp(): Promise<void> {
    for (let i = 0; i < SCIM_IP_LIMIT.maxAttempts; i++) {
        await middleware(scimReq(`scim_fill_${i}`), {} as any);
    }
    const proof = await middleware(scimReq('scim_fill_proof'), {} as any);
    expect(proof.status).toBe(429);
    expect(proof.headers.get('X-RateLimit-Limit')).toBe(String(SCIM_IP_LIMIT.maxAttempts));
}

beforeEach(() => {
    pinEnv();
    // `_memoryCache` is module-scoped and survives between `it()` blocks; both
    // buckets increment on EVERY call, so without this the per-bearer test
    // would inherit the per-IP test's 600 and block for the wrong reason.
    _clearScimRateLimitMemory();
    getToken.mockReset();
    // What production actually does with an opaque `scim_` bearer: `getToken`
    // cannot verify it and returns null. It is never called on a public path
    // anyway — this is determinism, not a precondition.
    getToken.mockResolvedValue(null);
});

afterAll(() => {
    // Do not become the file that breaks the next one in this jest worker.
    for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

describe('§0 — this run actually enforces (the bypasses are OFF)', () => {
    it('no bypass env var is set, so the assertions below can fail', () => {
        // Each of these makes every other block in this file vacuously green,
        // silently. `process.env` leaks across test FILES inside a worker
        // (tests/unit/api-read-rate-limit.test.ts sets AUTH_TEST_MODE='1'),
        // so assert it at run time rather than trusting the preamble.
        expect(process.env.NEXT_TEST_MODE).not.toBe('1');
        expect(process.env.AUTH_TEST_MODE).not.toBe('1');
        expect(process.env.RATE_LIMIT_ENABLED).not.toBe('0');
        expect(process.env.RATE_LIMIT_MODE).toBe('memory');
    });

    it('the two budgets are DISTINCT, so the header can identify which bucket blocked', () => {
        // If a policy change ever set them equal, §2 and §3 would both still
        // pass while the per-bearer/per-IP distinction the two buckets exist
        // for had been destroyed. `X-RateLimit-Limit` is only a discriminator
        // while these differ.
        expect(SCIM_IP_LIMIT.maxAttempts).not.toBe(SCIM_LIMIT.maxAttempts);
        expect(SCIM_LIMIT.maxAttempts).toBe(300);
        expect(SCIM_IP_LIMIT.maxAttempts).toBe(600);
    });
});

describe('§1 — POSITIVE CONTROL: a SCIM request reaches the branch and passes through', () => {
    it('an untouched budget lets the request through as a pass-through, not a refusal', async () => {
        // The control the whole file rests on. It proves (a) the matcher and
        // `isPublicPath` let the request in, so line 113 was actually
        // evaluated, and (b) the request was NOT stopped by the CORS
        // preflight at L442 or the `getToken()` 401 at L128-130. Without it,
        // a middleware that 401'd every SCIM request would satisfy every
        // "status is not 200" assertion below while protecting nothing.
        const res = await middleware(scimReq('scim_a'), {} as any);

        expect(res.status).toBe(200);
        expect(res.headers.get('x-middleware-next')).toBe('1'); // L117 pass-through
    });
});

describe('§2 — the per-BEARER budget is enforced through the middleware', () => {
    it(`allows ${SCIM_LIMIT.maxAttempts} and refuses the next one with SCIM_LIMIT's headers`, async () => {
        for (let i = 0; i < SCIM_LIMIT.maxAttempts; i++) {
            const ok = await middleware(scimReq('scim_a'), {} as any);
            expect(ok.status).toBe(200);
        }

        const blocked = await middleware(scimReq('scim_a'), {} as any);

        expect(blocked.status).toBe(429);
        // The DISTINGUISHING signal. A bare 429 on some other path could come
        // from the auth tier (L458) or the read tier (L378); `300` names
        // SCIM_LIMIT specifically — not the read tier (120), not the auth
        // tier (10/30/60), not the mutation tier (60).
        expect(blocked.headers.get('X-RateLimit-Limit')).toBe('300');
        expect(blocked.headers.get('X-RateLimit-Limit')).toBe(String(SCIM_LIMIT.maxAttempts));
        // The inverse of §1: a refusal carries no pass-through marker.
        expect(blocked.headers.get('x-middleware-next')).toBeNull();
    });
});

describe('§3 — the per-IP ceiling is enforced, WITH A FRESH BEARER EVERY REQUEST', () => {
    it(`refuses request ${SCIM_IP_LIMIT.maxAttempts + 1} from one IP even though every bearer is new`, async () => {
        // THE assertion this file exists for. Every per-bearer bucket here
        // holds a count of 1, so `tokenBucket.ok` is true throughout and the
        // reported bucket resolves to the IP one (scimRateLimit.ts:247) — the
        // `600` in the header is what proves the ceiling did the work rather
        // than the per-bearer budget. §2 on its own describes a limiter a
        // guessing attacker never touches.
        let blockedAt = -1;
        let blocked: Response | null = null;

        for (let i = 0; i < SCIM_IP_LIMIT.maxAttempts + 5; i++) {
            const r = await middleware(scimReq(`scim_guess_${i}`), {} as any);
            if (r.status === 429) {
                blockedAt = i;
                blocked = r;
                break;
            }
        }

        expect(blockedAt).toBe(SCIM_IP_LIMIT.maxAttempts); // index 600 ⇒ the 601st request
        expect(blocked).not.toBeNull();
        expect(blocked!.headers.get('X-RateLimit-Limit')).toBe('600');
        expect(blocked!.headers.get('X-RateLimit-Limit')).toBe(String(SCIM_IP_LIMIT.maxAttempts));
        expect(blocked!.headers.get('x-middleware-next')).toBeNull();
    });
});

describe('§4 — the refusal reaches the caller as a well-formed, non-leaking 429', () => {
    it('carries the SCIM-tier body and honest Retry-After / X-RateLimit-* headers', async () => {
        const bearer = 'scim_super_secret_value';
        for (let i = 0; i < SCIM_LIMIT.maxAttempts; i++) {
            await middleware(scimReq(bearer), {} as any);
        }
        const blocked = await middleware(scimReq(bearer), {} as any);
        expect(blocked.status).toBe(429);

        // Read the body ONCE — a Response body is single-use.
        const raw = await blocked.text();

        // The flat string body is itself distinguishing: the read tier answers
        // `{ error: { code: 'RATE_LIMITED', scope: 'api-read', … } }` and the
        // auth tier `{ error: 'RATE_LIMITED', retryAfterSeconds: n }`.
        expect(JSON.parse(raw)).toEqual({ error: 'Too many requests' });

        // A 429 is served to whoever asked, attacker included. It must not
        // confirm anything about what they sent — and the bearer is a live
        // provisioning credential for a whole tenant's membership.
        expect(raw).not.toContain(bearer);
        expect(raw).not.toContain(IP);

        // `Math.ceil((resetAt - now) / 1000)` — bounded, never equality: the
        // same 60s window measures as 59 or 60 depending on the clock.
        const retryAfter = Number(blocked.headers.get('Retry-After'));
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(SCIM_LIMIT.windowMs / 1000);

        expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0');
        // Unix SECONDS here (`Math.ceil(blocking.reset / 1000)`), unlike the
        // auth tier which emits milliseconds — a copied assertion from those
        // tests would be wrong by a factor of 1000.
        expect(Number(blocked.headers.get('X-RateLimit-Reset'))).toBeGreaterThan(
            Math.floor(Date.now() / 1000),
        );

        // The refusal is returned from `authMiddleware` and then survives the
        // outer post-processing at L508-527 with the observability stamp
        // intact — an operator can still correlate a throttled sync to a log.
        expect(blocked.headers.get('x-request-id')).toBeTruthy();
    });
});

describe('§5 — the tier is not wider than the public carve-out it defends', () => {
    it('a non-SCIM public path from the SAME exhausted IP is still served', async () => {
        // POSITIVE CONTROL inside the helper: it asserts the ceiling really is
        // blown before this test claims anything about /login. Guards against
        // a "simplification" that drops the `isScimRateLimited(pathname)`
        // guard at L113 and budgets every public path — which §2 and §3 alone
        // would not notice, and which would lock a farm operator out of the
        // login page because a webhook sender shares their NAT egress.
        await exhaustIpCeilingFromIp();

        const login = await middleware(plainReq('/login', IP), {} as any);

        expect(login.status).not.toBe(429);
        expect(login.status).toBe(200);
        expect(login.headers.get('x-middleware-next')).toBe('1');
    });
});

describe('§6 — the signed-webhook prefixes really share this tier at the middleware', () => {
    it('a webhook path from the exhausted IP is refused by the SAME per-IP ceiling', async () => {
        // `webhook-edge-reachability.test.ts` asserts the PREDICATE
        // `isScimRateLimited('/api/stripe/webhook') === true`. Nothing until
        // now drove a webhook path through the real middleware into a
        // refusal, so the predicate could be true while the wiring was gone.
        await exhaustIpCeilingFromIp();

        const webhook = await middleware(scimReq('x', '/api/stripe/webhook'), {} as any);

        expect(webhook.status).toBe(429);
        expect(webhook.headers.get('X-RateLimit-Limit')).toBe('600');
        expect(await webhook.text()).toBe(JSON.stringify({ error: 'Too many requests' }));
    });
});

describe('§7 — SECOND POSITIVE CONTROL: the harness still discriminates', () => {
    it('an authed tenant request is served, and the same request unauthenticated is refused', async () => {
        // The 200 proves the forged token carries the right membership key
        // shape (a `tenantSlug` typo yields 403 `cross_tenant_access_denied`)
        // and that the request traversed every gate below the public-path
        // early return — token verification, the `token.error` check, the
        // admin gate, the MFA gate, the tenant-access gate, the read tier.
        getToken.mockResolvedValue(validToken());
        const authed = await middleware(plainReq('/api/t/acme-corp/tasks'), {} as any);
        expect(authed.status).toBe(200);
        expect(authed.headers.get('x-middleware-next')).toBe('1');

        // The 401 proves the middleware still refuses things — which is what
        // makes §1's 200 mean "allowed" rather than "the harness cannot
        // refuse". The reason string pins WHICH gate: a bare 401 assertion
        // would also pass for a middleware that had collapsed to a wall.
        getToken.mockResolvedValue(null);
        const anon = await middleware(plainReq('/api/t/acme-corp/tasks'), {} as any);
        expect(anon.status).toBe(401);
        expect(await anon.json()).toEqual({ error: 'Unauthorized' });
    });
});
