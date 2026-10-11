/**
 * A native session cannot skip the farm's second factor.
 *
 * ## What was wrong
 *
 * `buildSessionClaims` — the function the native exchange, the Apple route
 * and every token refresh go through, and whose own comment calls it "the
 * single producer" of claims — set `termsPending` and never `mfaPending`.
 * Both gates that read that claim test `=== true`, so an ABSENT claim passed
 * both. `/api/auth/native/complete` minted an auth code with no check at
 * all, and the middleware's MFA gate cannot see it: `/api/auth/*` is a public
 * path that returns early, and the gate only covers tenant and person paths.
 *
 * So a native sign-in produced a full-access session with no second factor
 * even under a REQUIRED policy, while the web asked the same person for a
 * code.
 *
 * ## Why these tests are at these two points
 *
 * The gate belongs where the browser cookie is still authoritative — at
 * auth-code issuance — because that is the only place it can both be
 * enforced and CLEARED. Applying it to freshly-minted claims instead would
 * compare the enrollment's `lastChallengeAt` against a brand-new `iat` that
 * is always later, so the claim could never clear and every refresh would
 * re-challenge. A lockout rather than a gate, which is the reverse failure
 * and the one agrent-ios first described.
 *
 * The Apple route is separate because it has no browser sheet to type a code
 * into, so it refuses instead.
 */
const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({
    getToken: (...a: unknown[]) => getToken(...a),
    encode: jest.fn(async () => 'encoded'),
}));

const issueAuthCode = jest.fn();
// Spread the real module: it also exports `HANDOFF_COOKIE` and
// `classifyRedirect`, which the route needs. Replacing the whole barrel with
// one function is the partial-mock trap.
jest.mock('@/lib/auth/native/auth-codes', () => ({
    ...jest.requireActual<Record<string, unknown>>('@/lib/auth/native/auth-codes'),
    issueAuthCode: (...a: unknown[]) => issueAuthCode(...a),
}));

const findUniqueSession = jest.fn();
const findUniqueSecurity = jest.fn();
const findUniqueEnrollment = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        userSession: { findUnique: (...a: unknown[]) => findUniqueSession(...a) },
        tenantSecuritySettings: { findUnique: (...a: unknown[]) => findUniqueSecurity(...a) },
        userMfaEnrollment: { findUnique: (...a: unknown[]) => findUniqueEnrollment(...a) },
    },
    prisma: {
        userSession: { findUnique: (...a: unknown[]) => findUniqueSession(...a) },
        tenantSecuritySettings: { findUnique: (...a: unknown[]) => findUniqueSecurity(...a) },
        userMfaEnrollment: { findUnique: (...a: unknown[]) => findUniqueEnrollment(...a) },
    },
}));

// Spread the real module: a PARTIAL barrel mock here throws
// `extractErrorMeta is not a function` from `errors/api.ts` the moment any
// handler takes its error path, which is most of what this file tests.
jest.mock('@/lib/observability/logger', () => ({
    ...jest.requireActual<Record<string, unknown>>('@/lib/observability/logger'),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { resolveMfaRequirement } from '@/lib/auth/mfa-requirement';

const LIVE_SESSION = {
    id: 'row-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
};

beforeEach(() => {
    jest.clearAllMocks();
    // Without this the route refuses every redirect as unconfigured, long
    // before the MFA gate — and the test would pass for the wrong reason.
    process.env.NATIVE_AUTH_REDIRECT_ALLOWLIST = 'agrent://auth';
    findUniqueSession.mockResolvedValue(LIVE_SESSION);
    issueAuthCode.mockResolvedValue('the-code');
});

describe('resolveMfaRequirement — one producer for the requirement', () => {
    it.each([
        ['REQUIRED with no enrollment', 'REQUIRED', null, true],
        ['REQUIRED with a verified enrollment', 'REQUIRED', { isVerified: true }, true],
        ['OPTIONAL with a verified enrollment', 'OPTIONAL', { isVerified: true }, true],
        ['OPTIONAL with an UNverified enrollment', 'OPTIONAL', { isVerified: false }, false],
        ['OPTIONAL with no enrollment at all', 'OPTIONAL', null, false],
        ['DISABLED', 'DISABLED', { isVerified: true }, false],
    ])('%s -> required=%s', async (_label, mfaPolicy, enrollment, expected) => {
        findUniqueSecurity.mockResolvedValue({ mfaPolicy, mfaFailClosed: false });
        findUniqueEnrollment.mockResolvedValue(enrollment);
        const r = await resolveMfaRequirement({ userId: 'user-1', tenantId: 'tenant-1' });
        expect(r.required).toBe(expected);
        expect(r.dependencyFailure).toBe(false);
    });

    it('OPTIONAL obliges nothing until the user has verified an authenticator', async () => {
        // The rule that stops turning the policy on from locking people out.
        findUniqueSecurity.mockResolvedValue({ mfaPolicy: 'OPTIONAL', mfaFailClosed: false });
        findUniqueEnrollment.mockResolvedValue({ isVerified: false });
        expect(
            (await resolveMfaRequirement({ userId: 'user-1', tenantId: 'tenant-1' })).required,
        ).toBe(false);
    });

    it.each([
        ['REQUIRED + enrolled    -> owed, and collectable', 'REQUIRED', { isVerified: true }, true, true],
        ['REQUIRED + NOT enrolled -> owed, NOT collectable', 'REQUIRED', null, true, false],
        ['OPTIONAL + enrolled    -> owed', 'OPTIONAL', { isVerified: true }, true, true],
        ['OPTIONAL + unverified  -> not owed', 'OPTIONAL', { isVerified: false }, false, false],
        ['DISABLED               -> not owed', 'DISABLED', { isVerified: true }, false, false],
    ])('%s', async (_label, mfaPolicy, enrollment, required, enrolled) => {
        // The three states, not two. `required` alone cannot tell a farm that
        // wants a code from a farm that wants one the person cannot produce:
        // REQUIRED with no verified authenticator owes a factor that has no
        // shared secret to verify against. A challenge screen there asks for
        // a code from an app the person never set up; the remedy is enrolment
        // on the web, which is a different sentence and so a different code.
        findUniqueSecurity.mockResolvedValue({ mfaPolicy, mfaFailClosed: false });
        findUniqueEnrollment.mockResolvedValue(enrollment);
        const r = await resolveMfaRequirement({ userId: 'user-1', tenantId: 'tenant-1' });
        expect({ required: r.required, enrolled: r.enrolled }).toEqual({ required, enrolled });
    });

    it('DISABLED does not read the enrolment at all', async () => {
        // The common path for every farm that has not turned MFA on. Nothing
        // downstream can act on `enrolled` when nothing is owed, so the read
        // would be pure cost on the hot path.
        findUniqueSecurity.mockResolvedValue({ mfaPolicy: 'DISABLED', mfaFailClosed: false });
        await resolveMfaRequirement({ userId: 'user-1', tenantId: 'tenant-1' });
        expect(findUniqueEnrollment).not.toHaveBeenCalled();
    });

    it('a tenantless session owes nothing — MFA is enrolled per tenant', async () => {
        const r = await resolveMfaRequirement({ userId: 'user-1', tenantId: null });
        expect(r).toEqual({
            required: false,
            failClosed: false,
            dependencyFailure: false,
            // `enrolled` joined the shape with the Apple challenge work: a
            // REQUIRED tenant whose user never enrolled owes a factor that
            // cannot be COLLECTED, which is a third state a caller has to
            // tell apart from the other two. False here — no tenant, so no
            // enrolment to find and no read to do.
            enrolled: false,
        });
        // And it must not have asked the database at all.
        expect(findUniqueSecurity).not.toHaveBeenCalled();
    });

    it('reports a dependency failure rather than guessing', async () => {
        findUniqueSecurity.mockRejectedValue(new Error('connection reset'));
        const r = await resolveMfaRequirement({ userId: 'user-1', tenantId: 'tenant-1' });
        expect(r.dependencyFailure).toBe(true);
        // NOT folded into `required`: the caller decides which way it falls,
        // and "we could not find out" is different from "this user owes one".
        expect(r.required).toBe(false);
    });
});

describe('/api/auth/native/complete — no code while a factor is owed', () => {
    // The PKCE challenge and redirect URI travel in an HttpOnly cookie that
    // `/start` sets — NOT in the query string. Getting that wrong is what the
    // first version of these tests did, and it produced a 500 that looked
    // like the gate failing rather than the fixture being wrong.
    const call = async () => {
        const { GET } = await import('@/app/api/auth/native/complete/route');
        const { HANDOFF_COOKIE } = await import('@/lib/auth/native/auth-codes');
        const { NextRequest } = await import('next/server');
        const req = new NextRequest('https://app.example.test/api/auth/native/complete');
        req.cookies.set(
            HANDOFF_COOKIE,
            JSON.stringify({ redirectUri: 'agrent://auth', codeChallenge: 'abc' }),
        );
        return GET(req, { params: Promise.resolve({}) } as never);
    };

    it('does NOT issue a code when the cookie session is mfaPending', async () => {
        getToken.mockResolvedValue({
            userSessionId: 'sess-1',
            userId: 'user-1',
            tenantId: 'tenant-1',
            tenantSlug: 'my-farm',
            mfaPending: true,
        });

        const res = await call();

        // The assertion that matters: no code exists to be exchanged.
        expect(issueAuthCode).not.toHaveBeenCalled();
        expect([302, 307, 403]).toContain(res.status);
    });

    it('sends the browser to the challenge, carrying the full original url', async () => {
        getToken.mockResolvedValue({
            userSessionId: 'sess-1',
            userId: 'user-1',
            tenantId: 'tenant-1',
            tenantSlug: 'my-farm',
            mfaPending: true,
        });

        const res = await call();
        expect(res.status).toBe(307);
        const location = res.headers.get('location') ?? '';
        expect(location).toContain('/t/my-farm/auth/mfa');
        // `next` returns them to this route; the handoff cookie carries the
        // PKCE challenge and redirect URI by itself.
        const next = new URL(location, 'https://app.example.test').searchParams.get('next') ?? '';
        expect(next).toBe('/api/auth/native/complete');
    });

    it('refuses rather than falling through when there is no slug to send them to', async () => {
        getToken.mockResolvedValue({
            userSessionId: 'sess-1',
            userId: 'user-1',
            tenantId: 'tenant-1',
            mfaPending: true,
        });

        const res = await call();
        expect(issueAuthCode).not.toHaveBeenCalled();
        expect(res.status).toBe(403);
    });

    it('issues a code once the factor is satisfied', async () => {
        // Positive control. Without this the tests above are satisfied by a
        // route that never issues a code at all.
        getToken.mockResolvedValue({
            userSessionId: 'sess-1',
            userId: 'user-1',
            tenantId: 'tenant-1',
            tenantSlug: 'my-farm',
            mfaPending: false,
        });

        await call();
        expect(issueAuthCode).toHaveBeenCalledTimes(1);
    });

    it('issues a code when no MFA policy applies and the claim is absent', async () => {
        // The ordinary case for a farm with MFA off: the cookie carries no
        // `mfaPending` at all. It must not be mistaken for a pending factor,
        // or every native sign-in on every farm breaks.
        getToken.mockResolvedValue({
            userSessionId: 'sess-1',
            userId: 'user-1',
            tenantId: 'tenant-1',
            tenantSlug: 'my-farm',
        });

        await call();
        expect(issueAuthCode).toHaveBeenCalledTimes(1);
    });
});
