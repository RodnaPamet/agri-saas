/**
 * GET /api/auth/native/start — begin a native sign-in in the SYSTEM browser.
 *
 * The app opens this URL in an `ASWebAuthenticationSession`, carrying its PKCE
 * challenge and the URI it wants the code delivered to. We stash both in a
 * short-lived HttpOnly cookie and hand off to the EXISTING NextAuth flow —
 * nothing about Google sign-in is reimplemented here.
 *
 * The challenge and redirect live in a cookie rather than in the OAuth `state`
 * because `state` round-trips through Google and lands in browser history; the
 * cookie never leaves our origin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { withApiErrorHandling } from '@/lib/errors/api';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import {
    classifyRedirect,
    HANDOFF_COOKIE,
    HANDOFF_COOKIE_MAX_AGE_SECONDS,
} from '@/lib/auth/native/auth-codes';

export const runtime = 'nodejs';

/** Short — this only has to survive one Google round trip. */

function allowlist(): string[] {
    return env.NATIVE_AUTH_REDIRECT_ALLOWLIST.split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

async function handleStart(req: NextRequest): Promise<NextResponse> {
    const url = new URL(req.url);
    const redirectUri = url.searchParams.get('redirect_uri');
    const codeChallenge = url.searchParams.get('code_challenge');
    const method = url.searchParams.get('code_challenge_method');

    if (!redirectUri || !codeChallenge) {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }

    // S256 ONLY. `plain` puts the verifier itself in the challenge, which
    // proves possession of nothing — an interceptor who sees one has the other.
    if (method !== 'S256') {
        return NextResponse.json(
            { error: 'unsupported_code_challenge_method' },
            { status: 400 },
        );
    }

    // The open-redirect gate. Fails closed on an unconfigured allowlist.
    const verdict = classifyRedirect(redirectUri, allowlist());
    if (verdict !== 'allowed') {
        // The response is identical either way, deliberately — this route is
        // unauthenticated and must not tell an anonymous caller whether our
        // allowlist is empty. The LOG carries the distinction, because
        // "misconfigured server" and "misbehaving client" need different fixes
        // and answering `redirect_uri_not_allowed` to both is what made the
        // 2026-08-21 production outage of this flow undiagnosable.
        if (verdict === 'allowlist_unconfigured') {
            logger.error('native-auth.redirect_allowlist_unconfigured', {
                component: 'native-auth',
                msg: 'NATIVE_AUTH_REDIRECT_ALLOWLIST is empty, so native sign-in refuses EVERY redirect. This is configuration, not a bad client.',
            });
        } else {
            logger.warn('native-auth.redirect_not_on_allowlist', { component: 'native-auth' });
        }
        return NextResponse.json({ error: 'redirect_uri_not_allowed' }, { status: 400 });
    }

    // PROVIDER SCOPE — P2.5, decided rather than left half-wired.
    //
    // BOTH configured IdPs are supported. Hardcoding `google` would be the
    // half-wiring the requirement warns about: Microsoft Entra is registered in
    // `src/auth.ts` (pinned to the id `microsoft-entra-id`), the handoff is
    // provider-agnostic after sign-in, and the only provider-specific thing
    // here is which NextAuth sign-in URL we redirect to.
    //
    // The allowlist is explicit and closed. Reflecting an arbitrary `provider`
    // into a redirect path would let a caller aim the browser at any route
    // under /api/auth/signin/.
    //
    // Worth recording: Google is the one that FORCED this work — it refuses
    // OAuth in embedded webviews. Entra is historically more permissive, so it
    // may well still work inside a webview. It is wired here because the code
    // path is identical and omitting it would be arbitrary, but whether Entra
    // NEEDS the handoff is a device question that has not been answered.
    const provider = url.searchParams.get('provider') ?? 'google';
    const SUPPORTED_PROVIDERS = new Set(['google', 'microsoft-entra-id']);
    if (!SUPPORTED_PROVIDERS.has(provider)) {
        return NextResponse.json({ error: 'unsupported_provider' }, { status: 400 });
    }

    // Hand off to the real NextAuth flow. `callbackUrl` brings the browser back
    // to /complete once a session cookie exists.
    const signIn = new URL(`/api/auth/signin/${provider}`, url.origin);
    signIn.searchParams.set('callbackUrl', new URL('/api/auth/native/complete', url.origin).toString());

    const res = NextResponse.redirect(signIn);
    res.cookies.set(HANDOFF_COOKIE, JSON.stringify({ redirectUri, codeChallenge }), {
        httpOnly: true,
        secure: true,
        sameSite: 'lax', // must survive the return trip from Google
        maxAge: HANDOFF_COOKIE_MAX_AGE_SECONDS,
        path: '/',
    });
    return res;
}

export const GET = withApiErrorHandling(handleStart, {
    rateLimit: { config: LOGIN_LIMIT, scope: 'native-auth-start' },
});
