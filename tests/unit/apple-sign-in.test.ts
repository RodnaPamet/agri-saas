/**
 * Sign in with Apple — the four properties that make it safe (P4.2).
 *
 * P4's hardening list names one of these explicitly ("a replayed Sign in with
 * Apple nonce is rejected"); the other three are the ones that would let a
 * token be accepted where it should not be.
 *
 * ## Why these are unit tests against a mocked JWKS
 *
 * The signature check itself is `jose`'s, verified against Apple's published
 * keys, and testing that would be testing `jose`. What is OURS, and what can
 * be got wrong in ways no library catches, is everything around it: which
 * audience is required for which flow, that the nonce is bound to the request,
 * and that a token cannot be presented twice. Those are what this file pins.
 *
 * The replay test deliberately runs against the REAL database, because the
 * claim is a unique-index insert and a mocked Prisma would prove nothing about
 * it — the whole point of doing it that way is that the database, not the
 * application, is what refuses the second attempt.
 */
const mockJwtVerify = jest.fn();
jest.mock('jose', () => ({
    createRemoteJWKSet: jest.fn(() => 'JWKS'),
    jwtVerify: (...a: unknown[]) => mockJwtVerify(...a),
}));

import { createHash, randomUUID } from 'node:crypto';

import {
    verifyAppleIdentityToken,
    appleSignInConfigured,
    hashNonce,
    sweepExpiredAppleNonces,
    APPLE_NONCE_TTL_MS,
} from '@/lib/auth/apple';
import prisma from '@/lib/prisma';

const BUNDLE = 'bg.agrent.app';
const SERVICES = 'bg.agrent.web';

function payloadFor(rawNonce: string, over: Record<string, unknown> = {}) {
    return {
        sub: 'apple-user-123',
        nonce: createHash('sha256').update(rawNonce).digest('hex'),
        email: 'ivan@privaterelay.appleid.com',
        email_verified: 'true',
        is_private_email: 'true',
        ...over,
    };
}

const ENV = { ...process.env };
beforeEach(() => {
    jest.clearAllMocks();
    process.env.APPLE_BUNDLE_ID = BUNDLE;
    process.env.APPLE_SERVICES_ID = SERVICES;
});
afterAll(() => {
    process.env = ENV;
});

describe('it is DORMANT until an audience is configured', () => {
    it('refuses with not_configured, and does not call the verifier', async () => {
        delete process.env.APPLE_BUNDLE_ID;
        jest.resetModules();
        const { verifyAppleIdentityToken: fn } = await import('@/lib/auth/apple');
        const r = await fn({ identityToken: 't', rawNonce: 'n', flow: 'native' });
        expect(r).toEqual({ ok: false, reason: 'not_configured' });
        // The point of checking explicitly rather than letting the framework
        // fail: an unconfigured feature must not reach the network and come
        // back with an opaque error that reads as a broken button.
        expect(mockJwtVerify).not.toHaveBeenCalled();
    });
});

describe('the audience is flow-specific', () => {
    it('native requires the BUNDLE id', async () => {
        const raw = randomUUID();
        mockJwtVerify.mockResolvedValue({ payload: payloadFor(raw) });
        await verifyAppleIdentityToken({ identityToken: 't', rawNonce: raw, flow: 'native' });
        expect(mockJwtVerify.mock.calls[0][2]).toMatchObject({ audience: BUNDLE });
    });

    it('web requires the SERVICES id', async () => {
        // Not cosmetic. An identity token minted for the app carries the
        // bundle id; one minted for the web flow carries the Services id.
        // Accepting either on both paths would let a token obtained through
        // one be replayed at the other.
        const raw = randomUUID();
        mockJwtVerify.mockResolvedValue({ payload: payloadFor(raw) });
        await verifyAppleIdentityToken({ identityToken: 't', rawNonce: raw, flow: 'web' });
        expect(mockJwtVerify.mock.calls[0][2]).toMatchObject({ audience: SERVICES });
    });

    it('always pins the issuer to Apple', async () => {
        const raw = randomUUID();
        mockJwtVerify.mockResolvedValue({ payload: payloadFor(raw) });
        await verifyAppleIdentityToken({ identityToken: 't', rawNonce: raw, flow: 'native' });
        expect(mockJwtVerify.mock.calls[0][2]).toMatchObject({
            issuer: 'https://appleid.apple.com',
        });
    });
});

describe('the nonce binds the token to THIS request', () => {
    it('refuses when the token carries a different nonce', async () => {
        mockJwtVerify.mockResolvedValue({ payload: payloadFor('a-different-nonce') });
        const r = await verifyAppleIdentityToken({
            identityToken: 't',
            rawNonce: randomUUID(),
            flow: 'native',
        });
        expect(r).toEqual({ ok: false, reason: 'bad_nonce' });
    });

    it('refuses when the token carries NO nonce', async () => {
        // An absent nonce must not read as a match. This is the case a
        // `payload.nonce === hash` comparison gets right only by accident of
        // `undefined !== string`, so it is worth pinning.
        const raw = randomUUID();
        mockJwtVerify.mockResolvedValue({ payload: payloadFor(raw, { nonce: undefined }) });
        const r = await verifyAppleIdentityToken({ identityToken: 't', rawNonce: raw, flow: 'native' });
        expect(r).toEqual({ ok: false, reason: 'bad_nonce' });
    });

    it('every verification failure answers the SAME reason', async () => {
        // A bad signature, a wrong audience, an expired token and a malformed
        // one are all "not acceptable". Telling them apart would help somebody
        // probing which of the four they got wrong.
        mockJwtVerify.mockRejectedValue(new Error('signature verification failed'));
        const a = await verifyAppleIdentityToken({ identityToken: 't', rawNonce: 'n', flow: 'native' });
        mockJwtVerify.mockRejectedValue(new Error('unexpected "aud" claim value'));
        const b = await verifyAppleIdentityToken({ identityToken: 't', rawNonce: 'n', flow: 'native' });
        expect(a).toEqual(b);
        expect(a).toEqual({ ok: false, reason: 'bad_token' });
    });
});

describe('a nonce is single-use — the replay refusal P4 asks for', () => {
    const made: string[] = [];
    afterAll(async () => {
        if (made.length) {
            await prisma.appleSignInNonce.deleteMany({ where: { nonceHash: { in: made } } });
        }
    });

    it('accepts once and refuses the identical token the second time', async () => {
        const raw = randomUUID();
        made.push(hashNonce(raw));
        mockJwtVerify.mockResolvedValue({ payload: payloadFor(raw) });

        const first = await verifyAppleIdentityToken({
            identityToken: 'the-same-token',
            rawNonce: raw,
            flow: 'native',
        });
        expect(first.ok).toBe(true);

        // Byte-identical replay — a token stolen in transit and presented
        // again. The signature is still valid and the nonce still matches;
        // the DATABASE is what refuses it.
        const second = await verifyAppleIdentityToken({
            identityToken: 'the-same-token',
            rawNonce: raw,
            flow: 'native',
        });
        expect(second).toEqual({ ok: false, reason: 'nonce_replayed' });
    });

    it('two CONCURRENT presentations: exactly one wins', async () => {
        // The reason the claim is an INSERT against a unique index rather than
        // a read-then-write. A read-then-write races itself, and both callers
        // see "unused" before either writes.
        const raw = randomUUID();
        made.push(hashNonce(raw));
        mockJwtVerify.mockResolvedValue({ payload: payloadFor(raw) });

        const results = await Promise.all([
            verifyAppleIdentityToken({ identityToken: 't', rawNonce: raw, flow: 'native' }),
            verifyAppleIdentityToken({ identityToken: 't', rawNonce: raw, flow: 'native' }),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toHaveLength(1);
    });

    it('a DIFFERENT nonce is unaffected — the control', async () => {
        // Without this, a claim that refused everything would satisfy both
        // tests above and make Apple sign-in impossible.
        const raw = randomUUID();
        made.push(hashNonce(raw));
        mockJwtVerify.mockResolvedValue({ payload: payloadFor(raw) });
        const r = await verifyAppleIdentityToken({ identityToken: 't', rawNonce: raw, flow: 'native' });
        expect(r.ok).toBe(true);
    });
});

describe('the identity it returns', () => {
    it('carries the stable sub, never an email as the id', async () => {
        const raw = randomUUID();
        mockJwtVerify.mockResolvedValue({ payload: payloadFor(raw) });
        const r = await verifyAppleIdentityToken({ identityToken: 't', rawNonce: raw, flow: 'native' });
        expect(r.ok && r.identity.appleUserId).toBe('apple-user-123');
        expect(r.ok && r.identity.isPrivateRelay).toBe(true);
        await prisma.appleSignInNonce.deleteMany({ where: { nonceHash: hashNonce(raw) } });
    });

    it('a missing email is NULL — Apple sends it only on first authorisation', async () => {
        // The trap for any caller: absence means "I already know this person",
        // not "this account has no email". Treating it as the latter would
        // create a second user on every subsequent sign-in.
        const raw = randomUUID();
        mockJwtVerify.mockResolvedValue({ payload: payloadFor(raw, { email: undefined }) });
        const r = await verifyAppleIdentityToken({ identityToken: 't', rawNonce: raw, flow: 'native' });
        expect(r.ok && r.identity.email).toBeNull();
        await prisma.appleSignInNonce.deleteMany({ where: { nonceHash: hashNonce(raw) } });
    });
});

describe('housekeeping', () => {
    it('the sweep removes expired nonces and spares live ones', async () => {
        const stale = `stale-${randomUUID()}`;
        const fresh = `fresh-${randomUUID()}`;
        await prisma.appleSignInNonce.createMany({
            data: [
                { nonceHash: stale, expiresAt: new Date(Date.now() - 1000) },
                { nonceHash: fresh, expiresAt: new Date(Date.now() + APPLE_NONCE_TTL_MS) },
            ],
        });
        await sweepExpiredAppleNonces();
        expect(await prisma.appleSignInNonce.count({ where: { nonceHash: stale } })).toBe(0);
        expect(await prisma.appleSignInNonce.count({ where: { nonceHash: fresh } })).toBe(1);
        await prisma.appleSignInNonce.deleteMany({ where: { nonceHash: fresh } });
    });

    it('expiry is housekeeping, not the defence', () => {
        // A stale row refuses a replay exactly as well as a fresh one — the
        // unique index does that work. If somebody later "optimises" by
        // sweeping aggressively, nothing about replay safety changes.
        expect(APPLE_NONCE_TTL_MS).toBeGreaterThan(0);
    });
});
