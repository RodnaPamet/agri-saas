import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { OidcConfigSchema } from '@/app-layer/schemas/sso-config.schemas';
import {
    discoverOidc,
    generateCodeVerifier,
    generateCodeChallenge,
    generateNonce,
    encodeState,
    buildAuthorizationUrl,
} from '@/lib/security/oidc-client';
import { ssoLog, generateSsoRequestId, redactSsoUrl } from '@/lib/security/sso-logging';
import { env } from '@/env';
import { withApiErrorHandling } from '@/lib/errors/api';
import {
    badRequest,
    notFound,
    codedNotFound,
    configurationError,
    externalServiceError,
} from '@/lib/errors/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/sso/oidc/start?tenant=<tenantSlug>&provider=<providerId>&returnTo=<path>
 *
 * Initiates the OIDC authorization flow for a tenant-scoped IdP.
 *
 * Epic E — Standardized error contract via withApiErrorHandling. Failures
 * (missing params, unknown tenant/provider, broken config, IdP unreachable)
 * surface as ApiErrorResponse JSON, not bespoke `{error: '...'}` bodies.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const requestId = generateSsoRequestId();
    const { searchParams } = req.nextUrl;
    const tenantSlug = searchParams.get('tenant');
    const providerId = searchParams.get('provider');
    const returnTo = searchParams.get('returnTo') || '/';

    // ── Validate params ──
    if (!tenantSlug || !providerId) {
        ssoLog('warn', 'Missing required parameters', {
            requestId, stage: 'start', providerType: 'OIDC',
        });
        throw badRequest('Missing required parameters: tenant and provider');
    }

    const logCtx = { requestId, tenantSlug, providerType: 'OIDC' as const, providerId };

    ssoLog('info', 'OIDC flow started', { ...logCtx, stage: 'start' });

    // ── Resolve tenant ──
    const tenant = await prisma.tenant.findUnique({
        where: { slug: tenantSlug },
        select: { id: true, slug: true },
    });

    if (!tenant) {
        ssoLog('warn', 'Tenant not found', { ...logCtx, stage: 'start' });
        throw codedNotFound('TENANT_NOT_FOUND', 'Tenant not found');
    }

    // ── Load provider config ──
    const provider = await prisma.tenantIdentityProvider.findFirst({
        where: {
            id: providerId,
            tenantId: tenant.id,
            isEnabled: true,
            type: 'OIDC',
        },
    });

    if (!provider) {
        ssoLog('warn', 'Provider not found or disabled', { ...logCtx, stage: 'config_load' });
        throw notFound('OIDC provider not found or not enabled');
    }

    // ── Parse OIDC config ──
    const configResult = OidcConfigSchema.safeParse(provider.configJson);
    if (!configResult.success) {
        ssoLog('error', 'Invalid OIDC configuration', {
            ...logCtx, stage: 'config_load',
            meta: { validationError: configResult.error.message },
        });
        throw configurationError('SSO configuration error');
    }
    const oidcConfig = configResult.data;

    // ── OIDC Discovery ──
    let discovery;
    try {
        discovery = await discoverOidc(oidcConfig);
        ssoLog('info', 'OIDC discovery successful', { ...logCtx, stage: 'discovery' });
    } catch (err) {
        ssoLog('error', 'OIDC discovery failed', {
            ...logCtx, stage: 'discovery',
            meta: { error: (err as Error).message },
        });
        throw externalServiceError('Failed to contact identity provider');
    }

    // ── Generate PKCE + state ──
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const nonce = generateNonce();

    const state = encodeState({
        tenantSlug: tenant.slug,
        providerId: provider.id,
        codeVerifier,
        nonce,
        returnTo,
    });

    // ── Build callback URL ──
    const baseUrl = env.APP_URL || req.nextUrl.origin;
    const callbackUrl = `${baseUrl}/api/auth/sso/oidc/callback`;

    // ── Redirect to IdP ──
    const authUrl = buildAuthorizationUrl(
        discovery,
        oidcConfig,
        callbackUrl,
        state,
        codeChallenge,
        nonce
    );

    ssoLog('info', 'Redirecting to IdP', {
        ...logCtx, stage: 'redirect',
        meta: { authUrl: redactSsoUrl(authUrl) },
    });

    return NextResponse.redirect(authUrl);
});
