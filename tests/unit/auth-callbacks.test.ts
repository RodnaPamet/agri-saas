/**
 * Coverage wave 15 — the `jwt` and `session` callbacks in `src/auth.ts`.
 *
 * `src/auth.ts` was the densest single uncovered file in the repo: 241
 * uncovered branches at 10.4%. What coverage it had came from one
 * narrow spec (`jwt-update-trigger-refresh.test.ts`); the
 * `jwt-membership-bound` guardrail only `readFileSync`s the source, so
 * the JWT cap it protects was never actually executed.
 *
 * That left the security-critical paths unexercised: session
 * revocation, the throttled sessionVersion check, OAuth refresh
 * failure, MFA enforcement and challenge completion, and the rule that
 * the session callback must never hand OAuth tokens to the client.
 *
 * Each test names the production break it catches. Mocks sit at the
 * external boundary only — Prisma, the session tracker, the refresh
 * helper — so the callback logic under test is the real thing.
 */

const userFindUnique = jest.fn();
const secSettingsFindUnique = jest.fn();
const mfaFindUnique = jest.fn();
const accountUpdateMany = jest.fn();
const accountFindUnique = jest.fn();
const accountCreate = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: {
            // #1237: the email lookup is `findFirst` now — an `in`
            // predicate is not valid on `findUnique`. Same double.
            findFirst: (...a: unknown[]) => userFindUnique(...a), findUnique: (...a: unknown[]) => userFindUnique(...a) },
        tenantSecuritySettings: {
            findUnique: (...a: unknown[]) => secSettingsFindUnique(...a),
            findFirst: (...a: unknown[]) => secSettingsFindUnique(...a),
        },
        userMfaEnrollment: {
            findUnique: (...a: unknown[]) => mfaFindUnique(...a),
            findFirst: (...a: unknown[]) => mfaFindUnique(...a),
        },
        account: {
            updateMany: (...a: unknown[]) => accountUpdateMany(...a),
            findUnique: (...a: unknown[]) => accountFindUnique(...a),
            findFirst: (...a: unknown[]) => accountFindUnique(...a),
            create: (...a: unknown[]) => accountCreate(...a),
        },
    },
}));

const isTokenExpired = jest.fn();
// The two provider functions, not the `refreshAccessToken` dispatcher that
// stood here: #1986 deleted it along with its only caller. They are mocked so
// the tests below can assert the callback calls NEITHER — which is the
// property, and it needs a double that would record a call if one happened.
const refreshGoogleToken = jest.fn();
const refreshMicrosoftToken = jest.fn();
jest.mock('@/lib/auth/refresh', () => ({
    __esModule: true,
    isTokenExpired: (...a: unknown[]) => isTokenExpired(...a),
    refreshGoogleToken: (...a: unknown[]) => refreshGoogleToken(...a),
    refreshMicrosoftToken: (...a: unknown[]) => refreshMicrosoftToken(...a),
}));

const verifyAndTouchSession = jest.fn();
const recordNewSession = jest.fn();
jest.mock('@/lib/security/session-tracker', () => ({
    __esModule: true,
    verifyAndTouchSession: (...a: unknown[]) => verifyAndTouchSession(...a),
    recordNewSession: (...a: unknown[]) => recordNewSession(...a),
}));

const redeemPendingInvites = jest.fn();
jest.mock('@/lib/auth/invite-redemption', () => ({
    __esModule: true,
    redeemPendingInvites: (...a: unknown[]) => redeemPendingInvites(...a),
}));

import { authOptions, MAX_JWT_MEMBERSHIPS } from '@/auth';

type Callbacks = NonNullable<typeof authOptions.callbacks>;
const jwtCallback = authOptions.callbacks!.jwt as NonNullable<Callbacks['jwt']>;
const sessionCallback = authOptions.callbacks!
    .session as NonNullable<Callbacks['session']>;
const signInCallback = authOptions.callbacks!
    .signIn as NonNullable<Callbacks['signIn']>;

/** Invoke the signIn callback with a partial payload. */
const runSignIn = (args: Record<string, unknown>) =>
    signInCallback(args as never) as Promise<boolean>;

/**
 * Invoke the session callback. NextAuth types `session.user` as a union of
 * the augmented shape and the stock `{ name, email, image }`, so the custom
 * claims are not reachable without narrowing.
 */
const runSession = async (args: Record<string, unknown>) => {
    const result = await sessionCallback(args as never);
    return result as unknown as { user: Record<string, unknown> };
};

/** Invoke the jwt callback with a partial token, bypassing NextAuth's arg types. */
const runJwt = (args: Record<string, unknown>) =>
    jwtCallback(args as never) as Promise<Record<string, never>>;

function makeMembership(i: number) {
    return {
        tenantId: `t-${i}`,
        role: 'EDITOR',
        tenant: { id: `t-${i}`, slug: `tenant-${i}` },
    };
}

function makeOrgMembership(i: number) {
    return {
        organizationId: `o-${i}`,
        role: 'ORG_MEMBER',
        organization: { id: `o-${i}`, slug: `org-${i}` },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    // Safe defaults: nothing revoked, nothing expired, no MFA policy.
    verifyAndTouchSession.mockResolvedValue({ revoked: false });
    recordNewSession.mockResolvedValue({ sessionId: 'sess-1' });
    redeemPendingInvites.mockResolvedValue(undefined);
    isTokenExpired.mockReturnValue(false);
    secSettingsFindUnique.mockResolvedValue(null);
    mfaFindUnique.mockResolvedValue(null);
    userFindUnique.mockResolvedValue(null);
});

describe('signIn callback — provider trust and account linking', () => {
    const oauth = {
        provider: 'google',
        type: 'oauth',
        providerAccountId: 'google-sub-1',
        access_token: 'at-1',
    };

    it('rejects an OAuth identity whose provider reports the email unverified', async () => {
        // Break: accepting `email_verified === false` lets anyone who
        // can register an unverified address at a permissive IdP sign
        // in as the owner of that address — account takeover.
        const allowed = await runSignIn({
            user: { id: 'p-sub', email: 'victim@example.com' },
            account: oauth,
            profile: { email_verified: false },
        });

        expect(allowed).toBe(false);
        expect(userFindUnique).not.toHaveBeenCalled();
    });

    it('admits an OAuth identity the provider has verified', async () => {
        // Break: over-strict matching (e.g. requiring the claim) would
        // lock out providers that omit `email_verified` entirely.
        userFindUnique.mockResolvedValue(null);

        const allowed = await runSignIn({
            user: { id: 'p-sub', email: 'ok@example.com' },
            account: oauth,
            profile: { email_verified: true },
        });

        expect(allowed).toBe(true);
    });

    it('does not apply the provider email check to credentials sign-in', async () => {
        // Break: applying it would reject password logins, since the
        // credentials provider supplies no profile claims.
        const allowed = await runSignIn({
            user: { id: 'u-1', email: 'ok@example.com' },
            account: { provider: 'credentials', type: 'credentials' },
            profile: { email_verified: false },
        });

        expect(allowed).toBe(true);
        expect(userFindUnique).not.toHaveBeenCalled();
    });

    it('links a new provider account to the existing user with that email', async () => {
        // Break: dropping the link would strand the user with a second,
        // membership-less account for the same address.
        userFindUnique.mockResolvedValue({ id: 'u-existing' });
        accountFindUnique.mockResolvedValue(null);

        const allowed = await runSignIn({
            user: { id: 'p-sub', email: 'ok@example.com' },
            account: oauth,
            profile: {},
        });

        expect(allowed).toBe(true);
        expect(accountCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    userId: 'u-existing',
                    provider: 'google',
                    providerAccountId: 'google-sub-1',
                }),
            }),
        );
    });

    it('does not duplicate an account that is already linked', async () => {
        // Break: a duplicate insert violates the
        // provider_providerAccountId unique constraint and throws the
        // user out of sign-in entirely.
        userFindUnique.mockResolvedValue({ id: 'u-existing' });
        accountFindUnique.mockResolvedValue({ id: 'acct-1' });

        const allowed = await runSignIn({
            user: { id: 'p-sub', email: 'ok@example.com' },
            account: oauth,
            profile: {},
        });

        expect(allowed).toBe(true);
        expect(accountCreate).not.toHaveBeenCalled();
    });

    it('does not re-link when the identity already is the resolved user', async () => {
        // Break: linking an account to itself on every sign-in.
        userFindUnique.mockResolvedValue({ id: 'u-1' });

        const allowed = await runSignIn({
            user: { id: 'u-1', email: 'ok@example.com' },
            account: oauth,
            profile: {},
        });

        expect(allowed).toBe(true);
        expect(accountFindUnique).not.toHaveBeenCalled();
        expect(accountCreate).not.toHaveBeenCalled();
    });

    it('admits a call carrying no account without touching the database', async () => {
        // Break: dereferencing a missing account would throw inside the
        // callback and fail the sign-in.
        const allowed = await runSignIn({
            user: { id: 'u-1', email: 'ok@example.com' },
        });

        expect(allowed).toBe(true);
        expect(userFindUnique).not.toHaveBeenCalled();
    });
});

describe('session callback — client exposure', () => {
    it('never hands OAuth access or refresh tokens to the client', async () => {
        // Break: widening the session callback to spread `token`. The
        // client would receive live OAuth credentials.
        const session = await runSession({
            session: { user: {} },
            token: {
                userId: 'u-1',
                accessToken: 'ACCESS-SECRET',
                refreshToken: 'REFRESH-SECRET',
                tenantId: 't-1',
                role: 'ADMIN',
            },
        });

        const serialized = JSON.stringify(session);
        expect(serialized).not.toContain('ACCESS-SECRET');
        expect(serialized).not.toContain('REFRESH-SECRET');
        expect(session.user.id).toBe('u-1');
        expect(session.user.role).toBe('ADMIN');
    });

    it('falls back to the subject claim and safe defaults on a sparse token', async () => {
        // Break: dropping the `?? token.sub` fallback would leave
        // session.user.id undefined, and defaulting role to anything
        // other than READER would over-grant on a claimless token.
        const session = await runSession({
            session: { user: {} },
            token: { sub: 'subject-42' },
        });

        expect(session.user.id).toBe('subject-42');
        expect(session.user.tenantId).toBeNull();
        expect(session.user.role).toBe('READER');
        expect(session.user.mfaPending).toBe(false);
        expect(session.user.memberships).toEqual([]);
        expect(session.user.orgMemberships).toEqual([]);
    });
});

describe('jwt callback — membership claims are bounded', () => {
    it('caps tenant memberships at MAX_JWT_MEMBERSHIPS and flags truncation', async () => {
        // Break: dropping the .slice() cap. The JWT is a cookie — an
        // unbounded membership array blows the header size limit and
        // signs the user out. The existing guardrail only greps for the
        // cap in source; this executes it.
        userFindUnique.mockResolvedValue({
            // P5.5a — `applyMembershipClaims` reads these two scalars for the
            // slow-mode claims. The real query uses `include`, so production
            // always has them; the double must too. Extending the FIXTURE
            // rather than making the source defensive: an optional read there
            // would leave the claim absent, which reads as "pre-P5.5a
            // session" — i.e. NOT slow. A security control must not fail open
            // because a fixture was thin.
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            emailVerified: new Date('2026-01-02T00:00:00.000Z'),
            id: 'u-1',
            sessionVersion: 1,
            uiLanguage: 'bg',
            tenantMemberships: Array.from({ length: MAX_JWT_MEMBERSHIPS + 7 }, (_, i) =>
                makeMembership(i),
            ),
            orgMemberships: [],
        });

        const result = await runJwt({
            token: { email: 'a@example.com', userId: 'u-1' },
            trigger: 'update',
        });

        expect(result.memberships).toHaveLength(MAX_JWT_MEMBERSHIPS);
        expect(result.membershipsTruncated).toBe(true);
        expect(result.orgMembershipsTruncated).toBe(false);
    });

    it('caps org memberships independently of tenant memberships', async () => {
        // Break: applying the cap to only one of the two arrays.
        userFindUnique.mockResolvedValue({
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            emailVerified: new Date('2026-01-02T00:00:00.000Z'),
            id: 'u-1',
            sessionVersion: 1,
            uiLanguage: 'en',
            tenantMemberships: [makeMembership(0)],
            orgMemberships: Array.from({ length: MAX_JWT_MEMBERSHIPS + 3 }, (_, i) =>
                makeOrgMembership(i),
            ),
        });

        const result = await runJwt({
            token: { email: 'a@example.com', userId: 'u-1' },
            trigger: 'update',
        });

        expect(result.orgMemberships).toHaveLength(MAX_JWT_MEMBERSHIPS);
        expect(result.orgMembershipsTruncated).toBe(true);
        expect(result.membershipsTruncated).toBe(false);
    });

    it('demotes a user with no active memberships to READER with no tenant', async () => {
        // Break: leaving a stale tenantId/role on the token would let
        // the Edge gate authorize a tenant the user was removed from.
        userFindUnique.mockResolvedValue({
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            emailVerified: new Date('2026-01-02T00:00:00.000Z'),
            id: 'u-1',
            sessionVersion: 4,
            uiLanguage: null,
            tenantMemberships: [],
            orgMemberships: [],
        });

        const result = await runJwt({
            token: {
                email: 'a@example.com',
                userId: 'u-1',
                tenantId: 't-old',
                tenantSlug: 'old-tenant',
                role: 'OWNER',
            },
            trigger: 'update',
        });

        expect(result.tenantId).toBeNull();
        expect(result.tenantSlug).toBeNull();
        expect(result.role).toBe('READER');
        expect(result.memberships).toEqual([]);
    });

    it('falls back to a claimless READER token when the user row is missing', async () => {
        // Break: the `else` arm. Without it a vanished user keeps
        // whatever privileges the previous token carried.
        userFindUnique.mockResolvedValue(null);

        const result = await runJwt({
            token: {
                email: 'ghost@example.com',
                userId: 'u-gone',
                role: 'OWNER',
            },
            trigger: 'update',
        });

        expect(result.role).toBe('READER');
        expect(result.sessionVersion).toBe(0);
        expect(result.memberships).toEqual([]);
        expect(result.orgMemberships).toEqual([]);
        expect(result.membershipsTruncated).toBe(false);
    });
});

describe('jwt callback — session revocation (Epic C.3)', () => {
    it('surfaces SessionRevoked when the operational session row is revoked', async () => {
        // Break: ignoring `result.revoked`. An admin revoking a session
        // from /admin/members would not actually sign that session out.
        verifyAndTouchSession.mockResolvedValue({ revoked: true });

        const result = await runJwt({
            token: { userId: 'u-1', userSessionId: 'sess-9' },
        });

        expect(result.error).toBe('SessionRevoked');
    });

    it('fails open when the session tracker throws', async () => {
        // Break: failing closed here would sign every user out on a
        // transient DB blip — the tracker is telemetry-side.
        verifyAndTouchSession.mockRejectedValue(new Error('db down'));

        const result = await runJwt({
            token: { userId: 'u-1', userSessionId: 'sess-9' },
        });

        expect(result.error).toBeUndefined();
    });

    it('skips the revocation check when the token carries no session id', async () => {
        // Break: calling the tracker with an empty id on every request.
        const result = await runJwt({ token: { userId: 'u-1' } });

        expect(verifyAndTouchSession).not.toHaveBeenCalled();
        expect(result.error).toBeUndefined();
    });
});

describe('jwt callback — throttled sessionVersion check', () => {
    const nowSec = () => Math.floor(Date.now() / 1000);

    it('revokes the token when the stored sessionVersion has been bumped', async () => {
        // Break: dropping the comparison. A password reset bumps
        // sessionVersion to invalidate old sessions; without this they
        // keep working.
        userFindUnique.mockResolvedValue({ sessionVersion: 5 });

        const result = await runJwt({
            token: {
                userId: 'u-1',
                sessionVersion: 4,
                sessionVersionCheckedAt: 0,
            },
        });

        expect(result.error).toBe('SessionRevoked');
    });

    it('does not hit the database again inside the 5-minute throttle window', async () => {
        // Break: dropping the throttle would add a DB read to EVERY
        // authenticated request.
        const result = await runJwt({
            token: {
                userId: 'u-1',
                sessionVersion: 4,
                sessionVersionCheckedAt: nowSec(),
            },
        });

        expect(userFindUnique).not.toHaveBeenCalled();
        expect(result.error).toBeUndefined();
    });

    it('stamps the check time when the version is unchanged', async () => {
        // Break: not stamping would defeat the throttle — every request
        // would re-read.
        userFindUnique.mockResolvedValue({ sessionVersion: 4 });

        const result = await runJwt({
            token: {
                userId: 'u-1',
                sessionVersion: 4,
                sessionVersionCheckedAt: 0,
            },
        });

        expect(userFindUnique).toHaveBeenCalled();
        expect(result.error).toBeUndefined();
        expect(result.sessionVersionCheckedAt).toBeGreaterThan(0);
    });

    it('fails open when the sessionVersion read throws', async () => {
        // Break: a DB blip must not sign the user out.
        userFindUnique.mockRejectedValue(new Error('db down'));

        const result = await runJwt({
            token: {
                userId: 'u-1',
                sessionVersion: 4,
                sessionVersionCheckedAt: 0,
            },
        });

        expect(result.error).toBeUndefined();
    });
});

describe('jwt callback — the OAuth refresh that is GONE (#1986)', () => {
    // Four tests over the proactive refresh stood here: it refreshed an
    // expired access token and persisted it, cleared the error, marked the
    // token for reauth when the provider refused, and left an unexpired token
    // alone. All four passed. Nothing read what they protected.
    //
    // These replace them, and they assert the harder direction — that the
    // machinery is actually absent rather than merely unused. A removal with
    // no test is indistinguishable from a removal someone reinstates.

    const staleOauthToken = {
        userId: 'u-1',
        provider: 'google',
        // The shape a cookie minted before #1986 still carries. It must be
        // IGNORED, not acted on: these users exist until their cookies age
        // out, and the one thing that must not happen is the old branch
        // waking up for them.
        expiresAt: 100,
        refreshToken: 'old-refresh',
        accessToken: 'old-access',
    };

    it('does not call the provider, however stale the token looks', async () => {
        // No `isTokenExpired.mockReturnValue(true)` here, and that absence is
        // the point: `auth.ts` no longer imports it, so arming it would be
        // decorative. The token is stale by its own `expiresAt` and nothing
        // looks at it.
        await runJwt({ token: { ...staleOauthToken } });

        expect(refreshGoogleToken).not.toHaveBeenCalled();
        expect(refreshMicrosoftToken).not.toHaveBeenCalled();
    });

    it('does not write the Account row', async () => {
        // The refresh's destination. A write here would mean the branch is
        // still running under another name.
        await runJwt({ token: { ...staleOauthToken } });

        expect(accountUpdateMany).not.toHaveBeenCalled();
    });

    it('never stamps RefreshTokenError, so a revoked grant is not a sign-out', async () => {
        // The user-facing half. A Google grant revoked in Google's own
        // settings used to land the person on /login, over a token no agrent
        // code read.
        const result = await runJwt({ token: { ...staleOauthToken } });

        expect(result.error).toBeUndefined();
    });

    // The "no credential on the token" assertion lives in the sign-in
    // describe below, on `persists the PROVIDER for an OAuth sign-in, and no
    // credential` — that is the seam that writes them, and it already has a
    // helper supplying a complete user. A second copy here used a bare
    // `{ id: 'u-1' }` and failed inside `applyMembershipClaims` on the
    // missing email, which is a worse test of the same thing.
});

describe('jwt callback — MFA challenge completion', () => {
    it('clears mfaPending once a challenge lands at or after the token was issued', async () => {
        // Break: comparing the wrong way would leave the user stuck on
        // the MFA screen forever after a correct code.
        const iat = 1_000_000;
        mfaFindUnique.mockResolvedValue({
            lastChallengeAt: new Date(iat * 1000),
            isVerified: true,
        });

        const result = await runJwt({
            token: { userId: 'u-1', tenantId: 't-1', mfaPending: true, iat },
        });

        expect(result.mfaPending).toBe(false);
    });

    it('keeps mfaPending when the only challenge predates the token', async () => {
        // Break: accepting a stale challenge would let a replayed old
        // verification satisfy MFA for a brand-new session.
        const iat = 1_000_000;
        mfaFindUnique.mockResolvedValue({
            lastChallengeAt: new Date((iat - 600) * 1000),
            isVerified: true,
        });

        const result = await runJwt({
            token: { userId: 'u-1', tenantId: 't-1', mfaPending: true, iat },
        });

        expect(result.mfaPending).toBe(true);
    });

    it('clears mfaPending on a lookup failure when the tenant fails open', async () => {
        // Break: failing closed for a fail-open tenant would lock every
        // user out during a DB blip.
        mfaFindUnique.mockRejectedValue(new Error('db down'));

        const result = await runJwt({
            token: {
                userId: 'u-1',
                tenantId: 't-1',
                mfaPending: true,
                mfaFailClosed: false,
                iat: 1_000_000,
            },
        });

        expect(result.mfaPending).toBe(false);
        expect(result.error).toBeUndefined();
    });

    it('holds the challenge and flags the dependency when the tenant fails closed', async () => {
        // Break: fail-closed tenants must NOT be waved through when the
        // MFA store is unreachable.
        mfaFindUnique.mockRejectedValue(new Error('db down'));

        const result = await runJwt({
            token: {
                userId: 'u-1',
                tenantId: 't-1',
                mfaPending: true,
                mfaFailClosed: true,
                iat: 1_000_000,
            },
        });

        expect(result.mfaPending).toBe(true);
        expect(result.error).toBe('MfaDependencyFailure');
    });
});

describe('jwt callback — MFA enforcement at sign-in', () => {
    const signIn = (overrides: Record<string, unknown> = {}) =>
        runJwt({
            token: { email: 'a@example.com' },
            user: { id: 'u-1', email: 'a@example.com' },
            account: { provider: 'credentials' },
            ...overrides,
        });

    beforeEach(() => {
        userFindUnique.mockResolvedValue({
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            emailVerified: new Date('2026-01-02T00:00:00.000Z'),
            id: 'u-1',
            sessionVersion: 1,
            uiLanguage: 'bg',
            tenantMemberships: [makeMembership(1)],
            orgMemberships: [],
        });
    });

    it('challenges every user when the tenant policy is REQUIRED', async () => {
        // Break: dropping the REQUIRED arm disables MFA tenant-wide.
        secSettingsFindUnique.mockResolvedValue({
            mfaPolicy: 'REQUIRED',
            mfaFailClosed: false,
        });

        const result = await signIn();

        expect(result.mfaPending).toBe(true);
    });

    it('challenges an enrolled user when the policy is OPTIONAL', async () => {
        // Break: not challenging someone who opted in silently
        // downgrades their account security.
        secSettingsFindUnique.mockResolvedValue({
            mfaPolicy: 'OPTIONAL',
            mfaFailClosed: false,
        });
        mfaFindUnique.mockResolvedValue({ isVerified: true });

        const result = await signIn();

        expect(result.mfaPending).toBe(true);
    });

    it('lets an unenrolled user straight in when the policy is OPTIONAL', async () => {
        // Break: challenging a user with no enrolment would lock them
        // out with no way to satisfy the prompt.
        secSettingsFindUnique.mockResolvedValue({
            mfaPolicy: 'OPTIONAL',
            mfaFailClosed: false,
        });
        mfaFindUnique.mockResolvedValue({ isVerified: false });

        const result = await signIn();

        expect(result.mfaPending).toBe(false);
    });

    it('does not challenge when no security settings row exists', async () => {
        // Break: defaulting to anything but DISABLED would challenge
        // every tenant that never configured MFA.
        secSettingsFindUnique.mockResolvedValue(null);

        const result = await signIn();

        expect(result.mfaPending).toBe(false);
    });

    it('challenges and flags the dependency when settings are unreadable and the tenant fails closed', async () => {
        // Break: waving users through when the policy store is down is
        // exactly what fail-closed exists to prevent.
        secSettingsFindUnique.mockImplementation(() => {
            throw new Error('db down');
        });

        const result = await signIn({
            token: { email: 'a@example.com', mfaFailClosed: true },
        });

        expect(result.mfaPending).toBe(true);
        expect(result.error).toBe('MfaDependencyFailure');
    });

    it('records an operational session row and stamps its id on the token', async () => {
        // Break: no session row means /admin/members cannot list or
        // revoke the session — Epic C.3's whole surface goes blind.
        secSettingsFindUnique.mockResolvedValue(null);
        recordNewSession.mockResolvedValue({ sessionId: 'sess-new' });

        const result = await signIn();

        expect(recordNewSession).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u-1', tenantId: 't-1' }),
        );
        expect(result.userSessionId).toBe('sess-new');
    });

    it('does not persist provider credentials for a credentials sign-in', async () => {
        // Break: stamping provider/accessToken for the credentials
        // provider would send the refresh path chasing a non-existent
        // OAuth grant on later requests.
        secSettingsFindUnique.mockResolvedValue(null);

        const result = await signIn();

        expect(result.provider).toBeUndefined();
        expect(result.accessToken).toBeUndefined();
    });

    it('persists the PROVIDER for an OAuth sign-in, and no credential', async () => {
        // This asserted the opposite until #1986, under "Break: dropping
        // these would make token refresh impossible." Dropping them is the
        // change: the proactive refresh is gone, so the only reader of a
        // cookie-borne access token is gone with it, and a refresh token in
        // every signed-in cookie was a credential at rest for nothing.
        //
        // `Account.access_token` / `refresh_token` still hold them. A caller
        // that needs one reads the row, which is authoritative where a JWT
        // snapshot is not.
        secSettingsFindUnique.mockResolvedValue(null);

        const result = await signIn({
            account: {
                provider: 'google',
                access_token: 'at-1',
                refresh_token: 'rt-1',
                expires_at: 4242,
            },
        });

        expect(result.provider).toBe('google');
        expect(result).not.toHaveProperty('accessToken');
        expect(result).not.toHaveProperty('refreshToken');
        expect(result).not.toHaveProperty('expiresAt');
        // Asserted on the VALUES too, so a future `accessToken: undefined`
        // write — which `not.toHaveProperty` would accept — still fails.
        expect(JSON.stringify(result)).not.toContain('at-1');
        expect(JSON.stringify(result)).not.toContain('rt-1');
    });

    it('redeems a pending invite before reading membership claims', async () => {
        // Break: reading claims first would miss the membership the
        // invite just created, stranding the invitee on /no-tenant —
        // the exact bug the jwt-callback redemption fixed.
        secSettingsFindUnique.mockResolvedValue(null);

        await signIn();

        expect(redeemPendingInvites).toHaveBeenCalledWith(
            expect.objectContaining({ userEmail: 'a@example.com' }),
        );
        const redeemOrder = redeemPendingInvites.mock.invocationCallOrder[0];
        const claimsOrder = userFindUnique.mock.invocationCallOrder[0];
        expect(redeemOrder).toBeLessThan(claimsOrder);
    });
});
