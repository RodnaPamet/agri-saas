import { NextRequest, NextResponse } from 'next/server';
import { establishSsoSession } from '@/lib/auth/sso-session';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { OidcConfigSchema } from '@/app-layer/schemas/sso-config.schemas';
import {
    discoverOidc,
    exchangeCodeForTokens,
    extractIdTokenClaims,
    validateIdTokenNonce,
} from '@/lib/security/oidc-client';
import { linkExternalIdentity } from '@/app-layer/usecases/sso';
import { ssoLog, generateSsoRequestId } from '@/lib/security/sso-logging';
import { env } from '@/env';
import type { OidcStatePayload } from '@/lib/security/oidc-client';
import {
    SSO_FLOW_COOKIE,
    SSO_FLOW_COOKIE_CLEAR,
    openSsoFlow,
    safeReturnTo,
} from '@/lib/security/sso-flow-binding';
import jwt from 'jsonwebtoken';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/sso/oidc/callback?code=<code>&state=<state>
 *
 * Handles the OIDC callback after IdP authentication:
 * 1. Validates state (tenant + provider + PKCE verifier)
 * 2. Exchanges authorization code for tokens
 * 3. Extracts and validates ID token claims
 * 4. Links external identity to local user (via usecase)
 * 5. Creates JWT session compatible with existing auth model
 * 6. Redirects to app
 */
export async function GET(req: NextRequest) {
    const requestId = generateSsoRequestId();
    const { searchParams } = req.nextUrl;
    const code = searchParams.get('code');
    const stateParam = searchParams.get('state');
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    // ── Handle IdP errors ──
    if (error) {
        ssoLog('warn', 'IdP returned error', {
            requestId, providerType: 'OIDC', stage: 'callback_received',
            meta: { error, errorDescription: errorDescription || '' },
        });
        return redirectToLogin(req, 'sso_error', 'Identity provider returned an error');
    }

    if (!code || !stateParam) {
        return redirectToLogin(req, 'missing_params', 'Missing code or state');
    }

    // ── Open the flow this browser started (#3205) ──
    // The state the IdP returned must match the token sealed in this
    // browser's HttpOnly cookie. A callback URL replayed in another browser —
    // login CSRF — has no such cookie and is refused here. The cookie is
    // expired on the way out whatever happens, so a flow is single-use.
    const jar = await cookies();
    const state = openSsoFlow<OidcStatePayload>(jar.get(SSO_FLOW_COOKIE)?.value, stateParam);
    jar.set(SSO_FLOW_COOKIE, '', SSO_FLOW_COOKIE_CLEAR);
    if (!state || !state.tenantSlug || !state.providerId || !state.codeVerifier || !state.nonce) {
        return redirectToLogin(req, 'invalid_state', 'Invalid SSO state');
    }

    // ── Resolve tenant ──
    const tenant = await prisma.tenant.findUnique({
        where: { slug: state.tenantSlug },
        select: { id: true, slug: true },
    });

    if (!tenant) {
        return redirectToLogin(req, 'tenant_not_found');
    }

    // ── Load provider config (verify it's still enabled) ──
    const provider = await prisma.tenantIdentityProvider.findFirst({
        where: {
            id: state.providerId,
            tenantId: tenant.id,
            isEnabled: true,
            type: 'OIDC',
        },
    });

    if (!provider) {
        return redirectToLogin(req, 'provider_disabled', 'SSO provider is no longer active');
    }

    // ── Parse OIDC config ──
    const configResult = OidcConfigSchema.safeParse(provider.configJson);
    if (!configResult.success) {
        ssoLog('error', 'Invalid OIDC config on callback', {
            requestId, tenantSlug: state.tenantSlug, providerType: 'OIDC',
            providerId: provider.id, stage: 'config_load',
        });
        return redirectToLogin(req, 'config_error');
    }
    const oidcConfig = configResult.data;

    // ── OIDC Discovery ──
    let discovery;
    try {
        discovery = await discoverOidc(oidcConfig);
    } catch (err) {
        ssoLog('error', 'OIDC discovery failed on callback', {
            requestId, tenantSlug: state.tenantSlug, providerType: 'OIDC',
            providerId: state.providerId, stage: 'discovery',
            meta: { error: (err as Error).message },
        });
        return redirectToLogin(req, 'discovery_error');
    }

    // ── Exchange code for tokens ──
    const baseUrl = env.APP_URL || req.nextUrl.origin;
    const callbackUrl = `${baseUrl}/api/auth/sso/oidc/callback`;

    let tokens;
    try {
        tokens = await exchangeCodeForTokens(
            discovery,
            oidcConfig,
            code,
            callbackUrl,
            state.codeVerifier
        );
    } catch (err) {
        ssoLog('error', 'OIDC token exchange failed', {
            requestId, tenantSlug: state.tenantSlug, providerType: 'OIDC',
            providerId: state.providerId, stage: 'token_exchange',
            meta: { error: (err as Error).message },
        });
        return redirectToLogin(req, 'token_error', 'Failed to exchange authorization code');
    }

    // ── Validate nonce ──
    if (!validateIdTokenNonce(tokens.id_token, state.nonce)) {
        ssoLog('error', 'Nonce mismatch — possible replay attack', {
            requestId, tenantSlug: state.tenantSlug, providerType: 'OIDC',
            providerId: state.providerId, stage: 'nonce_validation',
        });
        return redirectToLogin(req, 'nonce_mismatch');
    }

    // ── Extract claims ──
    let claims;
    try {
        claims = extractIdTokenClaims(tokens.id_token);
    } catch (err) {
        ssoLog('error', 'Failed to extract ID token claims', {
            requestId, tenantSlug: state.tenantSlug, providerType: 'OIDC',
            providerId: state.providerId, stage: 'claims_extraction',
            meta: { error: (err as Error).message },
        });
        return redirectToLogin(req, 'claims_error');
    }

    if (!claims.email) {
        return redirectToLogin(req, 'no_email', 'Identity provider did not return an email');
    }

    // ── Link external identity to local user ──
    const linkResult = await linkExternalIdentity(
        tenant.id,
        provider.id,
        claims.sub,
        claims.email
    );

    if (linkResult.status === 'rejected') {
        const reasonMessages: Record<string, string> = {
            cross_tenant: 'Cross-tenant login attempt blocked',
            domain_mismatch: 'Email domain not allowed for this SSO provider',
            no_user: 'No matching account found. Contact your administrator.',
            no_membership: 'No matching account found. Contact your administrator.',
            subject_conflict: 'Identity conflict detected. Contact your administrator.',
            jit_disabled: 'No matching account found. Contact your administrator.',
            no_email: 'Identity provider did not return an email',
            multi_tenant_account: 'This account belongs to more than one farm. Sign in with your usual method.',
        };
        ssoLog('warn', 'Identity linking rejected', {
            requestId, tenantSlug: state.tenantSlug, providerType: 'OIDC',
            providerId: provider.id, stage: 'identity_linking',
            meta: { reason: linkResult.reason, email: claims.email },
        });
        return redirectToLogin(
            req,
            linkResult.reason,
            reasonMessages[linkResult.reason] || 'Login failed'
        );
    }

    const linkedUserId = linkResult.userId;

    // ── Load user and membership for session ──
    const membership = await prisma.tenantMembership.findUnique({
        where: {
            tenantId_userId: {
                tenantId: tenant.id,
                userId: linkedUserId,
            },
        },
    });

    // ACTIVE only (#3196): a DEACTIVATED or REMOVED row is a person this farm
    // let go, not one its IdP may sign in.
    if (!membership || membership.status !== 'ACTIVE') {
        return redirectToLogin(req, 'no_membership');
    }

    const user = await prisma.user.findUnique({
        where: { id: linkedUserId },
        select: { id: true, email: true, name: true },
    });

    if (!user) {
        return redirectToLogin(req, 'user_not_found');
    }

    // ── Create JWT session (compatible with Auth.js JWT strategy) ──
    const authSecret = env.AUTH_SECRET;
    if (!authSecret) {
        ssoLog('error', 'AUTH_SECRET not set', {
            requestId, tenantSlug: tenant.slug, providerType: 'OIDC', stage: 'session_creation',
        });
        return redirectToLogin(req, 'config_error');
    }

    // Mint the session NextAuth v4 can actually read, and TRACK it.
    // Previously this hand-rolled a `jwt.sign` JWS into the v5 cookie name
    // with a thin claim set — three independent defects, each fatal. See
    // src/lib/auth/sso-session.ts.
    const established = await establishSsoSession({
        userId: user.id,
        tenantId: tenant.id,
        provider: `sso-oidc-${provider.id}`,
    });
    if (!established) {
        return NextResponse.redirect(new URL('/login?error=sso_session', baseUrl));
    }

    // ── Redirect to app ──
    // Re-checked here as well as at start: same-origin relative paths only.
    const returnTo = safeReturnTo(state.returnTo) ?? `/t/${tenant.slug}/dashboard`;
    return NextResponse.redirect(new URL(returnTo, baseUrl));
}

// ─── Helpers ─────────────────────────────────────────────────────────

function redirectToLogin(
    req: NextRequest,
    errorCode: string,
    errorMessage?: string
): NextResponse {
    const loginUrl = new URL('/login', req.nextUrl.origin);
    loginUrl.searchParams.set('error', errorCode);
    if (errorMessage) {
        loginUrl.searchParams.set('error_description', errorMessage);
    }
    return NextResponse.redirect(loginUrl);
}
