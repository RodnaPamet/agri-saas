/**
 * Mint the `client_secret` Apple's token endpoint expects (P4.2, web flow).
 *
 * Apple is the one OAuth provider that issues no static secret. The
 * `client_secret` is a short-lived ES256 JWT you sign yourself with a
 * downloaded `.p8` key, so "configure Apple sign-in" means four values, not
 * two: the Services ID, the Team ID, the Key ID and the key itself.
 *
 * ## Why this is synchronous
 *
 * `authOptions` is a module-level const and NextAuth v4's provider config
 * takes `clientSecret` as a STRING — there is no async hook to mint one in.
 * Node can sign ES256 synchronously, so the secret is minted once at module
 * load. The expiry below is months, and this process restarts far more often
 * than that, so nothing has to refresh it in place.
 *
 * ## The signature format is the part that silently fails
 *
 * `crypto.sign` emits **DER** by default; a JWS ES256 signature is the raw
 * `r || s` pair (IEEE P1363). A DER signature is a perfectly well-formed
 * buffer, base64url-encodes cleanly, and produces a token Apple rejects with
 * `invalid_client` — which reads exactly like a wrong Key ID. Hence the
 * explicit `dsaEncoding`.
 */
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

/**
 * Apple's hard ceiling is 6 months (15777000s). Five is comfortably inside it
 * and leaves room for clock skew at both ends.
 */
const CLIENT_SECRET_TTL_SECONDS = 5 * 30 * 24 * 60 * 60;

/** Apple's token endpoint is the audience for the secret, not for the user. */
const APPLE_AUDIENCE = 'https://appleid.apple.com';

function b64url(input: Buffer | string): string {
    return Buffer.from(input)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * A `.p8` pasted into an env var usually arrives with its newlines escaped,
 * because a PEM is multi-line and `.env` is not. Both forms are accepted —
 * `createPrivateKey` rejects the escaped one with an unhelpful
 * "error:0909006C:PEM routines" that names nothing about newlines.
 */
function normalisePem(raw: string): string {
    return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

/**
 * The four values the web flow needs. Separate from
 * `appleSignInConfigured('native')`, which needs only the bundle id — the two
 * flows are configurable independently and the native one needs no key at all.
 */
export function appleWebConfigured(): boolean {
    return Boolean(
        env.APPLE_SERVICES_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY,
    );
}

/**
 * Returns the signed secret, or null when Apple is not configured or the key
 * will not load.
 *
 * Null rather than a throw: this runs at module load, and a malformed `.p8`
 * must not stop the application from starting with Google and Microsoft
 * working. It logs what is wrong, because the alternative — a registered
 * provider failing at the token exchange — is a button that spins and an
 * operator with nothing to read.
 */
export function mintAppleClientSecret(now = new Date()): string | null {
    if (!appleWebConfigured()) return null;

    const issuedAt = Math.floor(now.getTime() / 1000);
    const header = { alg: 'ES256', kid: env.APPLE_KEY_ID };
    const payload = {
        iss: env.APPLE_TEAM_ID,
        iat: issuedAt,
        exp: issuedAt + CLIENT_SECRET_TTL_SECONDS,
        aud: APPLE_AUDIENCE,
        // The SERVICES id, never the bundle id: this secret authenticates the
        // web client, and a bundle id here is `invalid_client`.
        sub: env.APPLE_SERVICES_ID,
    };

    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

    try {
        const key = createPrivateKey(normalisePem(env.APPLE_PRIVATE_KEY!));
        const signature = cryptoSign('sha256', Buffer.from(signingInput), {
            key,
            // See the file docblock — DER here is accepted by every local
            // check and refused by Apple.
            dsaEncoding: 'ieee-p1363',
        });
        return `${signingInput}.${b64url(signature)}`;
    } catch (err) {
        logger.error('apple-signin.client_secret_mint_failed', {
            component: 'apple-signin',
            error: err instanceof Error ? err.message : String(err),
            message:
                'APPLE_PRIVATE_KEY did not load as a PKCS#8 EC key. Sign in with Apple ' +
                'stays OFF for the web flow; Google, Microsoft and the native Apple ' +
                'flow are unaffected.',
        });
        return null;
    }
}
