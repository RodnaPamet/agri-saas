/**
 * P1.5 — `getUserCtx` REFUSES the three callers that must not get a person.
 *
 * Each refusal exists because the gate that would otherwise catch it does not
 * reach person-scoped paths:
 *
 *   - MFA: `src/middleware.ts`'s gate is wrapped in `isTenantPath(pathname)`,
 *     so it never fires for `/api/me/`, `/api/social/`, `/account/` or
 *     `/onboarding/`. Until P1.6 adds that parity, this check is the only thing
 *     between a half-authenticated session and a person's own data.
 *   - Operator: the middleware's MECHANISATOR lockdown keys on the tenant slug
 *     in the URL. A person-scoped path has no slug, so that lockdown cannot
 *     fire here at all.
 *   - API key: a key is a tenant-scoped machine credential with no person
 *     behind it, so there is no correct userId to put in a UserContext.
 *
 * So these are not belt-and-braces duplicates of a middleware rule — they are
 * the only enforcement on these paths today, which is why each gets a test that
 * fails loudly rather than a shared "it refuses bad callers" case.
 */
import { NextRequest } from 'next/server';
import { API_KEY_PREFIX } from '@/lib/auth/api-key-token';

const getSessionOrThrow = jest.fn();
const findMany = jest.fn();
const mergeRequestContext = jest.fn();

jest.mock('@/lib/auth', () => ({ getSessionOrThrow: () => getSessionOrThrow() }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { tenantMembership: { findMany: (...a: unknown[]) => findMany(...a) } },
}));
jest.mock('@/lib/observability/context', () => ({
    mergeRequestContext: (...a: unknown[]) => mergeRequestContext(...a),
    getRequestContext: () => undefined,
}));

import { getUserCtx } from '@/app-layer/context';

/** A well-formed key token, built from the real prefix constant. */
const API_KEY = `${API_KEY_PREFIX}${'a'.repeat(48)}`; // pragma: allowlist secret -- test fixture

/**
 * P1.6 made the PATH part of the contract: `getUserCtx` derives the person
 * surface from it, and the operator refusal fires only on the social half. So
 * a case that is about the operator rule has to say which surface it means.
 */
const ACCOUNT_PATH = '/api/me/profile';
const SOCIAL_PATH = '/api/social/feed';

function req(
    headers: Record<string, string> = {},
    pathname: string = ACCOUNT_PATH,
): NextRequest {
    const h = new Headers();
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    const url = new URL(`http://localhost:3000${pathname}`);
    return { method: 'GET', headers: h, nextUrl: url, url: url.toString() } as unknown as NextRequest;
}

const SESSION = { userId: 'u-1', tenantId: '', email: 'p@example.test', role: 'READER' as const };

beforeEach(() => {
    jest.clearAllMocks();
    getSessionOrThrow.mockResolvedValue(SESSION);
    findMany.mockResolvedValue([]); // no memberships — the onboarding case
});

describe('the happy path, so the refusals below are not vacuous', () => {
    it('resolves a person with NO tenant, role or permissions', async () => {
        const ctx = await getUserCtx(req());
        expect(ctx.userId).toBe('u-1');
        expect(ctx.email).toBe('p@example.test');
        expect(ctx.requestId).toBeTruthy();
        // The absence IS the contract. `toEqual` over the exact key set rather
        // than three `toBeUndefined()` calls, because a later addition of a
        // `tenantId` field would pass those and fail this.
        expect(Object.keys(ctx).sort()).toEqual(['email', 'requestId', 'userId']);
    });

    it('enriches the log context with the user and NOT a tenant', async () => {
        await getUserCtx(req());
        expect(mergeRequestContext).toHaveBeenCalledWith({ userId: 'u-1' });
    });

    it('honours an inbound x-request-id', async () => {
        const ctx = await getUserCtx(req({ 'x-request-id': 'rid-7' }));
        expect(ctx.requestId).toBe('rid-7');
    });
});

describe('refusal 1 — API keys', () => {
    it('refuses a bearer API key with 403', async () => {
        await expect(getUserCtx(req({ authorization: `Bearer ${API_KEY}` }))).rejects.toMatchObject({
            status: 403,
            // A CODE, not prose. Pinned because the downward copy ratchet in
            // `tests/guards/no-server-authored-user-copy.test.ts` exempts codes
            // and counts prose, and a later "friendlier message" here would
            // break that guard rather than this one.
            message: 'API_KEY_NOT_PERSON_SCOPED',
        });
    });

    it('refuses BEFORE resolving a session — the key is not answered as the cookie user', async () => {
        // The ordering property. If the session were resolved first, a request
        // carrying both a key and a cookie would be served as the cookie's
        // person, which is the wrong principal rather than an error.
        await expect(getUserCtx(req({ authorization: `Bearer ${API_KEY}` }))).rejects.toBeDefined();
        expect(getSessionOrThrow).not.toHaveBeenCalled();
    });

    it('does NOT refuse an ordinary bearer that is not a key', async () => {
        // Precision: without this, a rule of "any Authorization header is
        // refused" would satisfy the two cases above and break every other
        // bearer-carrying caller.
        await expect(getUserCtx(req({ authorization: 'Bearer some-jwt-value' }))).resolves.toMatchObject({
            userId: 'u-1',
        });
    });
});

describe('refusal 2 — MFA-pending sessions', () => {
    it('refuses when the session has not cleared its second factor', async () => {
        getSessionOrThrow.mockResolvedValue({ ...SESSION, mfaPending: true });
        await expect(getUserCtx(req())).rejects.toMatchObject({
            status: 403,
            message: 'MFA_REQUIRED',
        });
    });

    it('allows when mfaPending is explicitly false, and when it is absent', async () => {
        // Absent matters: the legacy-cookie path predates MFA and carries no
        // flag. Treating undefined as pending would lock out every legacy
        // session; treating it as cleared is what the middleware does with the
        // same value, so the two agree.
        getSessionOrThrow.mockResolvedValue({ ...SESSION, mfaPending: false });
        await expect(getUserCtx(req())).resolves.toMatchObject({ userId: 'u-1' });
        getSessionOrThrow.mockResolvedValue({ ...SESSION });
        await expect(getUserCtx(req())).resolves.toMatchObject({ userId: 'u-1' });
    });

    it('refuses only on the boolean true, not on any truthy value', async () => {
        // `=== true` rather than truthiness: a serialised `"false"` from a JWT
        // round-trip is truthy, and refusing on it would lock out cleared
        // sessions. Pinned because the obvious simplification breaks it.
        getSessionOrThrow.mockResolvedValue({ ...SESSION, mfaPending: 'false' });
        await expect(getUserCtx(req())).resolves.toMatchObject({ userId: 'u-1' });
    });
});

describe('refusal 3 — operator-only users', () => {
    it('refuses a user whose every active membership is MECHANISATOR', async () => {
        findMany.mockResolvedValue([{ role: 'MECHANISATOR' }, { role: 'MECHANISATOR' }]);
        // SOCIAL path: P1.6 narrowed this refusal to the social half, because
        // the lockdown keeps a field device off the FARM's data, not off the
        // person's own identity — blocking `/account/` would mean a field
        // operator could never change their own password.
        await expect(getUserCtx(req({}, SOCIAL_PATH))).rejects.toMatchObject({
            status: 403,
            // ALL-CAPS, and that case is load-bearing: the copy ratchet
            // counts `operator_scope` as prose (two latin words) and exempts an
            // ALL-CAPS identifier as a code. All three refusals use codes for
            // the same reason.
            message: 'OPERATOR_SCOPE',
        });
    });

    it('ALLOWS a user with no memberships at all', async () => {
        // `[].every(...)` is `true`, so without the length guard this user —
        // someone mid-onboarding who has not joined a farm — reads as
        // operator-only and is refused from the surface built for them. Every
        // test with a seeded membership would stay green.
        findMany.mockResolvedValue([]);
        await expect(getUserCtx(req({}, SOCIAL_PATH))).resolves.toMatchObject({ userId: 'u-1' });
    });

    it('ALLOWS a user who is an operator at one farm and something else at another', async () => {
        findMany.mockResolvedValue([{ role: 'MECHANISATOR' }, { role: 'EDITOR' }]);
        await expect(getUserCtx(req({}, SOCIAL_PATH))).resolves.toMatchObject({ userId: 'u-1' });
    });

    it('ALLOWS an operator-only user on an ACCOUNT surface — P1.6', async () => {
        // The narrowing itself, asserted rather than assumed. Same token that
        // is refused on the social path above.
        findMany.mockResolvedValue([{ role: 'MECHANISATOR' }, { role: 'MECHANISATOR' }]);
        await expect(getUserCtx(req({}, ACCOUNT_PATH))).resolves.toMatchObject({ userId: 'u-1' });
    });

    it('does not even ASK the database on an account surface', async () => {
        // The query is skipped, not merely ignored. A version that queried and
        // then discarded the answer would pass the case above while still
        // paying for it on every person-scoped request.
        findMany.mockResolvedValue([{ role: 'MECHANISATOR' }]);
        await getUserCtx(req({}, ACCOUNT_PATH));
        expect(findMany).not.toHaveBeenCalled();
    });

    it('an explicit opts.surface overrides the path', async () => {
        // The escape hatch for a caller with no request — a server component.
        findMany.mockResolvedValue([{ role: 'MECHANISATOR' }]);
        await expect(
            getUserCtx(req({}, ACCOUNT_PATH), { surface: 'social' }),
        ).rejects.toMatchObject({ status: 403 });
    });

    it('asks the DATABASE, scoped to active memberships of live tenants', async () => {
        // The JWT's `memberships` array is capped at MAX_JWT_MEMBERSHIPS with a
        // truncation flag, so "every entry is MECHANISATOR" over a truncated
        // list can be true while the user holds a non-operator membership past
        // the cap — and the failure direction is locking a legitimate user out.
        // This pins that the decision does not read the capped list.
        await getUserCtx(req({}, SOCIAL_PATH));
        expect(findMany).toHaveBeenCalledWith({
            where: { userId: 'u-1', status: 'ACTIVE', tenant: { deletedAt: null } },
            select: { role: true },
        });
    });
});
