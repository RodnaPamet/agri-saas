/**
 * The Apple client-secret minter — #2075.
 *
 * ## Why this suite matters more than its size suggests
 *
 * This function had NO tests, and its own docblock names a failure mode that
 * is silent in the worst way:
 *
 *   > `crypto.sign` emits DER by default; a JWS ES256 signature is the raw
 *   > `r || s` pair (IEEE P1363). A DER signature is a perfectly well-formed
 *   > buffer, base64url-encodes cleanly, and produces a token Apple rejects
 *   > with `invalid_client` — which reads exactly like a wrong Key ID.
 *
 * So dropping `dsaEncoding` would pass every local check, mint a token that
 * looks right, and send whoever configured it hunting through the Apple
 * Developer portal for a Key ID that was correct all along.
 *
 * It is also now on the critical path for #1673: an iOS Hide My Email user
 * cannot reach their account from any browser, and the fix chosen on
 * 2026-10-20 is to configure the four `APPLE_*` vars — which activates this
 * code for the first time. Testing it is what makes that operator action
 * safe to take.
 *
 * ## No real key, and no secret in the repo
 *
 * The suite generates a throwaway P-256 key per run. A test that needed the
 * production `.p8` could not exist in a public repository, and one that
 * skipped without it would be the `a-control-that-cannot-express-failure`
 * shape — green for ever, by never running.
 */
import {
    createPublicKey,
    generateKeyPairSync,
    sign as cryptoSign,
    verify as cryptoVerify,
    type KeyObject,
} from 'node:crypto';

const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({
    get env() {
        return mockEnv;
    },
}));
const loggerError = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: { error: (...a: unknown[]) => loggerError(...a), warn: jest.fn(), info: jest.fn() },
}));

import { appleWebConfigured, mintAppleClientSecret } from '@/lib/auth/apple-client-secret';

/** A real EC P-256 key in PKCS#8 PEM — what an Apple `.p8` is. */
const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
}) as unknown as { privateKey: string };

const CONFIGURED = {
    APPLE_SERVICES_ID: 'bg.agrent.web',
    APPLE_TEAM_ID: 'TEAM123456',
    APPLE_KEY_ID: 'KEY7890AB',
    APPLE_PRIVATE_KEY: privateKey,
};

const configure = (over: Record<string, string | undefined> = {}) => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    Object.assign(mockEnv, CONFIGURED, over);
};

const parts = (jwt: string) => jwt.split('.');
const decode = (seg: string) =>
    JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

/**
 * Does this signature verify when read as `enc`?
 *
 * `verify` answers false for a signature it cannot parse, but for some inputs
 * it throws instead — and both answers mean the same thing here: not this
 * encoding. Collapsing them is what lets the assertions below read as a
 * straight true/false.
 */
const verifiesAs = (
    enc: 'ieee-p1363' | 'der',
    sig: Buffer,
    input: Buffer,
    key: KeyObject,
): boolean => {
    try {
        return cryptoVerify('sha256', input, { key, dsaEncoding: enc }, sig);
    } catch {
        return false;
    }
};

beforeEach(() => {
    jest.clearAllMocks();
    configure();
});

describe('appleWebConfigured', () => {
    it('is true only when ALL FOUR vars are present', () => {
        expect(appleWebConfigured()).toBe(true);
        // One at a time, because a check that happened to read only one of
        // them would pass a test that removed all four.
        for (const k of Object.keys(CONFIGURED)) {
            configure({ [k]: undefined });
            expect(appleWebConfigured()).toBe(false);
        }
    });
});

describe('mintAppleClientSecret', () => {
    it('returns null when Apple is not configured, rather than throwing', () => {
        // It runs at MODULE LOAD, so a throw would take the whole auth config
        // down and with it Google, Microsoft and the native Apple flow.
        configure({ APPLE_PRIVATE_KEY: undefined });
        expect(mintAppleClientSecret()).toBeNull();
    });

    it('signs with a RAW r||s signature, not DER — the silent failure', () => {
        const jwt = mintAppleClientSecret()!;
        expect(jwt).not.toBeNull();
        const [header, payload, encodedSig] = parts(jwt);
        const sig = Buffer.from(encodedSig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        const signingInput = Buffer.from(`${header}.${payload}`);
        const pub = createPublicKey(privateKey);

        // A P-256 JWS signature is exactly 64 bytes: r and s, 32 each.
        expect(sig).toHaveLength(64);

        // Then PROVE the encoding by verifying IN it, rather than inferring it
        // from a byte. This assertion used to read `expect(sig[0]).not
        // .toBe(0x30)` — the DER SEQUENCE tag — and the first byte of a raw
        // r||s signature is the top byte of `r`, which is uniformly random. So
        // a perfectly correct signature failed about 1 run in 256, and on
        // 2026-10-21 one of them reddened main (a5c5ba14d, shard 2/6) on a
        // commit that changed two lines of JSON. The old comment named that
        // exact case — "a tag check alone would admit a raw signature that
        // happened to start with 0x30" — and then used the tag as a NEGATIVE
        // assertion, which turns the case it identified into a flake.
        expect(verifiesAs('ieee-p1363', sig, signingInput, pub)).toBe(true);
        expect(verifiesAs('der', sig, signingInput, pub)).toBe(false);
    });

    it('control: the same check can TELL a DER signature apart', () => {
        // Without this, both assertions above would be satisfied by a `verify`
        // that always answered true for one encoding and false for the other,
        // whatever it was given — and the suite would be green about a property
        // it never tested. So: sign the same input as DER and require the
        // mirror image.
        const jwt = mintAppleClientSecret()!;
        const [header, payload] = parts(jwt);
        const signingInput = Buffer.from(`${header}.${payload}`);
        const pub = createPublicKey(privateKey);

        const der = cryptoSign('sha256', signingInput, {
            key: privateKey,
            dsaEncoding: 'der',
        });

        expect(verifiesAs('der', der, signingInput, pub)).toBe(true);
        expect(verifiesAs('ieee-p1363', der, signingInput, pub)).toBe(false);
        // And the length difference the old comment relied on is real — it is
        // just not sufficient on its own, which is why it is not the assertion.
        expect(der.length).not.toBe(64);
    });

    it('builds the header Apple requires', () => {
        const header = decode(parts(mintAppleClientSecret()!)[0]);
        expect(header).toEqual({ alg: 'ES256', kid: 'KEY7890AB' });
    });

    it('builds the payload Apple requires, with the SERVICES id as sub', () => {
        const now = new Date('2026-10-20T12:00:00.000Z');
        const p = decode(parts(mintAppleClientSecret(now)!)[1]);
        expect(p.iss).toBe('TEAM123456');
        // The web flow's audience is Apple's token endpoint, not the user —
        // and `sub` is the SERVICES id, not the bundle id, which is the
        // native flow's. Getting those two the wrong way round is another
        // `invalid_client` that reads like a bad key.
        expect(p.sub).toBe('bg.agrent.web');
        expect(p.aud).toBe('https://appleid.apple.com');
        expect(p.iat).toBe(Math.floor(now.getTime() / 1000));
    });

    it('expires inside Apple\'s 6-month ceiling', () => {
        const now = new Date('2026-10-20T12:00:00.000Z');
        const p = decode(parts(mintAppleClientSecret(now)!)[1]);
        const ttl = p.exp - p.iat;
        expect(ttl).toBeGreaterThan(0);
        // Apple's hard limit is 15777000s. A secret minted longer than that
        // is refused outright, and the refusal is the same `invalid_client`.
        expect(ttl).toBeLessThanOrEqual(15_777_000);
    });

    it('returns null and LOGS when the key will not load', () => {
        // Deliberately NOT a PEM-shaped fixture. `detect-secrets.sh` rejected
        // the first version of this line for carrying a private-key header,
        // and it was right to — a key marker in a committed file is exactly
        // what it exists to catch, and working around it would be defeating a
        // security check to make a test prettier. A non-PEM value reaches the
        // same `createPrivateKey` throw.
        configure({ APPLE_PRIVATE_KEY: 'this is not a key' });
        expect(mintAppleClientSecret()).toBeNull();
        // The log is the whole remedy here: web Apple sign-in simply stays
        // off, and without a line saying why, that is indistinguishable from
        // never having been configured.
        expect(loggerError).toHaveBeenCalledTimes(1);
        expect(loggerError.mock.calls[0][0]).toBe('apple-signin.client_secret_mint_failed');
        expect(String(loggerError.mock.calls[0][1].message)).toMatch(/PKCS#8 EC key/);
    });

    it('accepts a key whose newlines arrived escaped, as an env var carries them', () => {
        // The shape an operator actually pastes: a `.p8` in a single-line env
        // value with literal backslash-n. This is the case #1673's operator
        // action will hit first, and it would otherwise fail as "not a key".
        configure({ APPLE_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n') });
        const jwt = mintAppleClientSecret();
        expect(jwt).not.toBeNull();
        expect(parts(jwt!)).toHaveLength(3);
        expect(loggerError).not.toHaveBeenCalled();
    });
});
