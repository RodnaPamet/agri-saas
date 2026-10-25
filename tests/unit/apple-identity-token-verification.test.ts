/**
 * The REAL `jose` verifies a REAL signed token (#1697).
 *
 * ## The gap this closes
 *
 * `jose` decides who an Apple Sign In user IS, at exactly one call site —
 * `jwtVerify(identityToken, appleKeys(), { issuer, audience })` in
 * `lib/auth/apple.ts`. And every test that reached it mocked it away:
 * `apple-sign-in.test.ts` does `jest.mock('jose', …)` and
 * `apple-native-route.test.ts` mocks `@/lib/auth/apple` wholesale. E2E has no
 * Apple path either — it cannot, since Apple's authorisation flow needs Apple.
 *
 * So nothing in the repo exercised the library that performs the identity
 * check, and a major-version bump to it (dependabot #1694, `jose` 4 → 6) had
 * no signal but a coincidence.
 *
 * ## What is mocked, and the line matters
 *
 * ONLY `createRemoteJWKSet` — the network fetch of Apple's public keys — is
 * replaced, with a local key set built from a pair generated here.
 * **`jwtVerify` is the real one**, so signature checking, `issuer`, `audience`
 * and `exp` are enforced by the actual library against an actual token.
 *
 * Mocking `jwtVerify` instead would be the existing situation with extra
 * steps: a test that proves the code calls a function, not that the function
 * refuses anything.
 *
 * ## The REJECTIONS are the point
 *
 * A bump that broke verification outright would surface as "nobody can sign in
 * with Apple" — loud, and someone would notice within a day. A bump that
 * LOOSENED a check surfaces as nothing at all, which is the direction worth
 * testing. So every one of the guards `apple.ts` relies on gets a case that
 * must FAIL: wrong audience, wrong issuer, expired, unsigned, signed by a
 * stranger's key.
 *
 * A happy-path-only test would survive every loosening this exists to catch —
 * `a-control-that-cannot-express-failure`.
 *
 * ## Why `reason` is always `bad_token`
 *
 * `apple.ts` collapses every verification failure into one reason
 * deliberately: "a bad signature, a wrong audience, an expired token and a
 * malformed one are all 'this token is not acceptable', and telling them apart
 * would help somebody probing which of the four they got wrong." So these
 * cases assert the REFUSAL, and the distinctions live in which input produced
 * it rather than in the answer.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
    SignJWT,
    exportJWK,
    generateKeyPair,
    createLocalJWKSet,
    type JSONWebKeySet,
} from 'jose';

/**
 * The private-key type, DERIVED from the function that produces it rather than
 * imported by name.
 *
 * `jose` exported that type in its 4.x line and removed it in 6.x, which is the
 * single error blocking #1694 — a security-relevant bump of NextAuth's JWT
 * dependency, held up for two weeks by one type import in one test file.
 *
 * Deriving it fixes that in a way that cannot recur: this resolves to whatever
 * `generateKeyPair` returns in the INSTALLED version, so it is correct on 4.x
 * and on 6.x with no conditional, and it cannot drift from the function's real
 * return type the way a separately-imported name can.
 */
type GeneratedPrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

const APPLE_ISSUER = 'https://appleid.apple.com';
const BUNDLE_ID = 'bg.agrent.app.test';

/** Built in `beforeAll`; the mock closes over this box so it can be late-bound. */
const keys: { set?: ReturnType<typeof createLocalJWKSet> } = {};

jest.mock('jose', () => {
    const actual = jest.requireActual('jose');
    return {
        ...actual,
        // ONLY the network fetch. `jwtVerify` stays real — that is the subject.
        createRemoteJWKSet: () => (...args: unknown[]) =>
            (keys.set as unknown as (...a: unknown[]) => unknown)(...args),
    };
});

// The nonce claim is a database write and not what this file is about. Mocked
// to succeed so a verification result is reached; replay is covered elsewhere.
const nonceCreate = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { appleSignInNonce: { create: (...a: unknown[]) => nonceCreate(...a) } },
    prisma: { appleSignInNonce: { create: (...a: unknown[]) => nonceCreate(...a) } },
}));

jest.mock('@/env', () => ({
    env: { APPLE_BUNDLE_ID: 'bg.agrent.app.test', APPLE_SERVICES_ID: 'bg.agrent.web.test' },
}));

let privateKey: GeneratedPrivateKey;
let strangerKey: GeneratedPrivateKey;

/** Mint a token the way Apple would, with each claim overridable. */
async function mintToken(over: {
    iss?: string;
    aud?: string;
    sub?: string;
    nonce?: string;
    expSeconds?: number;
    key?: GeneratedPrivateKey;
    unsigned?: boolean;
} = {}): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
        nonce: over.nonce ?? 'unset',
        email: 'farmer@privaterelay.appleid.com',
        email_verified: 'true',
    };
    const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: over.unsigned ? 'none' : 'RS256' })
        .setIssuer(over.iss ?? APPLE_ISSUER)
        .setAudience(over.aud ?? BUNDLE_ID)
        .setSubject(over.sub ?? '000123.abcdef.0001')
        .setIssuedAt(nowSec - 10)
        .setExpirationTime(nowSec + (over.expSeconds ?? 600));
    return jwt.sign(over.key ?? privateKey);
}

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

beforeAll(async () => {
    const apple = await generateKeyPair('RS256');
    const stranger = await generateKeyPair('RS256');
    privateKey = apple.privateKey;
    strangerKey = stranger.privateKey;

    const jwk = await exportJWK(apple.publicKey);
    jwk.kid = 'apple-test-key';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    keys.set = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
});

beforeEach(() => {
    jest.clearAllMocks();
    nonceCreate.mockResolvedValue({});
});

describe('Apple identity-token verification, through the real jose (#1697)', () => {
    it('accepts a correctly signed token and returns the subject', async () => {
        const { verifyAppleIdentityToken } = await import('@/lib/auth/apple');
        const rawNonce = randomUUID();
        const token = await mintToken({ nonce: sha256Hex(rawNonce) });

        const result = await verifyAppleIdentityToken({
            identityToken: token, rawNonce, flow: 'native',
        });

        expect(result).toMatchObject({
            ok: true,
            identity: { appleUserId: '000123.abcdef.0001' },
        });
    });

    // ── the rejections, which are the point ─────────────────────────────
    it('REFUSES a token for a different audience', async () => {
        // The check that keeps a token minted for somebody else's app from
        // signing a person into this one.
        const { verifyAppleIdentityToken } = await import('@/lib/auth/apple');
        const rawNonce = randomUUID();
        const token = await mintToken({ aud: 'com.someone.else', nonce: sha256Hex(rawNonce) });

        await expect(
            verifyAppleIdentityToken({ identityToken: token, rawNonce, flow: 'native' }),
        ).resolves.toEqual({ ok: false, reason: 'bad_token' });
    });

    it('REFUSES a token from a different issuer', async () => {
        const { verifyAppleIdentityToken } = await import('@/lib/auth/apple');
        const rawNonce = randomUUID();
        const token = await mintToken({ iss: 'https://evil.example', nonce: sha256Hex(rawNonce) });

        await expect(
            verifyAppleIdentityToken({ identityToken: token, rawNonce, flow: 'native' }),
        ).resolves.toEqual({ ok: false, reason: 'bad_token' });
    });

    it('REFUSES an expired token', async () => {
        const { verifyAppleIdentityToken } = await import('@/lib/auth/apple');
        const rawNonce = randomUUID();
        const token = await mintToken({ expSeconds: -60, nonce: sha256Hex(rawNonce) });

        await expect(
            verifyAppleIdentityToken({ identityToken: token, rawNonce, flow: 'native' }),
        ).resolves.toEqual({ ok: false, reason: 'bad_token' });
    });

    it('REFUSES a token signed by a key Apple does not publish', async () => {
        // The signature check itself. If this ever passes, anybody who can
        // reach the endpoint can mint an identity.
        const { verifyAppleIdentityToken } = await import('@/lib/auth/apple');
        const rawNonce = randomUUID();
        const token = await mintToken({ key: strangerKey, nonce: sha256Hex(rawNonce) });

        await expect(
            verifyAppleIdentityToken({ identityToken: token, rawNonce, flow: 'native' }),
        ).resolves.toEqual({ ok: false, reason: 'bad_token' });
    });

    it('REFUSES a malformed token', async () => {
        const { verifyAppleIdentityToken } = await import('@/lib/auth/apple');
        await expect(
            verifyAppleIdentityToken({
                identityToken: 'not.a.jwt', rawNonce: randomUUID(), flow: 'native',
            }),
        ).resolves.toEqual({ ok: false, reason: 'bad_token' });
    });

    // ── the nonce, which jose does NOT check ────────────────────────────
    it('REFUSES a token whose nonce is not this request’s', async () => {
        // `jose` has no opinion about `nonce`; apple.ts compares it to
        // SHA-256(rawNonce) itself. So a VALID token replayed against a
        // different request must still be refused, and by a different reason.
        const { verifyAppleIdentityToken } = await import('@/lib/auth/apple');
        const token = await mintToken({ nonce: sha256Hex('a-different-request') });

        await expect(
            verifyAppleIdentityToken({
                identityToken: token, rawNonce: randomUUID(), flow: 'native',
            }),
        ).resolves.toEqual({ ok: false, reason: 'bad_nonce' });
    });

    it('REFUSES a token carrying no nonce at all', async () => {
        const { verifyAppleIdentityToken } = await import('@/lib/auth/apple');
        const token = await mintToken({ nonce: undefined });
        await expect(
            verifyAppleIdentityToken({
                identityToken: token, rawNonce: randomUUID(), flow: 'native',
            }),
        ).resolves.toMatchObject({ ok: false, reason: 'bad_nonce' });
    });

    it('REFUSES a replayed nonce — P2002 is the claim failing', async () => {
        const { verifyAppleIdentityToken } = await import('@/lib/auth/apple');
        const rawNonce = randomUUID();
        const token = await mintToken({ nonce: sha256Hex(rawNonce) });
        nonceCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));

        await expect(
            verifyAppleIdentityToken({ identityToken: token, rawNonce, flow: 'native' }),
        ).resolves.toEqual({ ok: false, reason: 'nonce_replayed' });
    });

    // ── the web flow uses a DIFFERENT audience ──────────────────────────
    it('the web flow accepts the Services ID and refuses the bundle id', async () => {
        // #1673's fix put the browser through this same call site, so the two
        // audiences must not be interchangeable.
        const { verifyAppleIdentityToken } = await import('@/lib/auth/apple');
        const rawNonce = randomUUID();

        const web = await mintToken({ aud: 'bg.agrent.web.test', nonce: sha256Hex(rawNonce) });
        await expect(
            verifyAppleIdentityToken({ identityToken: web, rawNonce, flow: 'web' }),
        ).resolves.toMatchObject({ ok: true });

        const native = await mintToken({ aud: BUNDLE_ID, nonce: sha256Hex(rawNonce) });
        await expect(
            verifyAppleIdentityToken({ identityToken: native, rawNonce, flow: 'web' }),
        ).resolves.toEqual({ ok: false, reason: 'bad_token' });
    });

    it('the harness can actually sign and verify — positive control', async () => {
        // `a-probe-with-no-discriminating-power`: if the local key set did not
        // resolve, EVERY case above would refuse and the file would read as
        // thorough while proving only that nothing verifies. The happy path is
        // that control, and this states it as one rather than leaving it
        // implicit among the rejections.
        const { verifyAppleIdentityToken } = await import('@/lib/auth/apple');
        const rawNonce = randomUUID();
        const good = await mintToken({ nonce: sha256Hex(rawNonce) });
        const bad = await mintToken({ key: strangerKey, nonce: sha256Hex(rawNonce) });

        const a = await verifyAppleIdentityToken({ identityToken: good, rawNonce, flow: 'native' });
        const b = await verifyAppleIdentityToken({ identityToken: bad, rawNonce, flow: 'native' });
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(false);
    });
});
