import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

import { env } from '@/env';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { buildGoogleAuthorizeUrl, GOOGLE_INTEGRATION_FLAG } from '@/app-layer/integrations/providers/google';
import {
    issueNativeState,
    NATIVE_RETURN_URI,
} from '@/app-layer/integrations/providers/google/native-state';
import { classifyRedirect, nativeRedirectAllowlist } from '@/lib/auth/native/auth-codes';
import { codedBadRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

/**
 * #2005 — start the Google consent flow for Drive + Calendar.
 *
 * TWO branches, decided by `client` in the body, and the web one is unchanged.
 *
 * ## Web (no body, or any `client` but `ios`)
 *
 * Returns the authorize URL and sets a short-lived HttpOnly
 * `google_oauth_state` cookie carrying `<state>.<tenantSlug>`. The browser
 * navigates there; Google redirects back to the tenant-agnostic callback,
 * which verifies the state and creates the connection.
 *
 * Shaped after the SharePoint connect route, including the cookie layout. The
 * cookie NAME differs on purpose: a shared name would let a consent started
 * for one provider complete for the other, since the callback trusts the
 * cookie for the tenant.
 *
 * ## Native, `{"client":"ios"}` — #2495 step 6
 *
 * Returns the authorize URL and sets NO cookie. The state is a server-held
 * single-use nonce bound to this tenant and this admin, and the callback
 * returns control to the app scheme instead of an admin page.
 *
 * The cookie cannot work for the phone and this is not a preference: the
 * consent runs in an EPHEMERAL `ASWebAuthenticationSession` (owner ruling —
 * the sign-in sheet is ephemeral), a different cookie jar from the one
 * URLSession put this response's cookie in. The callback would never see it,
 * so every attempt would answer `state_invalid`, and even a success would land
 * on a web page rather than back in the app.
 *
 * **The client does not choose where it is returned to.** `NATIVE_RETURN_URI`
 * is a server constant, validated against `NATIVE_AUTH_REDIRECT_ALLOWLIST` at
 * issue. A client-supplied target would make this an open redirect gated only
 * by an allowlist; a server constant means there is no caller-controlled value
 * in the flow at all, and the allowlist check is a configuration assertion
 * rather than input validation.
 *
 * Gated by `admin.manage` and by the `integrations.google` runtime flag — both
 * branches, from the one `requirePermission` below.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req: NextRequest, { params }, ctx) => {
            await assertFeatureEnabled(GOOGLE_INTEGRATION_FLAG, ctx.userId);

            const origin = resolvePublicOrigin(req);
            const redirectUri = `${origin}/api/integrations/google/callback`;

            // Read tolerantly. The web caller sends no body at all, and a
            // schema that REQUIRED one would break it — this is a second
            // branch on an existing route, so the absent case has to stay the
            // web case.
            let client: unknown;
            try {
                const body = (await req.json()) as { client?: unknown } | null;
                client = body?.client;
            } catch {
                client = undefined;
            }

            if (client === 'ios') {
                // The allowlist check is a CONFIGURATION assertion here, not
                // input validation — the target is a server constant. It still
                // runs, because an allowlist that does not carry the scheme
                // would otherwise mint a state whose redirect the OS refuses,
                // and the phone would report a consent that silently went
                // nowhere.
                const verdict = classifyRedirect(NATIVE_RETURN_URI, nativeRedirectAllowlist());
                if (verdict !== 'allowed') {
                    // The two verdicts are logged apart for the reason
                    // `classifyRedirect` exists: "the allowlist is empty" and
                    // "this URI is not on it" are different operator actions,
                    // and only the log may say which.
                    logger.error('google.native_connect_redirect_refused', {
                        component: 'google-integration',
                        verdict,
                        msg: verdict === 'allowlist_unconfigured'
                            ? 'NATIVE_AUTH_REDIRECT_ALLOWLIST is empty, so the native Google connect refuses EVERY return. This is configuration, not a bad client.'
                            : 'NATIVE_AUTH_REDIRECT_ALLOWLIST does not carry the app scheme, so the native Google connect cannot return to the app.',
                    });
                    throw codedBadRequest(
                        'GOOGLE_NATIVE_RETURN_NOT_ALLOWED',
                        'This deployment cannot return a Google consent to the app. An administrator sets the native redirect allowlist.',
                    );
                }

                const state = await issueNativeState({
                    tenantId: ctx.tenantId,
                    userId: ctx.userId,
                    redirectUri: NATIVE_RETURN_URI,
                });
                // NO cookie. The row is the state, and the ephemeral browser
                // would not carry a cookie to the callback anyway.
                return NextResponse.json({
                    authorizeUrl: buildGoogleAuthorizeUrl({ redirectUri, state }),
                });
            }

            const state = randomUUID();
            const authorizeUrl = buildGoogleAuthorizeUrl({ redirectUri, state });

            const res = NextResponse.json({ authorizeUrl });
            // `<state>.<tenantSlug>` — state is a UUID (no dots), so the
            // callback splits on the FIRST dot and the remainder is the slug.
            // HttpOnly + SameSite=Lax survives the top-level OAuth redirect;
            // 10 minutes is long enough to read a consent screen and short
            // enough that a stale cookie cannot be replayed later.
            res.cookies.set('google_oauth_state', `${state}.${params.tenantSlug}`, {
                httpOnly: true,
                sameSite: 'lax',
                secure: env.NODE_ENV === 'production',
                path: '/',
                maxAge: 600,
            });
            return res;
        },
    ),
);
