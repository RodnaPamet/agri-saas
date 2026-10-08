/**
 * `POST /api/auth/native/apple` — the sign-in itself (P4.2).
 *
 * The token verification has its own 14 tests
 * (`tests/unit/apple-sign-in.test.ts`) and is mocked here. What this file
 * covers is everything the ROUTE decides, which is where a verified token can
 * still end up attached to the wrong person — or to a second copy of the right
 * one.
 *
 * ## It runs against the real database on purpose
 *
 * The new logic is `resolveAppleUser`: find by Apple's `sub`, link by email,
 * create otherwise, and let a unique index settle a race. All four are
 * statements about what the DATABASE does, and a mocked Prisma would assert
 * the order of calls I happened to write rather than the outcome.
 */
const verifyAppleIdentityToken = jest.fn();
jest.mock('@/lib/auth/apple', () => ({
    verifyAppleIdentityToken: (...a: unknown[]) => verifyAppleIdentityToken(...a),
}));

const issueRefreshToken = jest.fn();
jest.mock('@/lib/auth/native/refresh-tokens', () => ({
    ...jest.requireActual('@/lib/auth/native/refresh-tokens'),
    issueRefreshToken: (...a: unknown[]) => issueRefreshToken(...a),
}));

const recordNewSession = jest.fn();
jest.mock('@/lib/security/session-tracker', () => ({
    ...jest.requireActual('@/lib/security/session-tracker'),
    recordNewSession: (...a: unknown[]) => recordNewSession(...a),
}));

const redeemPendingInvites = jest.fn();
jest.mock('@/lib/auth/invite-redemption', () => ({
    redeemPendingInvites: (...a: unknown[]) => redeemPendingInvites(...a),
}));

const encode = jest.fn();
jest.mock('next-auth/jwt', () => ({ encode: (...a: unknown[]) => encode(...a) }));

import { randomUUID } from 'node:crypto';

import { NextRequest } from 'next/server';

import { POST } from '@/app/api/auth/native/apple/route';
import { hashForLookup } from '@/lib/security/encryption';
import prisma from '@/lib/prisma';

const madeUsers: string[] = [];

function post(body: unknown): Promise<Response> {
    const req = new NextRequest('http://localhost/api/auth/native/apple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify(body),
    });
    return POST(req as never, {} as never) as Promise<Response>;
}

function identity(over: Record<string, unknown> = {}) {
    return {
        appleUserId: `apple-sub-${randomUUID()}`,
        email: `apple-${randomUUID()}@privaterelay.appleid.test`,
        emailVerified: true,
        isPrivateRelay: true,
        ...over,
    };
}

const VALID_BODY = { identityToken: 'signed.apple.token', nonce: 'the-raw-nonce' };

beforeEach(() => {
    jest.clearAllMocks();
    recordNewSession.mockResolvedValue({ sessionId: 'sess-ext', rowId: 'sess-row' });
    issueRefreshToken.mockResolvedValue({
        raw: 'refresh-raw',
        expiresAt: new Date('2026-12-01T00:00:00Z'),
    });
    encode.mockResolvedValue('encoded-access-token');
    redeemPendingInvites.mockResolvedValue(undefined);
});

afterAll(async () => {
    if (madeUsers.length) {
        await prisma.account.deleteMany({ where: { userId: { in: madeUsers } } });
        await prisma.user.deleteMany({ where: { id: { in: madeUsers } } });
    }
});

/** Track whatever user the route created, so afterAll can remove it. */
async function trackBySub(appleUserId: string): Promise<string | null> {
    const row = await prisma.account.findUnique({
        where: { provider_providerAccountId: { provider: 'apple', providerAccountId: appleUserId } },
        select: { userId: true },
    });
    if (row) madeUsers.push(row.userId);
    return row?.userId ?? null;
}

describe('§1 a token that does not verify gets ONE answer', () => {
    it.each(['bad_token', 'bad_nonce', 'nonce_replayed'] as const)(
        '%s → 400 invalid_grant',
        async (reason) => {
            // Five distinguishable failures collapsed to one. Telling them
            // apart tells somebody probing which check defeated them.
            verifyAppleIdentityToken.mockResolvedValue({ ok: false, reason });
            const res = await post(VALID_BODY);
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: 'invalid_grant' });
        },
    );

    it('mints nothing when verification fails', async () => {
        verifyAppleIdentityToken.mockResolvedValue({ ok: false, reason: 'bad_nonce' });
        await post(VALID_BODY);
        expect(recordNewSession).not.toHaveBeenCalled();
        expect(issueRefreshToken).not.toHaveBeenCalled();
        expect(encode).not.toHaveBeenCalled();
    });

    it.each([
        ['no identityToken', { nonce: 'n' }],
        ['no nonce', { identityToken: 't' }],
        ['empty strings', { identityToken: '', nonce: '' }],
        ['wrong types', { identityToken: 42, nonce: {} }],
    ])('%s → 400 without even calling the verifier', async (_label, body) => {
        const res = await post(body);
        expect(res.status).toBe(400);
        expect(verifyAppleIdentityToken).not.toHaveBeenCalled();
    });
});

describe('§2 "not configured" is the one answer that is NOT collapsed', () => {
    it('503 apple_sign_in_disabled', async () => {
        // Decided before the token is examined, so it reveals nothing about
        // it — and an operator who has pasted three of four values needs to
        // tell this apart from a bad token.
        verifyAppleIdentityToken.mockResolvedValue({ ok: false, reason: 'not_configured' });
        const res = await post(VALID_BODY);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'apple_sign_in_disabled' });
    });
});

describe('§3 the lookup is by Apple sub FIRST', () => {
    it('a returning user signs in with NO email in the token', async () => {
        // The assertion that matters most. Apple sends `email` only on the
        // FIRST authorisation; a route that resolved by email would fail every
        // subsequent sign-in, or worse, create a second user each time.
        const id = identity();
        verifyAppleIdentityToken.mockResolvedValue({ ok: true, identity: id });
        const first = await post(VALID_BODY);
        expect(first.status).toBe(200);
        const userId = await trackBySub(id.appleUserId);
        expect(userId).toBeTruthy();

        verifyAppleIdentityToken.mockResolvedValue({
            ok: true,
            identity: { ...id, email: null },
        });
        const second = await post(VALID_BODY);
        expect(second.status).toBe(200);

        // Exactly one user, and the same one.
        const accounts = await prisma.account.findMany({
            where: { provider: 'apple', providerAccountId: id.appleUserId },
        });
        expect(accounts).toHaveLength(1);
        expect(accounts[0].userId).toBe(userId);
    });

    it('a FIRST authorisation with no email is refused, not guessed', async () => {
        verifyAppleIdentityToken.mockResolvedValue({
            ok: true,
            identity: identity({ email: null }),
        });
        const res = await post(VALID_BODY);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'email_required' });
        expect(recordNewSession).not.toHaveBeenCalled();
    });
});

describe('§4 an existing user is LINKED, never duplicated', () => {
    it('links the Apple account to a user who signed up another way', async () => {
        const email = `existing-${randomUUID()}@example.test`;
        const existing = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email), acceptedTermsAt: new Date() },
            select: { id: true },
        });
        madeUsers.push(existing.id);

        const id = identity({ email });
        verifyAppleIdentityToken.mockResolvedValue({ ok: true, identity: id });
        const res = await post(VALID_BODY);
        expect(res.status).toBe(200);

        const linked = await prisma.account.findUnique({
            where: {
                provider_providerAccountId: {
                    provider: 'apple',
                    providerAccountId: id.appleUserId,
                },
            },
            select: { userId: true },
        });
        expect(linked?.userId).toBe(existing.id);

        // And no second user for that address.
        const users = await prisma.user.findMany({
            where: { emailHash: hashForLookup(email) },
            select: { id: true },
        });
        expect(users).toHaveLength(1);
    });
});

describe('§5 a new user is created UNCONSENTED, and told so', () => {
    it('acceptedTermsAt is null and the response says termsPending', async () => {
        // There is no browser in this flow, so nothing showed the terms. The
        // Edge gate asks; stamping consent here would file an agreement
        // nobody gave.
        const id = identity();
        verifyAppleIdentityToken.mockResolvedValue({ ok: true, identity: id });
        const res = await post(VALID_BODY);
        expect(res.status).toBe(200);

        const userId = await trackBySub(id.appleUserId);
        const row = await prisma.user.findUnique({
            where: { id: userId! },
            select: { acceptedTermsAt: true, emailVerified: true },
        });
        expect(row?.acceptedTermsAt).toBeNull();
        // Apple asserted it and the signature proved Apple said so.
        expect(row?.emailVerified).toBeInstanceOf(Date);

        // Surfaced in the body so the app presents the terms rather than
        // discovering the hold as a 403 on its first real call.
        expect((await res.json()).termsPending).toBe(true);
    });

    it('an unverified Apple email does not become a verified user', async () => {
        const id = identity({ emailVerified: false });
        verifyAppleIdentityToken.mockResolvedValue({ ok: true, identity: id });
        await post(VALID_BODY);
        const userId = await trackBySub(id.appleUserId);
        const row = await prisma.user.findUnique({
            where: { id: userId! },
            select: { emailVerified: true },
        });
        expect(row?.emailVerified).toBeNull();
    });
});

describe('§6 the token pair', () => {
    it('is bound to the session row that was just recorded', async () => {
        const id = identity();
        verifyAppleIdentityToken.mockResolvedValue({ ok: true, identity: id });
        const res = await post(VALID_BODY);
        await trackBySub(id.appleUserId);

        expect(issueRefreshToken).toHaveBeenCalledWith(
            expect.objectContaining({ userSessionRowId: 'sess-row' }),
        );
        const body = await res.json();
        expect(body).toMatchObject({
            accessToken: 'encoded-access-token', // pragma: allowlist secret -- the mocked `encode` return value
            refreshToken: 'refresh-raw',
            tokenType: 'Bearer',
        });
    });

    it('encodes claims from the PRODUCER, never from the request body', async () => {
        // A caller-supplied role or tenant would be a privilege escalation
        // with a valid Apple token as its only cost.
        const id = identity();
        verifyAppleIdentityToken.mockResolvedValue({ ok: true, identity: id });
        await post({ ...VALID_BODY, role: 'OWNER', tenantId: 'someone-elses-tenant' });
        await trackBySub(id.appleUserId);

        const claims = encode.mock.calls[0][0].token;
        expect(claims.role).not.toBe('OWNER');
        expect(claims.tenantId).not.toBe('someone-elses-tenant');
        // And it IS the real claim set, not an empty object that would
        // satisfy the two assertions above.
        expect(claims.userId).toBeTruthy();
        expect(claims.userSessionId).toBe('sess-ext');
    });

    it('honours an invite with Apple’s OWN email_verified, not a bare true', async () => {
        const id = identity({ emailVerified: false });
        verifyAppleIdentityToken.mockResolvedValue({ ok: true, identity: id });
        await post(VALID_BODY);
        await trackBySub(id.appleUserId);

        expect(redeemPendingInvites).toHaveBeenCalledWith(
            expect.objectContaining({ emailVerifiedByIdp: false }),
        );
    });
});
