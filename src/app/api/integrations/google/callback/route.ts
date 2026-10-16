import { NextRequest, NextResponse } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { getTenantCtx } from '@/app-layer/context';
import { assertCanAdmin } from '@/app-layer/policies/common';
import { completeGoogleConnect } from '@/app-layer/integrations/providers/google';
import { edgeLogger } from '@/lib/observability/edge-logger';

/**
 * #2005 — Google consent callback (tenant-agnostic).
 *
 * Google redirects here after the admin consents. One registered redirect URI
 * serves every tenant; the tenant slug and a CSRF nonce ride in the
 * `google_oauth_state` HttpOnly cookie (`<state>.<tenantSlug>`), and the
 * `state` query param must equal the cookie's nonce.
 *
 * The route re-authorises via `getTenantCtx` (session + membership) and
 * `assertCanAdmin` before creating anything — it never trusts the URL alone.
 * `completeGoogleConnect` re-checks the feature flag for the same reason: this
 * path writes the row and must not depend on a gate that lived only in the
 * route that started the flow.
 *
 * Always redirects back to the admin integrations page, success or failure, so
 * the user lands somewhere sensible rather than on a JSON error.
 */
export const GET = withApiErrorHandling(async (req: NextRequest): Promise<NextResponse> => {
    const origin = resolvePublicOrigin(req);
    const params = req.nextUrl.searchParams;
    const cookie = req.cookies.get('google_oauth_state')?.value ?? '';
    const dot = cookie.indexOf('.');
    const cookieState = dot >= 0 ? cookie.slice(0, dot) : '';
    const tenantSlug = dot >= 0 ? cookie.slice(dot + 1) : '';

    const fail = (reason: string, status = 'error') => {
        edgeLogger.warn('Google consent callback rejected', { component: 'google-integration', reason });
        const url = tenantSlug
            ? new URL(`/t/${tenantSlug}/admin/integrations?google=${status}`, origin)
            : new URL('/', origin);
        const res = NextResponse.redirect(url);
        res.cookies.delete('google_oauth_state');
        return res;
    };

    // Google surfaced a consent error — most often `access_denied` when the
    // admin closed the screen or declined.
    if (params.get('error')) return fail(params.get('error') ?? 'consent_error', 'declined');

    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) return fail('missing_code_or_state');
    if (!cookieState || !tenantSlug) return fail('missing_state_cookie');
    if (state !== cookieState) return fail('state_mismatch');

    let ctx;
    try {
        ctx = await getTenantCtx({ tenantSlug });
        assertCanAdmin(ctx);
    } catch {
        return fail('not_authorised');
    }

    const redirectUri = `${origin}/api/integrations/google/callback`;
    let granted;
    try {
        ({ grantedProducts: granted } = await completeGoogleConnect(ctx, { code, redirectUri }));
    } catch (e) {
        // A partial grant of NOTHING, a duplicate connection, or a code
        // exchange that returned no refresh token all land here. The reason
        // goes to the log; the user gets a status they can act on rather than
        // a stack trace.
        edgeLogger.warn('Google connect failed', {
            component: 'google-integration',
            reason: e instanceof Error ? e.message : 'unknown',
        });
        return fail('connect_failed');
    }

    // The status carries WHICH products were granted, because a partial grant
    // is a success the user needs to see: Google's consent screen lets the
    // scopes be ticked individually, so "connected" alone would hide that
    // Drive was declined.
    const status = granted.drive && granted.calendar ? 'connected' : 'connected-partial';
    const res = NextResponse.redirect(
        new URL(
            `/t/${tenantSlug}/admin/integrations?google=${status}&drive=${granted.drive}&calendar=${granted.calendar}`,
            origin,
        ),
    );
    res.cookies.delete('google_oauth_state');
    return res;
});
