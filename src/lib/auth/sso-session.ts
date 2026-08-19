/**
 * Mint the browser session cookie after a successful SSO assertion.
 *
 * ## Why this module exists
 *
 * Both SSO callbacks used to hand-roll the cookie:
 *
 * ```ts
 * const t = jwt.sign({ userId, email, tenantId, role, sub }, secret, …);
 * cookies().set(isProd ? '__Secure-authjs.session-token' : 'authjs.session-token', t);
 * ```
 *
 * Every part of that was wrong, and each part independently fatal:
 *
 *  1. **`jwt.sign` makes a JWS.** NextAuth v4 decodes a **JWE** via
 *     `jose.jwtDecrypt`. A JWS does not decrypt.
 *  2. **`authjs.session-token` is the NextAuth v5 name.** v4 reads
 *     `next-auth.session-token`.
 *  3. **The claim set was too thin.** Even decoded, the Edge tenant gate
 *     authorises purely by scanning `token.memberships[].slug`
 *     (`checkTenantAccess`). A token with `tenantId`/`role` but no
 *     `memberships` array yields `no_tenant_access` — the user lands on
 *     `/no-tenant` having just signed in successfully.
 *  4. **The secure prefix was chosen by `NODE_ENV`.** v4 chooses it from
 *     `NEXTAUTH_URL.startsWith('https://')`. A production deployment behind
 *     plain http, or a staging one on https, sets a cookie under one name
 *     and reads under the other.
 *
 * So fixing only the encoding, or only the cookie name, leaves SSO just as
 * broken. This module does all four, in one place, for both providers.
 *
 * ## The claims come from the SAME producer as a password sign-in
 *
 * `buildSessionClaims` is the function the native-token path already uses,
 * and it delegates to `applyMembershipClaims` — the single writer the `jwt`
 * callback uses. An SSO session therefore carries byte-identical claims to
 * any other, which is the only way to be sure a gate that passes for a
 * password user also passes for an SSO user. Hand-listing the claims here
 * would drift the first time someone adds one.
 *
 * ## The session is TRACKED
 *
 * `recordNewSession` is called, so an SSO session appears in
 * `/admin/members`, can be revoked, counts toward `maxConcurrentSessions`
 * and honours `sessionMaxAgeMinutes`. Previously it existed only as a
 * cookie: invisible to the admin UI and impossible to revoke.
 *
 * Note a fabricated `userSessionId` would NOT have worked as a shortcut —
 * `verifyAndTouchSession` returns `revoked: false` for an unknown id, so a
 * made-up value is inert rather than fail-closed.
 */
import { cookies } from 'next/headers';
import { encode } from 'next-auth/jwt';
import { env } from '@/env';
import { buildSessionClaims } from '@/auth';
import { recordNewSession } from '@/lib/security/session-tracker';
import { logger } from '@/lib/observability/logger';

/** v4's own session lifetime default; `recordNewSession` may cap it lower. */
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Whether v4 would use the `__Secure-` prefix.
 *
 * Derived from `NEXTAUTH_URL` exactly as `next-auth/jwt` and
 * `core/lib/cookie.js` do — NOT from `NODE_ENV`. The reader and the writer
 * have to agree, and only one of them is ours.
 */
export function useSecureCookies(): boolean {
    const url = env.NEXTAUTH_URL ?? env.AUTH_URL ?? '';
    return url.startsWith('https://');
}

/** The cookie name v4 will look for. */
export function sessionCookieName(): string {
    return useSecureCookies()
        ? '__Secure-next-auth.session-token'
        : 'next-auth.session-token';
}

export interface EstablishSessionInput {
    userId: string;
    /** The tenant the assertion was for; the session stays on it when valid. */
    tenantId: string | null;
    /** For the audit trail on the session row, e.g. `sso-saml-<providerId>`. */
    provider: string;
}

/**
 * Record a tracked session and set the cookie NextAuth v4 will read.
 *
 * Returns false when the claims cannot be built (no persisted user), so the
 * caller can fail the sign-in loudly rather than redirecting to a dashboard
 * the user will be bounced off.
 */
export async function establishSsoSession(input: EstablishSessionInput): Promise<boolean> {
    const recorded = await recordNewSession({
        userId: input.userId,
        tenantId: input.tenantId,
        expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000),
    });

    const claims = await buildSessionClaims({
        userId: input.userId,
        tenantId: input.tenantId,
        userSessionId: recorded.sessionId,
    });

    if (!claims) {
        logger.error('sso: could not build session claims', {
            component: 'auth',
            provider: input.provider,
            userId: input.userId,
        });
        return false;
    }

    const secret = env.AUTH_SECRET;
    if (!secret) {
        logger.error('sso: no AUTH_SECRET to encode a session', { component: 'auth' });
        return false;
    }

    // `encode` is v4's own minting primitive: it adds iat/exp/jti and
    // JWE-encrypts with HKDF over the same secret `getToken` decrypts with.
    const sessionToken = await encode({
        token: claims,
        secret,
        maxAge: SESSION_MAX_AGE_SECONDS,
    });

    const secure = useSecureCookies();
    const store = await cookies();
    store.set(sessionCookieName(), sessionToken, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return true;
}
