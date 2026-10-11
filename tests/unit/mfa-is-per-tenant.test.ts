/* eslint-disable @typescript-eslint/no-explicit-any -- mirrors the harness in
 * mfa-gate-enforced.test.ts, which disables the same rule for NextRequest and
 * getToken runtime contracts. */
/**
 * The second factor is owed per FARM, not per session.
 *
 * `mfaPending` was one boolean, and the sign-in path computed it against the
 * session's PRIMARY tenant (`src/auth.ts`: `const activeTenantId =
 * token.tenantId ?? null`). The policy is per farm. So a member of farm A
 * (MFA off, primary) and farm B (REQUIRED) carried "nothing owed" and reached
 * `/t/B/…` without B's factor — on the web as much as on a phone, since the
 * phone only changes the slug in the URL.
 *
 * Both gates read that one boolean and neither could tell the farms apart:
 * this middleware block, and `getTenantCtx`, which had no MFA check at all
 * (the only one lived in `getUserCtx`).
 *
 * The REDIRECT was already per-path — `segments.indexOf('t')` — so only the
 * DECISION was wrong. Worth stating because it is the half that looks right
 * when you read the block.
 *
 * Found by agrent-ios; zero live exposure when fixed (no farm had a policy
 * set), which is why it is a separate change rather than a scramble.
 */
import { NextRequest } from 'next/server';

// Spread the real modules. `mfa-gate-enforced.test.ts` replaces these
// barrels wholesale and gets away with it because every case it drives is HELD
// by the MFA gate and never reaches further into the middleware. This file has
// pass-through cases, which do — and a partial mock then throws
// `isApiReadRateLimited is not a function` from line 577, which presents as
// "the gate redirected" rather than as a broken fixture.
jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    ...jest.requireActual<Record<string, unknown>>('../../src/lib/rate-limit/authRateLimit'),
    authRateLimit: () => ({ allowed: true, remaining: 10, retryAfterSeconds: 0 }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    ...jest.requireActual<Record<string, unknown>>('../../src/lib/rate-limit/apiReadRateLimit'),
    checkApiReadRateLimit: async () => ({ allowed: true, remaining: 10, retryAfterSeconds: 0 }),
}));

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: any[]) => getToken(...a) }));

import middleware from '../../src/middleware';

/**
 * A member of TWO farms: `acme-corp` is primary and owes nothing, `globex`
 * requires a factor that has not been presented.
 *
 * `slug` and not `tenantSlug` inside `memberships` — the jwt callback builds
 * `{ slug, role, tenantId }`, and getting it wrong makes every tenant request
 * fail the tenant-ACCESS gate with its own 403, which is indistinguishable by
 * status from the MFA refusal this file is about.
 */
function twoFarmToken(overrides: Record<string, unknown> = {}) {
    return {
        userId: 'usr_1',
        sub: 'usr_1',
        tenantId: 'tnt_acme',
        tenantSlug: 'acme-corp',
        role: 'ADMIN',
        userSessionId: 'sess_1',
        memberships: [
            { tenantId: 'tnt_acme', slug: 'acme-corp', role: 'ADMIN' },
            { tenantId: 'tnt_globex', slug: 'globex', role: 'EDITOR' },
        ],
        // The primary farm owes nothing, which is what made the old boolean
        // false and the whole thing pass.
        mfaPending: true,
        mfaPendingTenantIds: ['tnt_globex'],
        ...overrides,
    };
}

const req = (pathname: string) =>
    new NextRequest(`http://localhost:3000${pathname}`, { method: 'GET' });

beforeEach(() => getToken.mockReset());

describe('a factor owed by one farm does not travel to another', () => {
    it('HOLDS a page request for the farm that owes one', async () => {
        getToken.mockResolvedValue(twoFarmToken());
        const res = await middleware(req('/t/globex/dashboard'), {} as any);
        expect([302, 307]).toContain(res.status);
        expect(res.headers.get('location')).toContain('/t/globex/auth/mfa');
    });

    it('HOLDS the farm that owes one even when the SESSION flag says otherwise', async () => {
        // THE regression test, and the only one that fails on the old code.
        //
        // `mfaPending: false` is exactly what the bug produced: the flag was
        // computed against the PRIMARY tenant, acme-corp, which owes nothing.
        // The old gate read that single boolean, so `/t/globex/…` sailed
        // through without globex's factor.
        //
        // The other cases in this file carry `mfaPending: true` and so are
        // held by the old code too, by accident — they prove the gate is
        // per-tenant, not that it closes the hole. This one is the difference,
        // and I did not have it until a mutation showed the others passing
        // with the fix reverted.
        getToken.mockResolvedValue(
            twoFarmToken({ mfaPending: false, mfaPendingTenantIds: ['tnt_globex'] }),
        );
        const res = await middleware(req('/t/globex/dashboard'), {} as any);
        expect([302, 307]).toContain(res.status);
        expect(res.headers.get('location')).toContain('/t/globex/auth/mfa');
    });

    it('and still lets the primary farm through in that same state', async () => {
        // The pair: holding globex must not cost acme-corp, or the fix is a
        // blanket hold wearing a per-tenant shape.
        getToken.mockResolvedValue(
            twoFarmToken({ mfaPending: false, mfaPendingTenantIds: ['tnt_globex'] }),
        );
        const res = await middleware(req('/t/acme-corp/dashboard'), {} as any);
        expect([302, 307]).not.toContain(res.status);
        expect(res.status).not.toBe(403);
    });

    it('HOLDS an API request for that farm, with the code', async () => {
        getToken.mockResolvedValue(twoFarmToken());
        const res = await middleware(req('/api/t/globex/tasks'), {} as any);
        expect(res.status).toBe(403);
        expect(JSON.stringify(await res.json())).toContain('MFA_REQUIRED');
    });

    it('LETS THROUGH the farm that owes nothing', async () => {
        // The half that makes this a per-tenant gate rather than a blanket
        // one. Without it, fixing the hole would hold every farm the moment
        // any farm enabled MFA.
        getToken.mockResolvedValue(twoFarmToken());
        const res = await middleware(req('/t/acme-corp/dashboard'), {} as any);
        expect([302, 307]).not.toContain(res.status);
        expect(res.status).not.toBe(403);
    });

    it('still HOLDS a person path, which has no farm to test', async () => {
        // No slug, so nothing to look up: a factor owed anywhere holds it.
        // That is the session a stolen first factor produces, and somebody's
        // own account is what it is most useful against (P1.6).
        getToken.mockResolvedValue(twoFarmToken());
        const res = await middleware(req('/api/me/farms'), {} as any);
        expect(res.status).toBe(403);
    });
});

describe('the gate holds when it cannot see the whole picture', () => {
    it('falls back to the session-wide flag when memberships are TRUNCATED', async () => {
        // `MAX_JWT_MEMBERSHIPS` is 50, so a user in more farms than that has
        // an incomplete list — and a missing tenant must not read as "nothing
        // owed". The conservative answer is to hold.
        getToken.mockResolvedValue(
            twoFarmToken({
                membershipsTruncated: true,
                // The list says this farm is fine; truncation says the list
                // cannot be trusted to be complete.
                mfaPendingTenantIds: [],
                mfaPending: true,
            }),
        );
        const res = await middleware(req('/t/acme-corp/dashboard'), {} as any);
        expect([302, 307]).toContain(res.status);
    });

    it('falls back for a session minted before the claim existed', async () => {
        // An old cookie has no list at all. It keeps the primary-tenant
        // behaviour it already had rather than being released.
        const { mfaPendingTenantIds, ...legacy } = twoFarmToken();
        void mfaPendingTenantIds;
        getToken.mockResolvedValue(legacy);
        const res = await middleware(req('/t/globex/dashboard'), {} as any);
        expect([302, 307]).toContain(res.status);
    });

    it('falls back when the path slug is not in memberships', async () => {
        // An unmappable slug is the same situation as a truncated list: the
        // tenant-access gate will refuse it anyway, but this block must not be
        // the one that lets it past.
        getToken.mockResolvedValue(twoFarmToken());
        const res = await middleware(req('/t/unknown-farm/dashboard'), {} as any);
        expect(res.status).not.toBe(200);
    });
});

describe('the challenge page stays reachable', () => {
    it('does not redirect the challenge page itself', async () => {
        // Otherwise the hold is a loop.
        getToken.mockResolvedValue(twoFarmToken());
        const res = await middleware(req('/t/globex/auth/mfa'), {} as any);
        expect([302, 307]).not.toContain(res.status);
    });

    it('does not redirect the enrolment page', async () => {
        getToken.mockResolvedValue(twoFarmToken());
        const res = await middleware(req('/t/globex/security/mfa'), {} as any);
        expect([302, 307]).not.toContain(res.status);
    });
});
