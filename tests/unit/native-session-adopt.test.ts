/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirror
 * runtime contracts; the codebase's standard file-level disable. */
/**
 * `/api/auth/native/adopt` — the route that lets a WKWebView hold a session.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * A Capacitor shell in `server.url` mode renders SERVER-RENDERED PAGES in a
 * WKWebView, and those are authenticated by COOKIE — `getServerSession()` reads
 * `sessionStore.value` and never consults the `Authorization` header. The native
 * auth shipped in #601/#603 produces a BEARER. So a flawless native sign-in left
 * the webview logged out, and issue #700 is the NO-GO gate for the whole iOS
 * wrapper.
 *
 * These assertions are what "the gate passes" means. If they hold, the shell can
 * authenticate; if they cannot be made to hold, there is no wrapper in
 * `server.url` mode and #649 stops before anyone spends money on it.
 *
 * ── The two properties that are easy to get wrong ──
 *
 * 1. THE COOKIE MUST REUSE THE BEARER'S `userSessionId`.
 *    `establishSsoSession()` — the other server-side cookie minter — always
 *    calls `recordNewSession()`. Doing that here would mint a SECOND
 *    `UserSession` row for one sign-in, and an admin revoking the session the
 *    bearer is bound to would leave the webview logged in. A revocation control
 *    that silently covers half the app is worse than none, because the admin
 *    believes they acted. Pinned below.
 *
 * 2. THE COOKIE MUST CARRY THE SESSION LIFETIME, NOT THE ACCESS TOKEN'S.
 *    The `/exchange` access token is byte-compatible with a session cookie —
 *    same `encode`, same secret — so re-using it directly is a tempting
 *    shortcut. Its TTL is 15 minutes with no in-webview refresh path, so the
 *    shell would silently log itself out every fifteen minutes, in a field, with
 *    nothing an operator could act on. Pinned below.
 */
import { NextRequest } from 'next/server';

const resolveBearerTokenMock = jest.fn();
const buildSessionClaimsMock = jest.fn();
const encodeMock = jest.fn();
const cookieSet = jest.fn();
const recordNewSessionMock = jest.fn();

jest.mock('@/lib/auth/native/bearer-principal', () => ({
    resolveBearerToken: (...a: any[]) => resolveBearerTokenMock(...a),
}));
jest.mock('@/auth', () => ({
    buildSessionClaims: (...a: any[]) => buildSessionClaimsMock(...a),
    authOptions: { callbacks: {} },
}));
jest.mock('next-auth/jwt', () => ({ encode: (...a: any[]) => encodeMock(...a) }));
jest.mock('next/headers', () => ({
    cookies: async () => ({ set: (...a: any[]) => cookieSet(...a) }),
    headers: async () => new Headers(),
}));
// Imported so the test can assert it is NEVER called — see property 1.
jest.mock('@/lib/security/session-tracker', () => ({
    recordNewSession: (...a: any[]) => recordNewSessionMock(...a),
    verifyAndTouchSession: jest.fn(async () => ({ revoked: false })),
}));

import { GET } from '@/app/api/auth/native/adopt/route';
import { SESSION_MAX_AGE_SECONDS } from '@/lib/auth/session-lifetime';

const TOKEN = {
    userId: 'user-1',
    sub: 'user-1',
    tenantId: 'tenant-1',
    userSessionId: 'session-row-abc',
};

const call = (url = 'http://localhost/api/auth/native/adopt') =>
    GET(new NextRequest(url, { method: 'GET' }), { params: Promise.resolve({}) } as any);

beforeEach(() => {
    jest.clearAllMocks();
    resolveBearerTokenMock.mockResolvedValue({ ...TOKEN });
    buildSessionClaimsMock.mockResolvedValue({ sub: 'user-1', userSessionId: 'session-row-abc' });
    encodeMock.mockResolvedValue('encoded-session-jwe');
});

describe('adopt — a valid bearer produces a session cookie', () => {
    it('sets the cookie next-auth will read, httpOnly and path-wide', async () => {
        const res = await call();

        expect(cookieSet).toHaveBeenCalledTimes(1);
        const [name, value, opts] = cookieSet.mock.calls[0];
        // The name is derived by sso-session from NEXTAUTH_URL exactly as
        // next-auth derives it — this asserts we used that helper rather than
        // restating the rule and drifting from the reader.
        expect(name).toMatch(/next-auth\.session-token$/);
        expect(value).toBe('encoded-session-jwe');
        expect(opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
        expect(res.status).toBe(303);
    });

    it('redirects to the app root so the webview lands somewhere useful', async () => {
        const res = await call();
        expect(res.headers.get('location')).toBe('http://localhost/');
    });
});

describe('adopt — the two properties that are easy to get wrong', () => {
    it('REUSES the bearer session id and never records a new session', async () => {
        // Property 1. A second UserSession row would mean revoking the bearer's
        // session leaves the webview logged in.
        await call();

        expect(buildSessionClaimsMock).toHaveBeenCalledWith(
            expect.objectContaining({ userSessionId: 'session-row-abc', userId: 'user-1' }),
        );
        expect(recordNewSessionMock).not.toHaveBeenCalled();
    });

    it('encodes at the SESSION lifetime, not the access token\'s 15 minutes', async () => {
        // Property 2. Reusing the access token TTL here would log the shell out
        // every fifteen minutes with no in-webview refresh path.
        await call();

        expect(encodeMock).toHaveBeenCalledWith(
            expect.objectContaining({ maxAge: SESSION_MAX_AGE_SECONDS }),
        );
        // Guard the number itself, so a future "unify the TTLs" cannot quietly
        // make this the short one.
        expect(SESSION_MAX_AGE_SECONDS).toBeGreaterThan(24 * 60 * 60);
    });

    it('carries the tenant claim through', async () => {
        await call();
        expect(buildSessionClaimsMock).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-1' }),
        );
    });
});

describe('adopt — refusals set no cookie', () => {
    it('401s with no bearer, and sets nothing', async () => {
        resolveBearerTokenMock.mockResolvedValue(null);

        const res = await call();

        expect(res.status).toBe(401);
        expect(cookieSet).not.toHaveBeenCalled();
        expect(encodeMock).not.toHaveBeenCalled();
    });

    it('401s when the token carries no session id — we do not invent one', async () => {
        resolveBearerTokenMock.mockResolvedValue({ userId: 'user-1', sub: 'user-1' });

        const res = await call();

        expect(res.status).toBe(401);
        expect(cookieSet).not.toHaveBeenCalled();
    });

    it('401s when claims cannot be built', async () => {
        buildSessionClaimsMock.mockResolvedValue(null);

        const res = await call();

        expect(res.status).toBe(401);
        expect(cookieSet).not.toHaveBeenCalled();
    });
});

describe('adopt — the redirect cannot be aimed off-origin', () => {
    // This route is reached WITH a valid credential, so an open redirect here
    // leaks a live session rather than merely being untidy.
    it.each([
        ['https://evil.example/x', 'absolute URL'],
        ['//evil.example/x', 'protocol-relative — the one naive checks miss'],
        ['http://evil.example', 'plain http absolute'],
    ])('rejects %s (%s) and lands on the root instead', async (next) => {
        const res = await call(
            `http://localhost/api/auth/native/adopt?next=${encodeURIComponent(next)}`,
        );
        expect(res.headers.get('location')).toBe('http://localhost/');
    });

    it('allows a same-origin path', async () => {
        const res = await call('http://localhost/api/auth/native/adopt?next=%2Ft%2Facme%2Fjournal');
        expect(res.headers.get('location')).toBe('http://localhost/t/acme/journal');
    });
});
