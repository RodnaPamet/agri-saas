/**
 * Binds a tenant SSO sign-in (OIDC or SAML) to the browser that started it
 * (#3205).
 *
 * ## What was wrong
 *
 * The OIDC `state` and the SAML `RelayState` were base64url JSON carrying
 * `{ tenantSlug, providerId, codeVerifier, nonce, returnTo }` in the clear,
 * unsigned, and tied to nothing in the browser. Three consequences:
 *
 *   - **Login CSRF.** An attacker could complete the IdP leg with their own
 *     account and hand a victim the callback URL; the victim's browser was
 *     then signed in as the attacker.
 *   - **PKCE and the nonce checked nothing.** The verifier and the nonce
 *     travelled inside the state, so the callback compared the state with
 *     itself, and anyone holding the redirect URL held the verifier too.
 *   - **Open redirect.** `returnTo` was taken from the start URL and handed to
 *     `new URL(returnTo, baseUrl)`, which honours `//evil.example`.
 *
 * ## The shape now
 *
 * The value sent through the IdP is a RANDOM token and nothing else. Everything
 * the callback needs sits in an HttpOnly cookie set by the start route,
 * HMAC-signed with a key derived from `AUTH_SECRET`, carrying that same token
 * and an expiry. The callback accepts the flow only when the cookie verifies,
 * has not expired, and names the token the IdP sent back — so a callback URL
 * is useless in any browser but the one that started the flow, and the PKCE
 * verifier never appears in a URL. The cookie is cleared on the callback,
 * which makes a flow single-use from the browser's side.
 *
 * Signed rather than stored server-side (the `GoogleOAuthState` pattern) to
 * avoid a schema change for a value that lives ten minutes; the binding to the
 * browser is the property that matters, and a signed HttpOnly cookie gives it.
 *
 * `returnTo` is reduced to a same-origin relative path at BOTH ends, by
 * {@link safeReturnTo}, so neither a crafted start URL nor a cookie from an
 * older build can redirect off-site.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

import { env } from '@/env';

/** Name of the binding cookie. One flow at a time per browser: a second
 *  sign-in started in another tab replaces the first, which then fails
 *  cleanly at its callback rather than signing in the wrong flow. */
export const SSO_FLOW_COOKIE = 'agrent_sso_flow';

/** Scoped to the SSO routes, so the cookie rides no other request. */
export const SSO_FLOW_COOKIE_PATH = '/api/auth/sso';

/** Ten minutes: long enough for an IdP login with a second factor. */
export const SSO_FLOW_TTL_SECONDS = 600;

interface Sealed<T> {
    s: string; // the token sent through the IdP
    e: number; // expiry, epoch seconds
    p: T; // the flow payload
}

function key(): Buffer {
    const secret = env.AUTH_SECRET;
    if (!secret) throw new Error('AUTH_SECRET is required to bind an SSO flow');
    // Domain-separated, so this MAC can never be confused with any other use
    // of the same secret.
    return createHmac('sha256', secret).update('agrent/sso-flow-binding/v1').digest();
}

function mac(body: string): string {
    return createHmac('sha256', key()).update(body).digest('base64url');
}

function equal(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Seal a flow. Returns the token to send through the IdP as `state` /
 * `RelayState`, and the cookie value to set.
 */
export function sealSsoFlow<T>(payload: T, nowSeconds = Math.floor(Date.now() / 1000)): {
    state: string;
    cookie: string;
} {
    const state = randomBytes(32).toString('base64url');
    const sealed: Sealed<T> = { s: state, e: nowSeconds + SSO_FLOW_TTL_SECONDS, p: payload };
    const body = Buffer.from(JSON.stringify(sealed)).toString('base64url');
    return { state, cookie: `${body}.${mac(body)}` };
}

/**
 * Open a flow at the callback. Null — never a partial payload — unless the
 * cookie is present, its MAC verifies, it has not expired, and it names the
 * token the IdP returned.
 */
export function openSsoFlow<T>(
    cookie: string | null | undefined,
    returnedState: string | null | undefined,
    nowSeconds = Math.floor(Date.now() / 1000),
): T | null {
    if (!cookie || !returnedState) return null;
    const dot = cookie.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = cookie.slice(0, dot);
    const tag = cookie.slice(dot + 1);
    if (!equal(tag, mac(body))) return null;
    let sealed: Sealed<T>;
    try {
        sealed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Sealed<T>;
    } catch {
        return null;
    }
    if (typeof sealed?.s !== 'string' || typeof sealed.e !== 'number') return null;
    if (sealed.e < nowSeconds) return null;
    if (!equal(sealed.s, returnedState)) return null;
    return sealed.p;
}

/**
 * A same-origin RELATIVE path, or null. Refuses anything a browser could
 * resolve to another origin: protocol-relative `//host`, a backslash form
 * (`/\host`, which browsers normalise to `//host`), an absolute URL, or a
 * control character.
 */
export function safeReturnTo(raw: string | null | undefined): string | null {
    if (!raw || typeof raw !== 'string') return null;
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
    for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return null; // a control character
    }
    const probe = 'https://same-origin.invalid';
    try {
        const resolved = new URL(raw, probe);
        if (resolved.origin !== probe) return null;
        return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    } catch {
        return null;
    }
}

/**
 * Cookie attributes for the binding cookie. The SAML callback is a
 * CROSS-SITE POST from the IdP, on which browsers withhold a `SameSite=Lax`
 * cookie, so SAML needs `None` — which browsers accept only with `Secure`.
 * Without HTTPS (local development) it falls back to `Lax`, and a SAML
 * POST-binding callback is then refused there rather than accepted unbound.
 * OIDC's callback is a top-level GET redirect, which carries `Lax`.
 */
export function ssoFlowCookieOptions(opts: { crossSitePost: boolean; secure: boolean }) {
    return {
        httpOnly: true,
        secure: opts.secure,
        sameSite: (opts.crossSitePost && opts.secure ? 'none' : 'lax') as 'none' | 'lax',
        path: SSO_FLOW_COOKIE_PATH,
        maxAge: SSO_FLOW_TTL_SECONDS,
    };
}

/** Attributes that expire the binding cookie (same path, so it matches). */
export const SSO_FLOW_COOKIE_CLEAR = {
    httpOnly: true,
    path: SSO_FLOW_COOKIE_PATH,
    maxAge: 0,
} as const;
