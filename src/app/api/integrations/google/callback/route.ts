import { NextRequest, NextResponse } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { resolvePublicOrigin } from '@/lib/http/request-origin';
import { getTenantCtx } from '@/app-layer/context';
import { assertCanAdmin } from '@/app-layer/policies/common';
import { completeGoogleConnect } from '@/app-layer/integrations/providers/google';
import { claimNativeState } from '@/app-layer/integrations/providers/google/native-state';
import { edgeLogger } from '@/lib/observability/edge-logger';
import prisma from '@/lib/prisma';
import { computePermissions } from '@/lib/tenant-context';
import { getPermissionsForRole, parsePermissionsJson } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';

/**
 * The CLOSED set of error codes the native branch may return (#2495 step 6).
 *
 * Closed because the phone treats anything outside it as `internal_error`, so
 * an unlisted value is not a message — it is a value the client discards. Typed
 * as a union rather than listed in prose for the same reason the three 409s on
 * the drive-copy route are three codes: a client can only act on what it can
 * name.
 */
type NativeConnectError =
    | 'access_denied'
    | 'insufficient_scope'
    | 'state_expired'
    | 'state_invalid'
    | 'token_exchange_failed'
    | 'not_admin'
    | 'internal_error';

/**
 * Google's own `error` param, narrowed into the closed set.
 *
 * `access_denied` passes through — it is the one Google value that means
 * something actionable to a person (they declined or closed the sheet).
 * Everything else becomes `internal_error`, because an unmapped Google string
 * reaching the phone would be discarded anyway and a code the client cannot
 * name is worse than one it can: `internal_error` at least routes to a sentence.
 */
function mapGoogleError(raw: string): NativeConnectError {
    return raw === 'access_denied' ? 'access_denied' : 'internal_error';
}

/**
 * A context for the admin who STARTED the consent.
 *
 * The web branch re-authorises with `getTenantCtx` + `assertCanAdmin`, which
 * reads the caller's session cookie. The native branch has no session to read —
 * the consent ran in an ephemeral browser — so the row records who was
 * authorised when the flow started, where `requirePermission('admin.manage')`
 * had a real session to check.
 *
 * This re-checks that person is STILL an ACTIVE admin of that farm before
 * anything is written, which is what makes the row an authorisation record
 * rather than a bearer token. A membership revoked mid-consent refuses.
 */
async function contextForStarter(
    tenantId: string,
    userId: string,
): Promise<RequestContext | null> {
    const membership = await prisma.tenantMembership.findFirst({
        where: { tenantId, userId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
        include: { customRole: true },
    });
    if (!membership) return null;
    const effectiveRole = membership.customRole?.baseRole ?? membership.role;
    return {
        requestId: `google-native-connect-${tenantId}`,
        userId,
        tenantId,
        role: effectiveRole,
        permissions: computePermissions(effectiveRole),
        appPermissions: membership.customRole
            ? parsePermissionsJson(membership.customRole.permissionsJson, membership.customRole.baseRole)
            : getPermissionsForRole(membership.role),
    };
}

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
/**
 * Hand an error back to the app, and log which one.
 *
 * A REDIRECT rather than a JSON body: the phone is reading the callback URL out
 * of an `ASWebAuthenticationSession`, so a 4xx with a body is something it
 * cannot see at all — it would observe the sheet closing with no result, which
 * is indistinguishable from the person cancelling.
 */
function nativeFail(redirectUri: string, error: NativeConnectError): NextResponse {
    edgeLogger.warn('Google native consent callback rejected', {
        component: 'google-integration',
        reason: error,
    });
    return NextResponse.redirect(`${redirectUri}?error=${error}`);
}

export const GET = withApiErrorHandling(async (req: NextRequest): Promise<NextResponse> => {
    const origin = resolvePublicOrigin(req);
    const params = req.nextUrl.searchParams;

    // ── The NATIVE branch, tried first and chosen by EVIDENCE ───────────────
    //
    // `claimNativeState` answers `unknown_state` when no row carries this
    // state, which is every web consent — so the fall-through below is the
    // cookie flow, untouched.
    //
    // Tried first, and the branch is not chosen by the cookie's presence: a web
    // flow whose cookie expired would then be sent to an app scheme a browser
    // cannot open. Nor by a bare claim failure, which cannot tell a web state
    // from a native REPLAY. A replay has a row, so it lands here and gets its
    // app-scheme error rather than the web fallback the phone could not read.
    const rawState = params.get('state');
    const native = rawState
        ? await claimNativeState(rawState)
        : ({ ok: false, reason: 'unknown_state' } as const);

    if (!native.ok && native.reason !== 'unknown_state') {
        return nativeFail(native.redirectUri, native.reason);
    }
    if (native.ok) {
        const to = native.redirectUri;

        // AFTER the claim, deliberately. Google returns `state` alongside
        // `error`, so a declined consent still consumes its nonce — which is
        // correct: the person starts again, and a state that survived a decline
        // would be replayable.
        const googleError = params.get('error');
        if (googleError) return nativeFail(to, mapGoogleError(googleError));

        const code = params.get('code');
        if (!code) return nativeFail(to, 'internal_error');

        const ctx = await contextForStarter(native.tenantId, native.userId);
        if (!ctx) return nativeFail(to, 'not_admin');

        let granted;
        try {
            ({ grantedProducts: granted } = await completeGoogleConnect(ctx, {
                code,
                redirectUri: `${origin}/api/integrations/google/callback`,
            }));
        } catch (e) {
            edgeLogger.warn('Google native connect failed', {
                component: 'google-integration',
                reason: e instanceof Error ? e.message : 'unknown',
            });
            return nativeFail(to, 'token_exchange_failed');
        }

        // Drive specifically, not "anything was granted". The phone's whole
        // reason for connecting is «Документи», and Google's consent screen
        // lets the scopes be ticked individually — so a calendar-only grant is
        // an ordinary outcome that must not report success. It is the same
        // condition `GET /documents/settings` reports as `connected: false`,
        // so reporting `connected` here would contradict the next screen.
        if (!granted.drive) return nativeFail(to, 'insufficient_scope');

        return NextResponse.redirect(`${to}?result=connected`);
    }

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
