import { NextRequest, NextResponse } from 'next/server';
import { establishSsoSession } from '@/lib/auth/sso-session';
import { cookies } from 'next/headers';
import prisma from '@/lib/prisma';
import { SamlConfigSchema } from '@/app-layer/schemas/sso-config.schemas';
import {
    buildSamlInstance,
    validateSamlResponse,
    decodeSamlRelayState,
} from '@/lib/security/saml-client';
import { linkExternalIdentity } from '@/app-layer/usecases/sso';
import { ssoLog, generateSsoRequestId } from '@/lib/security/sso-logging';
import { env } from '@/env';
import jwt from 'jsonwebtoken';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/sso/saml/callback
 *
 * SAML Assertion Consumer Service (ACS) endpoint.
 * Receives the SAML Response (POST binding) from the IdP:
 * 1. Extracts RelayState to identify tenant + provider
 * 2. Validates the SAML response signature and assertions
 * 3. Extracts NameID/email/name claims
 * 4. Links external identity to local user
 * 5. Creates JWT session
 * 6. Redirects to app
 */
export async function POST(req: NextRequest) {
    const requestId = generateSsoRequestId();
    let formData: FormData;
    try {
        formData = await req.formData();
    } catch {
        return redirectToLogin(req, 'invalid_request', 'Invalid SAML response format');
    }

    const samlResponse = formData.get('SAMLResponse') as string | null;
    const relayStateRaw = formData.get('RelayState') as string | null;

    if (!samlResponse) {
        return redirectToLogin(req, 'missing_response', 'No SAML response received');
    }

    // ── Decode RelayState ──
    if (!relayStateRaw) {
        return redirectToLogin(req, 'missing_relay', 'Missing RelayState parameter');
    }

    const relayState = decodeSamlRelayState(relayStateRaw);
    if (!relayState) {
        return redirectToLogin(req, 'invalid_relay', 'Invalid RelayState');
    }

    // ── Resolve tenant ──
    const tenant = await prisma.tenant.findUnique({
        where: { slug: relayState.tenantSlug },
        select: { id: true, slug: true },
    });

    if (!tenant) {
        return redirectToLogin(req, 'tenant_not_found');
    }

    // ── Load provider config (verify still enabled) ──
    const provider = await prisma.tenantIdentityProvider.findFirst({
        where: {
            id: relayState.providerId,
            tenantId: tenant.id,
            isEnabled: true,
            type: 'SAML',
        },
    });

    if (!provider) {
        return redirectToLogin(req, 'provider_disabled', 'SAML provider is no longer active');
    }

    // ── Parse SAML config ──
    const configResult = SamlConfigSchema.safeParse(provider.configJson);
    if (!configResult.success) {
        ssoLog('error', 'Invalid SAML config on callback', {
            requestId, tenantSlug: relayState.tenantSlug, providerType: 'SAML',
            providerId: provider.id, stage: 'config_load',
        });
        return redirectToLogin(req, 'config_error');
    }
    const samlConfig = configResult.data;

    // ── Build SAML instance for validation ──
    const baseUrl = env.APP_URL || req.nextUrl.origin;
    const callbackUrl = `${baseUrl}/api/auth/sso/saml/callback`;
    const spIssuer = `${baseUrl}/saml/metadata/${tenant.slug}`;

    const saml = buildSamlInstance(samlConfig, callbackUrl, spIssuer);

    // ── Validate SAML response ──
    let validatedResponse;
    try {
        validatedResponse = await validateSamlResponse(saml, samlResponse);
    } catch (err) {
        ssoLog('error', 'SAML response validation failed', {
            requestId, tenantSlug: relayState.tenantSlug, providerType: 'SAML',
            providerId: provider.id, stage: 'response_validation',
            meta: { error: (err as Error).message },
        });
        return redirectToLogin(req, 'validation_failed', 'SAML response validation failed');
    }

    if (!validatedResponse.email) {
        return redirectToLogin(req, 'no_email', 'Identity provider did not return an email');
    }

    // ── Link external identity to local user ──
    const linkResult = await linkExternalIdentity(
        tenant.id,
        provider.id,
        validatedResponse.nameId,
        validatedResponse.email
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
        };
        ssoLog('warn', 'SAML identity linking rejected', {
            requestId, tenantSlug: relayState.tenantSlug, providerType: 'SAML',
            providerId: provider.id, stage: 'identity_linking',
            meta: { reason: linkResult.reason, email: validatedResponse.email },
        });
        return redirectToLogin(
            req,
            linkResult.reason,
            reasonMessages[linkResult.reason] || 'Login failed'
        );
    }

    const linkedUserId = linkResult.userId;

    // ── Load membership for session ──
    const membership = await prisma.tenantMembership.findUnique({
        where: {
            tenantId_userId: {
                tenantId: tenant.id,
                userId: linkedUserId,
            },
        },
    });

    if (!membership) {
        return redirectToLogin(req, 'no_membership');
    }

    const user = await prisma.user.findUnique({
        where: { id: linkedUserId },
        select: { id: true, email: true, name: true },
    });

    if (!user) {
        return redirectToLogin(req, 'user_not_found');
    }

    // ── Create JWT session ──
    const authSecret = env.AUTH_SECRET;
    if (!authSecret) {
        ssoLog('error', 'AUTH_SECRET not set', {
            requestId, tenantSlug: tenant.slug, providerType: 'SAML', stage: 'session_creation',
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
        provider: `sso-saml-${provider.id}`,
    });
    if (!established) {
        return NextResponse.redirect(
            new URL('/login?error=sso_session', req.url),
        );
    }

    // ── Redirect to app ──
    const returnTo = relayState.returnTo || `/t/${tenant.slug}/dashboard`;
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
