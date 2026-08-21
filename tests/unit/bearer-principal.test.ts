/**
 * `resolveBearerSession` — the module that decides whether a native bearer
 * token authorises a request, and which had **zero tests of any kind**: not a
 * unit test, not an integration test, not even a grep guard. 152 lines making
 * live session-revocation decisions.
 *
 * Issue #674, part 1. Filed from the 2026-08-19 enforcement-seam audit's
 * *cleared* list — the category explicitly "not reported as separate gaps but
 * worth knowing", which is exactly what evaporates when a document is archived.
 *
 * Every early return in this module is a security decision:
 *
 *   1. no `Authorization` header            → null
 *   2. header is not `Bearer …`             → null
 *   3. `getToken` yields nothing            → null
 *   4. `token.error` is set                 → null   (belt-and-braces)
 *   5. no `userId` and no `sub`             → null
 *   6. `verifyAndTouchSession` says revoked → null   (LIVE revocation)
 *   7. that check THROWS                    → proceed, deliberately fail-OPEN
 *   8. otherwise                            → a Session shaped by the same
 *                                             callback the cookie path uses
 *
 * (7) is the one most likely to be "tidied" into a fail-closed by a future
 * reader who reads it as an oversight. It is not: the module's own comment
 * says failing closed "would turn a database blip into a fleet-wide
 * sign-out", and the cookie path behaves the same way. It is pinned here so
 * the deliberate choice has a test attached to it rather than a comment alone.
 *
 * ── Why the gap existed, and why a file listing hid it ───────────────
 *
 * `tests/unit/bearer-cookie-parity.test.ts` looks like it covers this seam.
 * It does not, and it cannot: it mocks `getToken` and sets the SAME
 * `mockResolvedValue` for both transports before asserting the two answers
 * match (`:72` and `:75`). The identity holds **by construction** — that is
 * the audit's own "true by construction" finding, and it is issue #674 part 2.
 *
 * Measured against the three suites nearest this module — parity,
 * session-revocation-enforced, mfa-gate-enforced, 27 tests:
 *
 *     mutation to bearer-principal.ts          result
 *     -------------------------------------    -------------
 *     drop the token.error check               27/27 GREEN
 *     drop `if (result.revoked) return null`   27/27 GREEN
 *     drop the `Bearer ` prefix check          27/27 GREEN
 *
 * So live session revocation could be deleted for every native client and the
 * suite named after this seam stays green. Anyone scanning a file listing
 * would assume otherwise — and that assumption is precisely what let a
 * 152-line auth module doing a live DB revocation check sit at zero tests.
 */

const mockHeaders = new Map<string, string>();
jest.mock('next/headers', () => ({
    headers: async () => ({
        get: (k: string) => mockHeaders.get(k.toLowerCase()) ?? null,
        entries: () => mockHeaders.entries(),
        [Symbol.iterator]: () => mockHeaders.entries(),
    }),
}));

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: unknown[]) => getToken(...a) }));

const verifyAndTouchSession = jest.fn();
jest.mock('@/lib/security/session-tracker', () => ({
    verifyAndTouchSession: (...a: unknown[]) => verifyAndTouchSession(...a),
}));

const warn = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => warn(...a), info: jest.fn(), error: jest.fn() },
}));

/**
 * The session callback is the SHAPER the cookie path also runs — the module's
 * central claim is that both paths go through this one function so they cannot
 * disagree on shape. Mocked to a recognisable marker so "did it reach the
 * shared shaper?" is directly observable.
 */
type SessionCbArg = { session: Record<string, unknown>; token: Record<string, unknown> };
const sessionCallback = jest.fn(async (arg: SessionCbArg) => ({
    ...arg.session,
    __shapedBy: 'authOptions.callbacks.session',
    __tokenSeen: arg.token,
}));
jest.mock('@/auth', () => ({
    authOptions: {
        callbacks: { session: (arg: SessionCbArg) => sessionCallback(arg) },
    },
}));

import { resolveBearerSession } from '@/lib/auth/native/bearer-principal';

const GOOD_TOKEN = { userId: 'u-1', sub: 'u-1', userSessionId: 'sess-1' };

beforeEach(() => {
    mockHeaders.clear();
    getToken.mockReset().mockResolvedValue(GOOD_TOKEN);
    verifyAndTouchSession.mockReset().mockResolvedValue({ revoked: false });
    sessionCallback.mockClear();
    warn.mockReset();
});

function withBearer(value = 'Bearer tok-abc') {
    mockHeaders.set('authorization', value);
}

describe('resolveBearerSession — refusals', () => {
    it('returns null with no Authorization header', async () => {
        await expect(resolveBearerSession()).resolves.toBeNull();
        // …and does not even look for a token.
        expect(getToken).not.toHaveBeenCalled();
    });

    it.each([
        ['Basic dXNlcjpwYXNz', 'Basic auth'],
        ['bearer tok', 'lowercase scheme'],
        ['Bearer', 'scheme with no credential'],
        ['tok-abc', 'bare token, no scheme'],
        ['', 'empty header'],
    ])('returns null for %s (%s)', async (header) => {
        mockHeaders.set('authorization', header);
        await expect(resolveBearerSession()).resolves.toBeNull();
    });

    it('returns null when getToken yields nothing', async () => {
        withBearer();
        getToken.mockResolvedValue(null);
        await expect(resolveBearerSession()).resolves.toBeNull();
    });

    it('returns null when the token carries an error claim', async () => {
        // The jwt callback stamps `error` when the session was already known
        // bad at mint time. Middleware denies those; this is the backstop for
        // any path that reaches here without traversing middleware.
        withBearer();
        getToken.mockResolvedValue({ ...GOOD_TOKEN, error: 'RefreshAccessTokenError' });
        await expect(resolveBearerSession()).resolves.toBeNull();
        expect(sessionCallback).not.toHaveBeenCalled();
    });

    it('ignores an EMPTY error claim — absent and blank are the same thing', async () => {
        withBearer();
        getToken.mockResolvedValue({ ...GOOD_TOKEN, error: '' });
        await expect(resolveBearerSession()).resolves.not.toBeNull();
    });

    const NO_PRINCIPAL: ReadonlyArray<[Record<string, unknown>, string]> = [
        [{ userSessionId: 's' }, 'neither userId nor sub'],
        [{ userId: undefined, sub: undefined }, 'both explicitly undefined'],
    ];
    it.each(NO_PRINCIPAL)('returns null with %s', async (token) => {
        withBearer();
        getToken.mockResolvedValue(token);
        await expect(resolveBearerSession()).resolves.toBeNull();
    });

    it('falls back to `sub` when `userId` is absent', async () => {
        withBearer();
        getToken.mockResolvedValue({ sub: 'from-sub', userSessionId: 'sess-1' });
        const s = await resolveBearerSession();
        expect(s).not.toBeNull();
        const arg = sessionCallback.mock.calls[0]![0];
        expect((arg.session as { user: { id: string } }).user.id).toBe('from-sub');
    });
});

describe('resolveBearerSession — live revocation', () => {
    it('returns null when the session row says revoked', async () => {
        // THE point of the module. An access token is minted once and presented
        // unchanged until expiry, so nothing inside it can learn that an admin
        // revoked the session. This check is what makes revocation take effect
        // on the next request rather than the next refresh.
        withBearer();
        verifyAndTouchSession.mockResolvedValue({ revoked: true });
        await expect(resolveBearerSession()).resolves.toBeNull();
        expect(sessionCallback).not.toHaveBeenCalled();
    });

    it('checks the row identified by the token, not an arbitrary one', async () => {
        withBearer();
        getToken.mockResolvedValue({ ...GOOD_TOKEN, userSessionId: 'sess-XYZ' });
        await resolveBearerSession();
        expect(verifyAndTouchSession).toHaveBeenCalledWith('sess-XYZ');
    });

    it('proceeds when the row is live', async () => {
        withBearer();
        verifyAndTouchSession.mockResolvedValue({ revoked: false });
        await expect(resolveBearerSession()).resolves.not.toBeNull();
    });

    it('skips the check entirely when the token carries no session id', async () => {
        // Older tokens predate `userSessionId`. They must still authorise —
        // the coarse `sessionVersion` backstop covers them — so this must not
        // become a hard requirement by accident.
        withBearer();
        getToken.mockResolvedValue({ userId: 'u-1', sub: 'u-1' });
        await expect(resolveBearerSession()).resolves.not.toBeNull();
        expect(verifyAndTouchSession).not.toHaveBeenCalled();
    });

    it('FAILS OPEN when the revocation check throws, and says so in the log', async () => {
        // Deliberate, and the branch most likely to be "fixed" into a
        // fail-closed by someone reading it as an oversight. Failing closed
        // would turn a database blip into a fleet-wide sign-out, and the
        // cookie path behaves identically.
        withBearer();
        verifyAndTouchSession.mockRejectedValue(new Error('connection reset'));
        await expect(resolveBearerSession()).resolves.not.toBeNull();
        expect(warn).toHaveBeenCalledWith(
            'native-auth.session_check_failed',
            expect.objectContaining({ component: 'native-auth' }),
        );
    });
});

describe('resolveBearerSession — shaping', () => {
    it('shapes the session with the SAME callback the cookie path uses', async () => {
        // The module's central claim: one shaper, so the two paths cannot
        // disagree on shape. If someone reconstructs claims here instead, this
        // fails.
        withBearer();
        const s = (await resolveBearerSession()) as unknown as Record<string, unknown>;
        expect(sessionCallback).toHaveBeenCalledTimes(1);
        expect(s.__shapedBy).toBe('authOptions.callbacks.session');
    });

    it('hands the callback the real token, not a reconstruction', async () => {
        withBearer();
        getToken.mockResolvedValue({ ...GOOD_TOKEN, tenantId: 't-9', role: 'ADMIN' });
        const s = (await resolveBearerSession()) as unknown as { __tokenSeen: Record<string, unknown> };
        expect(s.__tokenSeen).toMatchObject({ tenantId: 't-9', role: 'ADMIN' });
    });

    it('carries NO email on the shell — a bearer principal deliberately has none', async () => {
        withBearer();
        await resolveBearerSession();
        const shell = sessionCallback.mock.calls[0]![0].session as { user: { email: string } };
        expect(shell.user.email).toBe('');
    });

    it('does not throw when the app configures no session callback', async () => {
        withBearer();
        jest.resetModules();
        jest.doMock('@/auth', () => ({ authOptions: { callbacks: {} } }));
        const mod = await import('@/lib/auth/native/bearer-principal');
        await expect(mod.resolveBearerSession()).resolves.not.toBeNull();
        jest.dontMock('@/auth');
    });
});
