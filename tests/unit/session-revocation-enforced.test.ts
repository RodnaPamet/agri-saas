/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, getToken); the file-level disable is this
 * codebase's standard pattern for these surfaces (see tests/unit/cors.test.ts). */

/**
 * Session revocation must DENY A REQUEST — not merely set a flag.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * The `jwt` callback signalled four failure modes by setting `token.error`,
 * and NOTHING IN `src/` EVER READ IT. The flag was written in five places
 * (auth.ts:591/637/681/708, entra-group-sync.ts:182) and read in none, so the
 * /admin/members "revoke session" button, `maxConcurrentSessions` eviction,
 * session expiry, and the `User.sessionVersion` backstop that password change
 * and reset depend on were all inert. A revoked session kept working.
 *
 * The reason CI never noticed is the part worth remembering:
 *
 *   - `tests/unit/session-revocation.test.ts` declares its OWN local
 *     `isSessionRevoked(tokenVersion, dbVersion)` and tests THAT — a
 *     reimplementation of the rule, never the code that runs.
 *   - `tests/unit/auth-callbacks.test.ts` asserts
 *     `expect(result.error).toBe('SessionRevoked')` — that the callback
 *     RETURNS the flag. It cannot observe whether anything acts on it.
 *
 * Both are green, and were green throughout. So this file asserts the only
 * thing that actually protects a user: **a request carrying a revoked token
 * is refused.** It drives the real `src/middleware.ts` — the same harness
 * `tests/unit/cors.test.ts` uses — rather than a stand-in.
 */
import { NextRequest } from 'next/server';

jest.mock('../../src/lib/rate-limit/authRateLimit', () => ({
    checkAuthRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/lib/rate-limit/apiReadRateLimit', () => ({
    checkApiReadRateLimit: jest.fn().mockResolvedValue({ ok: true }),
}));

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: any[]) => getToken(...a) }));

import middleware from '../../src/middleware';

/** A token that is valid in every respect EXCEPT the error flag. */
function validToken(overrides: Record<string, unknown> = {}) {
    return {
        userId: 'usr_1',
        sub: 'usr_1',
        tenantId: 'tnt_1',
        tenantSlug: 'acme-corp',
        role: 'ADMIN',
        userSessionId: 'sess_1',
        memberships: [{ tenantId: 'tnt_1', tenantSlug: 'acme-corp', role: 'ADMIN' }],
        ...overrides,
    };
}

function req(pathname: string) {
    return new NextRequest(`http://localhost:3000${pathname}`, { method: 'GET' });
}

beforeEach(() => getToken.mockReset());

describe('a token carrying an error is refused', () => {
    // Every writer of `token.error`. All four must deny — leaving any of them
    // wired to nothing is how this bug existed in the first place.
    const ERRORS = [
        ['SessionRevoked', 'admin revoke / expiry / concurrency cap / sessionVersion bump'],
        ['MfaDependencyFailure', 'a FAIL-CLOSED MFA check that could not complete'],
        ['RefreshTokenError', 'OAuth refresh failed — its own log says "forcing reauth"'],
        ['EntraGroupGateDenied', 'Entra group gate refused'],
    ] as const;

    it.each(ERRORS)('API route: %s => 401 (%s)', async (error) => {
        getToken.mockResolvedValue(validToken({ error }));
        const res = await middleware(req('/api/t/acme-corp/tasks'), {} as any);
        expect(res.status).toBe(401);
    });

    it.each(ERRORS)('page route: %s => redirect to /login (%s)', async (error) => {
        getToken.mockResolvedValue(validToken({ error }));
        const res = await middleware(req('/t/acme-corp/dashboard'), {} as any);
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toContain('/login');
    });

    it('clears the stale session cookie so the browser stops re-presenting it', async () => {
        // Without this, every subsequent protected navigation bounces through
        // the same denial with the same dead credential.
        getToken.mockResolvedValue(validToken({ error: 'SessionRevoked' }));
        const res = await middleware(req('/t/acme-corp/dashboard'), {} as any);
        const cleared = res.cookies.get('next-auth.session-token');
        expect(cleared?.value).toBe('');
    });
});

describe('the check is precise — it must not deny valid traffic', () => {
    it('a token with NO error proceeds', async () => {
        getToken.mockResolvedValue(validToken());
        const res = await middleware(req('/t/acme-corp/dashboard'), {} as any);
        expect(res.status).not.toBe(401);
        expect(res.headers.get('location') ?? '').not.toContain('/login');
    });

    it('an EMPTY-STRING error proceeds (absence, not a sentinel)', async () => {
        // `delete token.error` on a successful refresh (auth.ts:664) is the
        // normal clear path, but a defensive '' must not read as a denial.
        getToken.mockResolvedValue(validToken({ error: '' }));
        const res = await middleware(req('/t/acme-corp/dashboard'), {} as any);
        expect(res.status).not.toBe(401);
    });

    it('a public path is NOT denied even with a revoked token — no redirect loop', async () => {
        // The denial sits AFTER isPublicPath. If it did not, /login would
        // redirect to /login forever and lock the user out of recovering.
        getToken.mockResolvedValue(validToken({ error: 'SessionRevoked' }));
        const res = await middleware(req('/login'), {} as any);
        expect(res.status).not.toBe(401);
        expect(res.headers.get('location') ?? '').not.toContain('/login?');
    });
});

describe('regression proof — the check is load-bearing', () => {
    it('the SAME request is allowed when the flag is absent and denied when present', async () => {
        // A single differential assertion: identical token, one field apart.
        // If someone removes the middleware gate, this fails immediately,
        // whereas asserting only the callback's return value would not.
        getToken.mockResolvedValue(validToken());
        const allowed = await middleware(req('/api/t/acme-corp/tasks'), {} as any);

        getToken.mockResolvedValue(validToken({ error: 'SessionRevoked' }));
        const denied = await middleware(req('/api/t/acme-corp/tasks'), {} as any);

        expect(allowed.status).not.toBe(401);
        expect(denied.status).toBe(401);
    });
});
