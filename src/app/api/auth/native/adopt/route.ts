/**
 * GET /api/auth/native/adopt — turn a native bearer into a WEBVIEW session.
 *
 * WHY THIS EXISTS — the shipped native auth solves the adjacent problem.
 *
 * #601 and #603 built a complete native flow: system-browser OAuth, a PKCE-bound
 * single-use code, and an access/refresh token pair. That authenticates a native
 * client calling `/api/t/**` as an API.
 *
 * A Capacitor shell in `server.url` mode is not that. Every screen is a
 * SERVER-RENDERED PAGE fetched by a WKWebView, and those are authenticated by
 * COOKIE: `getServerSession()` reads `sessionStore.value` and never consults the
 * header (`next-auth/core/routes/session.js:43`). A WKWebView cannot attach an
 * `Authorization` header to top-level navigations, and `ASWebAuthenticationSession`
 * writes its cookies into SAFARI's jar, not the app's `WKWebsiteDataStore`.
 *
 * So after a flawless run of the shipped flow the native layer holds a valid
 * bearer and the webview is still logged out. This route closes that.
 *
 * ── How the shell uses it, and why it is a GET ──
 *
 * Only the webview can put a cookie in its own store, and it does so by making
 * the request itself. So the shell performs ONE authenticated navigation:
 *
 *     var req = URLRequest(url: …/api/auth/native/adopt)
 *     req.setValue("Bearer \\(accessToken)", forHTTPHeaderField: "Authorization")
 *     webView.load(req)          // WKWebView DOES send custom headers on the
 *                                // initial top-level request
 *
 * We answer `Set-Cookie` + 302, the webview follows it, and every subsequent
 * navigation is an ordinary cookie session. WKWebView drops custom headers on
 * redirects and later navigations — which is fine, because by then the cookie
 * is doing the work.
 *
 * This is why there is no ticket, no nonce table, and no credential in a URL.
 * A `?token=` query parameter would land in webview history and in any access
 * log between here and the client.
 *
 * ── The cookie REUSES the bearer's session row ──
 *
 * `establishSsoSession()` is the other server-side cookie minter, and it always
 * calls `recordNewSession`. This route deliberately does NOT: it rebuilds claims
 * against the SAME `userSessionId` the bearer already carries.
 *
 * That is the whole point. One sign-in must be one `UserSession` row, so an
 * admin revoking that session kills the webview and the native client together.
 * Minting a second row would leave a shell whose webview stayed logged in after
 * its bearer was revoked — a revocation control that silently covers half the
 * app.
 *
 * ── What it is NOT ──
 *
 * It does not accept the access token as a cookie directly. That token is
 * byte-compatible with a session cookie (same `encode`, same secret), so
 * injecting it into `WKHTTPCookieStore` looks like a shortcut — but it carries a
 * 15-minute TTL with no in-webview refresh path, so the shell would log itself
 * out every fifteen minutes in the field. This mints a cookie at the real
 * session lifetime instead.
 */
import { NextRequest, NextResponse } from 'next/server';
import { encode } from 'next-auth/jwt';
import { cookies } from 'next/headers';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { withApiErrorHandling } from '@/lib/errors/api';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { buildSessionClaims } from '@/auth';
import { resolveBearerToken } from '@/lib/auth/native/bearer-principal';
import { SESSION_MAX_AGE_SECONDS } from '@/lib/auth/session-lifetime';
// The cookie NAME and the Secure prefix are derived by sso-session exactly as
// next-auth derives them — from NEXTAUTH_URL, not NODE_ENV. Reusing its two
// helpers rather than restating the rule is the point: the reader of this
// cookie is next-auth, and only the writer is ours.
import { sessionCookieName, useSecureCookies } from '@/lib/auth/sso-session';

export const runtime = 'nodejs';

/**
 * Where to land after adopting. Same-origin PATHS only.
 *
 * `next=//evil.example` and `next=https://evil.example` are both rejected: the
 * first is a protocol-relative URL that most naive checks let through, and this
 * route is reached with a valid credential, so an open redirect here would be a
 * genuine token-leak vector rather than a cosmetic one.
 */
function safeNext(raw: string | null): string {
    if (!raw) return '/';
    if (!raw.startsWith('/')) return '/';
    if (raw.startsWith('//')) return '/';
    return raw;
}

async function handleAdopt(req: NextRequest): Promise<NextResponse> {
    const token = await resolveBearerToken();
    if (!token) {
        // Deliberately terse and identical for every refusal reason — missing
        // header, bad signature, revoked session. This endpoint is reachable by
        // anyone; it should not narrate which part of a credential failed.
        return NextResponse.json({ error: 'invalid_bearer' }, { status: 401 });
    }

    const userId = (token.userId ?? token.sub) as string | undefined;
    const userSessionId = token.userSessionId as string | undefined;
    if (!userId || !userSessionId) {
        // A bearer minted by /exchange always carries both. One that does not
        // is not a shape we should invent a session for.
        logger.warn('native-auth.adopt_token_missing_session_id', { component: 'native-auth' });
        return NextResponse.json({ error: 'invalid_bearer' }, { status: 401 });
    }

    const claims = await buildSessionClaims({
        userId,
        tenantId: (token.tenantId as string | null | undefined) ?? null,
        // REUSED, not minted. See the docblock — one sign-in, one UserSession
        // row, so revocation covers both transports.
        userSessionId,
    });
    if (!claims) {
        logger.error('native-auth.adopt_claims_unbuildable', {
            component: 'native-auth',
            userId,
        });
        return NextResponse.json({ error: 'invalid_bearer' }, { status: 401 });
    }

    const sessionToken = await encode({
        token: claims,
        secret: env.AUTH_SECRET,
        // The real session lifetime, NOT the access token's 15 minutes.
        maxAge: SESSION_MAX_AGE_SECONDS,
    });

    const store = await cookies();
    store.set(sessionCookieName(), sessionToken, {
        httpOnly: true,
        secure: useSecureCookies(),
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE_SECONDS,
    });

    logger.info('native-auth.adopted', { component: 'native-auth', userId });

    return NextResponse.redirect(
        new URL(safeNext(req.nextUrl.searchParams.get('next')), req.nextUrl.origin),
        // 303: the webview should GET the destination regardless of how it
        // arrived here.
        { status: 303 },
    );
}

export const GET = withApiErrorHandling(handleAdopt, {
    rateLimit: { config: LOGIN_LIMIT, scope: 'native-adopt' },
});
