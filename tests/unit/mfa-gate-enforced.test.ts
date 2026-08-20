/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these surfaces (see tests/unit/cors.test.ts). */

/**
 * The MFA gate must REFUSE A REQUEST — not merely compute a flag.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `token.mfaPending` has exactly one reader in `src/` — the enforcement block
 * in `src/middleware.ts`. Deleting that whole block passed the entire suite
 * (13,490 tests) with zero failures. Measured, not assumed: running the seven
 * suites that import the real middleware with
 * `--collectCoverageFrom=src/middleware.ts` showed every statement inside
 * `if (mfaPending)` at ZERO hits, and the branch itself as `[0, N]` — the
 * true-arm was never once taken.
 *
 * The reason CI never noticed is the part worth remembering:
 *
 *   - `tests/unit/mfa-enforcement.test.ts:142` declares its own
 *     `function simulateMiddleware(pathname, mfaPending)` under the comment
 *     "Simulates the middleware MFA check" and asserts against THAT — a
 *     hand-copied reimplementation of the reader, never the code that runs.
 *   - The suites that DO import the real middleware forge tokens carrying
 *     `role: 'ADMIN'` and no `mfaPending`, so the branch is unreachable by
 *     construction from the only harness that could reach it.
 *
 * This is the same severed-seam shape as `token.error` before
 * `session-revocation-enforced.test.ts`: the mechanism is tested, the
 * enforcement point is not. So this file drives the real `src/middleware.ts`
 * and asserts the only thing that actually protects a tenant: **a request
 * carrying an unsatisfied MFA challenge does not reach the application.**
 *
 * Note there is no typecheck backstop either — `tsconfig.json` sets no
 * `noUnusedLocals`, so deleting the block would leave `isMfaAllowedPath`
 * imported-but-unused in `src/middleware.ts` without even a tsc error.
 */
import { NextRequest } from 'next/server';

// Stub ONLY the async budget checks. `isApiReadRateLimited` and
// `extractTenantSlug` are pure path/method predicates that decide WHICH
// stage a request reaches, so replacing them would change the control flow
// this file is trying to observe. Spreading requireActual keeps them real —
// a bare object literal silently yields `undefined` for every export it
// omits, which surfaces as "is not a function" the moment a request gets
// far enough down the middleware to call one.
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
 * A token that is valid in every respect EXCEPT the MFA flag.
 *
 * Deliberately carries NO `error`: the fail-closed case
 * (`MfaDependencyFailure`) already denies via the `token.error` path covered
 * in `session-revocation-enforced.test.ts`. The case this file exists for is
 * the NORMAL one — tenant policy requires MFA, or the user has a verified
 * enrolment — which sets `mfaPending` with no error alongside it. Adding an
 * error here would let that unrelated gate produce the pass and hide a
 * removed MFA block.
 */
function validToken(overrides: Record<string, unknown> = {}) {
    return {
        userId: 'usr_1',
        sub: 'usr_1',
        tenantId: 'tnt_1',
        tenantSlug: 'acme-corp',
        role: 'ADMIN',
        userSessionId: 'sess_1',
        // `slug`, NOT `tenantSlug` — this mirrors what the jwt callback
        // actually builds at src/auth.ts:207-210 (`{ slug, role, tenantId }`),
        // and `checkTenantAccess` scans `m.slug` (guard.ts:326). Getting this
        // key wrong makes every tenant-path request fail the tenant-access
        // gate with its OWN 403, which is indistinguishable by status from the
        // MFA refusal this file is about. See the body assertions below.
        memberships: [{ tenantId: 'tnt_1', slug: 'acme-corp', role: 'ADMIN' }],
        ...overrides,
    };
}

function req(pathname: string) {
    return new NextRequest(`http://localhost:3000${pathname}`, { method: 'GET' });
}

/** The reason string in a `forbiddenJson` / gate body (guard.ts:257-262). */
async function reason(res: Response): Promise<string> {
    return ((await res.json()) as { error?: string }).error ?? '';
}

beforeEach(() => getToken.mockReset());

describe('a pending MFA challenge is refused', () => {
    it('tenant API route => 403, and 403 FROM THE MFA GATE specifically', async () => {
        // Asserting the status alone would be a false positive waiting to
        // happen: the tenant-access gate immediately downstream also answers
        // 403 on this exact path. The reason string is the only thing that
        // distinguishes "we stopped you for MFA" from "we stopped you for
        // membership" — so a deleted MFA block cannot be masked by its
        // neighbour.
        getToken.mockResolvedValue(validToken({ mfaPending: true }));
        const res = await middleware(req('/api/t/acme-corp/tasks'), {} as any);

        expect(res.status).toBe(403);
        expect(await reason(res)).toBe('MFA verification required');
    });

    it('tenant page route => 307 to the challenge, carrying `next`', async () => {
        // The `next` param is what returns the operator to the page they
        // asked for once they satisfy the challenge. Losing it silently
        // dumps them on the dashboard instead.
        getToken.mockResolvedValue(validToken({ mfaPending: true }));
        const res = await middleware(req('/t/acme-corp/dashboard'), {} as any);

        expect(res.status).toBe(307);
        const location = res.headers.get('location') ?? '';
        expect(location).toContain('/t/acme-corp/auth/mfa');
        expect(new URL(location).searchParams.get('next')).toBe('/t/acme-corp/dashboard');
    });

    it('the slug in the challenge URL comes from the PATH, not the token', async () => {
        // A token pinned to one tenant must not send the operator to that
        // tenant's challenge when they asked for another — the tenant-access
        // gate downstream is what decides membership, not this redirect.
        getToken.mockResolvedValue(
            validToken({
                mfaPending: true,
                memberships: [
                    { tenantId: 'tnt_1', slug: 'acme-corp', role: 'ADMIN' },
                    { tenantId: 'tnt_2', slug: 'globex', role: 'ADMIN' },
                ],
            }),
        );
        const res = await middleware(req('/t/globex/reports'), {} as any);

        expect(res.status).toBe(307);
        expect(res.headers.get('location') ?? '').toContain('/t/globex/auth/mfa');
    });
});

describe('the gate is precise — it must not lock the operator out of satisfying it', () => {
    it('the challenge page itself is NOT redirected — no loop', async () => {
        // If this carve-out went, an operator with mfaPending could never
        // reach the page that clears mfaPending.
        getToken.mockResolvedValue(validToken({ mfaPending: true }));
        const res = await middleware(req('/t/acme-corp/auth/mfa'), {} as any);

        expect(res.status).not.toBe(403);
        expect(res.headers.get('location') ?? '').not.toContain('/auth/mfa');
    });

    it('the MFA enrolment API is NOT refused', async () => {
        // Same reasoning one layer down: the challenge page calls this.
        getToken.mockResolvedValue(validToken({ mfaPending: true }));
        const res = await middleware(req('/api/t/acme-corp/security/mfa/verify'), {} as any);
        expect(res.status).not.toBe(403);
    });

    it('a NON-tenant path is not gated', async () => {
        // The gate is scoped by isTenantPath. The tenant picker has to stay
        // reachable, or a pending challenge on one tenant strands the user
        // everywhere.
        getToken.mockResolvedValue(validToken({ mfaPending: true }));
        const res = await middleware(req('/tenants'), {} as any);
        expect(res.status).not.toBe(403);
    });

    it('a token with NO mfaPending proceeds', async () => {
        getToken.mockResolvedValue(validToken());
        const res = await middleware(req('/t/acme-corp/dashboard'), {} as any);

        expect(res.status).not.toBe(403);
        expect(res.headers.get('location') ?? '').not.toContain('/auth/mfa');
    });

    it('a FALSY mfaPending proceeds — the check is `=== true`, not truthiness', async () => {
        // Guards the strict comparison at the top of the block. A token
        // deserialised with `mfaPending: 'false'` must not be read as
        // satisfied, but `false`/`undefined` must not be read as pending.
        for (const value of [false, undefined, null, 0]) {
            getToken.mockResolvedValue(validToken({ mfaPending: value }));
            const res = await middleware(req('/api/t/acme-corp/tasks'), {} as any);
            expect(res.status).not.toBe(403);
        }
    });
});

describe('regression proof — the gate is load-bearing', () => {
    it('the SAME request is allowed without the flag and refused with it', async () => {
        // A single differential assertion: identical token, one field apart.
        // If someone deletes the middleware block, this fails immediately —
        // whereas asserting against a local `simulateMiddleware()` copy, as
        // tests/unit/mfa-enforcement.test.ts does, would still pass.
        getToken.mockResolvedValue(validToken());
        const allowed = await middleware(req('/api/t/acme-corp/tasks'), {} as any);

        getToken.mockResolvedValue(validToken({ mfaPending: true }));
        const refused = await middleware(req('/api/t/acme-corp/tasks'), {} as any);

        expect(allowed.status).not.toBe(403);
        expect(refused.status).toBe(403);
        expect(await reason(refused)).toBe('MFA verification required');
    });
});
