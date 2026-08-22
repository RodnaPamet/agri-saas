/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts; the codebase's standard file-level disable. */
/**
 * The tenant-gate WIRING branches — the ones two docblocks claimed E2E covered.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `checkTenantAccess()` is a pure function with thorough tests. What it returns
 * is then wired to `NextResponse` in `src/middleware.ts:288-305`, and until this
 * file **that wiring was never executed**. Branch coverage of `src/middleware.ts`
 * across the thirteen suites that import the real export measured **90.47%**,
 * with lines `235`, `288-294` and `304` uncovered.
 *
 * Two docblocks asserted those branches were covered by the E2E suite:
 *
 *   src/lib/auth/guard.ts                          "E2E covers those"
 *   tests/integration/middleware-tenant-gate.test.ts  "exercised by the E2E suite"
 *
 * Both were false — `grep -rn "no_tenant_access" tests/e2e/` returns nothing,
 * and always did. #687 corrected the sentences; this file makes them true by
 * providing the coverage they promised. The 2026-08-19 enforcement-seam audit
 * named those docblocks as a principal reason fifteen unenforced seams went
 * unnoticed, and this is the last of them.
 *
 * ── Why the API and PAGE halves are separate assertions ──
 *
 * Each verdict forks on `isApiRoute(pathname)`: an API caller gets a
 * machine-readable 403 body, a browser gets a redirect to `/no-tenant`. Testing
 * only one leaves the other free to be deleted — and they fail differently for
 * the operator: a 403 the SWR layer can render as an error, versus a page that
 * silently lands somewhere else.
 *
 * ── Why the BODY is asserted, not just the status ──
 *
 * `no_tenant_access` and `cross_tenant` both answer 403 on an API route. A test
 * that asserted only the status would pass with the two branches swapped, or
 * with one deleted so both fell through to the other. The discriminator is the
 * `error` string, so that is what is checked.
 */
import { NextRequest } from 'next/server';

// Rate limiters are partially mocked exactly as the canonical fixture does:
// spreading requireActual keeps the pure predicates real, because a bare object
// drops the ones the middleware calls further down.
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

/**
 * `slug`, NOT `tenantSlug` — the jwt callback builds `{ slug, role, tenantId }`
 * (src/auth.ts) and `checkTenantAccess` scans `m.slug`. The canonical fixture
 * carries a long comment about this because using the wrong key silently 403s
 * every tenant path, which once made a whole suite assert against the wrong
 * refusal.
 */
function token(overrides: Record<string, unknown> = {}) {
    return {
        userId: 'usr_1',
        sub: 'usr_1',
        tenantId: 'tnt_1',
        role: 'ADMIN',
        userSessionId: 'sess_1',
        memberships: [{ tenantId: 'tnt_1', slug: 'acme-corp', role: 'ADMIN' }],
        ...overrides,
    };
}

const req = (pathname: string) =>
    new NextRequest(`http://localhost:3000${pathname}`, { method: 'GET' });

beforeEach(() => jest.clearAllMocks());

describe('no_tenant_access — an authed user with NO memberships at all', () => {
    // guard.ts: "authed user has no tenant memberships at all".
    const noMemberships = () => getToken.mockResolvedValue(token({ memberships: [] }));

    it('answers a machine-readable 403 on an API route', async () => {
        noMemberships();
        const res = await middleware(req('/api/t/acme-corp/tasks'));

        expect(res?.status).toBe(403);
        // The BODY is the discriminator — cross_tenant is also a 403.
        await expect(res?.clone().json()).resolves.toEqual({ error: 'no_tenant_access' });
    });

    it('redirects a PAGE to /no-tenant rather than 403ing a browser', async () => {
        noMemberships();
        const res = await middleware(req('/t/acme-corp/journal'));

        expect(res?.status).toBe(307);
        expect(res?.headers.get('location')).toBe('http://localhost:3000/no-tenant');
    });
});

describe('cross_tenant — the URL slug is not among the memberships', () => {
    // guard.ts: "the URL slug is not in any of the user's memberships". The user
    // IS a member of something, which is what separates this from the above.
    const wrongSlug = () => getToken.mockResolvedValue(token());

    it('answers a DIFFERENT 403 body on an API route', async () => {
        wrongSlug();
        const res = await middleware(req('/api/t/someone-elses-farm/tasks'));

        expect(res?.status).toBe(403);
        await expect(res?.clone().json()).resolves.toEqual({
            error: 'cross_tenant_access_denied',
        });
    });

    it('redirects a PAGE to /no-tenant', async () => {
        wrongSlug();
        const res = await middleware(req('/t/someone-elses-farm/journal'));

        expect(res?.status).toBe(307);
        expect(res?.headers.get('location')).toBe('http://localhost:3000/no-tenant');
    });
});

describe('the two verdicts are not interchangeable', () => {
    it('distinguishes "no memberships" from "wrong slug" on the same path shape', async () => {
        // The assertion that a swap or a fall-through would fail. Both are 403
        // on the same URL shape; only the body says which gate fired, and an
        // operator debugging a support ticket needs that difference.
        getToken.mockResolvedValue(token({ memberships: [] }));
        const none = await middleware(req('/api/t/acme-corp/tasks'));

        getToken.mockResolvedValue(token());
        const wrong = await middleware(req('/api/t/other-farm/tasks'));

        const [a, b] = await Promise.all([none?.clone().json(), wrong?.clone().json()]);
        expect(a).not.toEqual(b);
        expect(a.error).toBe('no_tenant_access');
        expect(b.error).toBe('cross_tenant_access_denied');
    });
});

describe('membershipsTruncated defers instead of denying', () => {
    it('ALLOWS an unknown slug when the JWT membership list was capped', async () => {
        // The bounded-JWT contract: over MAX_JWT_MEMBERSHIPS the list is a
        // fast-path, not the source of truth, so a slug-miss must defer to the
        // DB-backed server gate rather than deny. Deleting this branch would
        // lock every user in more than 50 tenants out of the ones that did not
        // fit — a population no fixture would otherwise cover.
        getToken.mockResolvedValue(token({ membershipsTruncated: true }));

        const res = await middleware(req('/api/t/tenant-51/tasks'));

        expect(res?.status).not.toBe(403);
    });
});

describe('admin PAGE denial proceeds instead of redirecting — deliberately', () => {
    it('returns next() for a non-admin on an admin PAGE, not a redirect', async () => {
        // The comment at src/middleware.ts:231-234 explains why: redirecting an
        // HTML request back to the browser's currently active URL crashed the
        // Next dev server's Edge Runtime. So the request proceeds and the
        // Server Component guard in admin/layout.tsx renders <ForbiddenPage>.
        //
        // This is the branch most likely to be "tidied" into a redirect by
        // someone who sees an authorization check that does not deny — which
        // would reintroduce the crash. Pinned as intentional.
        getToken.mockResolvedValue(token({ role: 'EDITOR' }));

        const res = await middleware(req('/t/acme-corp/admin/members'));

        expect(res?.status).toBe(200);
        expect(res?.headers.get('location')).toBeNull();
    });

    it('but an admin API path for the same role IS refused outright', async () => {
        // The positive control. Without it, a middleware that had stopped
        // checking admin paths at all would satisfy the assertion above.
        getToken.mockResolvedValue(token({ role: 'EDITOR' }));

        const res = await middleware(req('/api/t/acme-corp/admin/members'));

        expect(res?.status).toBe(403);
    });
});
