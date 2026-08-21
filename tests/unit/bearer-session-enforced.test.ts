/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirror
 * runtime contracts; the codebase's standard file-level disable. */
/**
 * `resolveBearerSession` — the native bearer principal, which nothing tested.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * Before this file, `grep -rln "resolveBearerSession\|bearer-principal" tests/`
 * returned **nothing**. Not a unit test, not an integration test, not even a
 * `tests/guards/` regex — for a 152-line module that `src/auth.ts:863-864`
 * reaches on every native request and that performs a **live session-revocation
 * check** against the database.
 *
 * The one test that looks like it covers this seam does not.
 * `tests/unit/bearer-cookie-parity.test.ts` mocks `getToken` and then sets the
 * SAME `mockResolvedValue` for both the bearer and the cookie call before
 * asserting `expect(r.bearer).toEqual(r.cookie)` — an identity that holds by
 * construction and cannot fail for the reason the test exists. It also never
 * reaches this module: it drives middleware, and `resolveBearerSession` lives
 * one layer below, on the `getServerSession` side.
 *
 * The 2026-08-19 enforcement-seam audit flagged that parity test as
 * "true by construction"; this file is the executing half it was missing.
 *
 * ── The two failure directions, which are NOT symmetric ──
 *
 * Both matter and they pull opposite ways, which is exactly why they need
 * pinning against a future tidy-up:
 *
 *   FAIL CLOSED on a definite "revoked". An access token is minted once and
 *   presented unchanged until expiry, so nothing inside it can learn that an
 *   admin revoked the session five minutes ago. The DB check is what makes
 *   "revoking a session invalidates the token" true without a lifetime-shaped
 *   caveat. Delete it and revocation silently stops working for every native
 *   client — with no error anywhere.
 *
 *   FAIL OPEN on an UNKNOWN answer. `verifyAndTouchSession` throwing is a
 *   database blip, not a revocation. The module logs and continues,
 *   deliberately and consistently with the cookie path. "Hardening" this into a
 *   `return null` would convert a transient DB error into a fleet-wide sign-out
 *   of every operator in the field — the precise failure this product can least
 *   afford, on a phone with no signal to retry from.
 *
 * A test that only covered the first would make the second look like an
 * oversight to the next reader. Both are asserted below, named as deliberate.
 */
import type { Session } from 'next-auth';

const getTokenMock = jest.fn();
const headersMock = jest.fn();
const verifyAndTouchSessionMock = jest.fn();
const warnMock = jest.fn();

jest.mock('next-auth/jwt', () => ({ getToken: (...a: any[]) => getTokenMock(...a) }));
jest.mock('next/headers', () => ({ headers: (...a: any[]) => headersMock(...a) }));
jest.mock('@/lib/security/session-tracker', () => ({
    verifyAndTouchSession: (...a: any[]) => verifyAndTouchSessionMock(...a),
}));
jest.mock('@/lib/observability/logger', () => ({ logger: { warn: (...a: any[]) => warnMock(...a) } }));

/**
 * The REAL session callback is what shapes the result, and the module's own
 * docblock calls that "ONE shaper" — the same callback the cookie path runs, so
 * the two cannot disagree on shape. This stand-in is deliberately distinctive:
 * it stamps a marker no other code path could produce, so the assertions below
 * prove the callback was actually invoked rather than the session being
 * reconstructed locally.
 */
const sessionCallback = jest.fn(async ({ session, token }: any) => ({
    ...session,
    user: { ...session.user, id: token.userId ?? token.sub, role: token.role, shapedByCallback: true },
}));
jest.mock('@/auth', () => ({ authOptions: { callbacks: { session: (args: any) => sessionCallback(args) } } }));

import { resolveBearerSession } from '@/lib/auth/native/bearer-principal';

const TOKEN = { userId: 'user-1', sub: 'user-1', role: 'ADMIN', userSessionId: 'sess-1' };

function withAuthHeader(value: string | null): void {
    headersMock.mockResolvedValue(new Headers(value === null ? {} : { authorization: value }));
}

beforeEach(() => {
    jest.clearAllMocks();
    withAuthHeader('Bearer valid-token');
    getTokenMock.mockResolvedValue({ ...TOKEN });
    verifyAndTouchSessionMock.mockResolvedValue({ revoked: false });
});

describe('resolveBearerSession — the happy path actually runs', () => {
    it('returns a session shaped by the REAL authOptions session callback', () => {
        // Asserted first: every "returns null" test below is vacuous if the
        // function can never return anything at all.
        return resolveBearerSession().then((s) => {
            expect(s).not.toBeNull();
            expect((s as any).user.id).toBe('user-1');
            expect((s as any).user.role).toBe('ADMIN');
            // Proves the shared shaper ran — this marker exists nowhere else.
            expect((s as any).user.shapedByCallback).toBe(true);
            expect(sessionCallback).toHaveBeenCalledTimes(1);
        });
    });

    it('finds the token with getToken — claims are never reconstructed', async () => {
        // The module's "ONE locator" rule. A second producer that missed
        // applyMembershipClaims' ACTIVE filter or its 50-item slice would be
        // silently more permissive than the cookie path.
        await resolveBearerSession();
        expect(getTokenMock).toHaveBeenCalledTimes(1);
        expect(getTokenMock.mock.calls[0][0]).toHaveProperty('secret');
    });
});

describe('resolveBearerSession — refuses without consulting the database', () => {
    it('returns null when there is no Authorization header', async () => {
        withAuthHeader(null);
        await expect(resolveBearerSession()).resolves.toBeNull();
        expect(getTokenMock).not.toHaveBeenCalled();
    });

    it('returns null for a non-Bearer scheme', async () => {
        withAuthHeader('Basic dXNlcjpwYXNz');
        await expect(resolveBearerSession()).resolves.toBeNull();
        expect(getTokenMock).not.toHaveBeenCalled();
    });

    it('returns null when getToken cannot verify the token', async () => {
        getTokenMock.mockResolvedValue(null);
        await expect(resolveBearerSession()).resolves.toBeNull();
        expect(verifyAndTouchSessionMock).not.toHaveBeenCalled();
    });

    it('returns null when the token carries an error claim', async () => {
        // Minted known-bad. Middleware denies these; this is the belt-and-braces
        // for any path reaching here without traversing middleware.
        getTokenMock.mockResolvedValue({ ...TOKEN, error: 'SessionRevoked' });
        await expect(resolveBearerSession()).resolves.toBeNull();
    });

    it('returns null when the token identifies no user', async () => {
        getTokenMock.mockResolvedValue({ role: 'ADMIN' });
        await expect(resolveBearerSession()).resolves.toBeNull();
    });
});

describe('resolveBearerSession — live revocation, and its deliberate asymmetry', () => {
    it('FAILS CLOSED on a definite revocation — the module\'s whole reason to exist', async () => {
        verifyAndTouchSessionMock.mockResolvedValue({ revoked: true });

        await expect(resolveBearerSession()).resolves.toBeNull();
        expect(verifyAndTouchSessionMock).toHaveBeenCalledWith('sess-1');
        // The shaper must never run for a revoked principal.
        expect(sessionCallback).not.toHaveBeenCalled();
    });

    it('FAILS OPEN when the check itself throws — a DB blip is not a revocation', async () => {
        // Deliberate, and consistent with the cookie path. "Hardening" this to
        // `return null` turns a transient database error into a fleet-wide
        // sign-out of every operator in the field. A definite "revoked" is
        // honoured; an unknown answer is not manufactured into one.
        verifyAndTouchSessionMock.mockRejectedValue(new Error('connection terminated'));

        const s = await resolveBearerSession();
        expect(s).not.toBeNull();
        expect((s as any).user.shapedByCallback).toBe(true);
        // And it is not silent.
        expect(warnMock).toHaveBeenCalledWith(
            'native-auth.session_check_failed',
            expect.objectContaining({ component: 'native-auth' }),
        );
    });

    it('skips the check when the token carries no session id', async () => {
        getTokenMock.mockResolvedValue({ userId: 'user-1', role: 'ADMIN' });

        const s = await resolveBearerSession();
        expect(s).not.toBeNull();
        expect(verifyAndTouchSessionMock).not.toHaveBeenCalled();
    });
});

describe('resolveBearerSession — the returned shape', () => {
    it('carries no email, deliberately', async () => {
        // The docblock is explicit: the session callback does not copy `email`,
        // nothing downstream reads it, and inventing one would be worse. Pinned
        // so a future "the shell looks incomplete" tidy-up has to argue with it.
        const s = (await resolveBearerSession()) as Session;
        expect(s.user.email).toBe('');
    });
});
