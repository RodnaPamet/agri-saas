import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { SamlConfigSchema } from '@/app-layer/schemas/sso-config.schemas';
import {
    buildSamlInstance,
    generateAuthnRequest,
    encodeSamlRelayState,
} from '@/lib/security/saml-client';
import { ssoLog, generateSsoRequestId } from '@/lib/security/sso-logging';
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
 * GET /api/auth/sso/saml/start?tenant=<tenantSlug>&provider=<providerId>&returnTo=<path>
 *
 * Initiates the SAML 2.0 SSO flow:
 * 1. Resolves tenant by slug
 * 2. Loads enabled SAML provider config
 * 3. Builds a SAML AuthnRequest
 * 4. Encodes tenant context in RelayState
 * 5. Redirects to IdP's SSO endpoint
 *
 * Epic E — Standardized error contract via withApiErrorHandling.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const requestId = generateSsoRequestId();
    const { searchParams } = req.nextUrl;
    const tenantSlug = searchParams.get('tenant');
    const providerId = searchParams.get('provider');
    const returnTo = searchParams.get('returnTo') || '/';

    // ── Validate params ──
    if (!tenantSlug || !providerId) {
        throw badRequest('Missing required parameters: tenant and provider');
    }

    // ── Resolve tenant ──
    const tenant = await prisma.tenant.findUnique({
        where: { slug: tenantSlug },
        select: { id: true, slug: true },
    });

    if (!tenant) {
        throw codedNotFound('TENANT_NOT_FOUND', 'Tenant not found');
    }

    // ── Load provider config ──
    const provider = await prisma.tenantIdentityProvider.findFirst({
        where: {
            id: providerId,
            tenantId: tenant.id,
            isEnabled: true,
            type: 'SAML',
        },
    });

    if (!provider) {
        throw notFound('SAML provider not found or not enabled');
    }

    // ── Parse SAML config ──
    const configResult = SamlConfigSchema.safeParse(provider.configJson);
    if (!configResult.success) {
        ssoLog('error', 'Invalid SAML configuration', {
            requestId, tenantSlug, providerType: 'SAML',
            providerId: provider.id, stage: 'config_load',
        });
        throw configurationError('SSO configuration error');
    }
    const samlConfig = configResult.data;

    if (!samlConfig.ssoUrl || !samlConfig.entityId) {
        // If metadataUrl was provided but not ssoUrl/entityId, we need to handle that
        // For now, require explicit ssoUrl + entityId
        ssoLog('error', 'SAML config missing ssoUrl or entityId', {
            tenantSlug, providerType: 'SAML', providerId: provider.id, stage: 'config_load',
        });
        throw configurationError('SAML configuration incomplete — ssoUrl and entityId required');
    }

    // ── Build SAML instance ──
    const baseUrl = env.APP_URL || req.nextUrl.origin;
    const callbackUrl = `${baseUrl}/api/auth/sso/saml/callback`;
    const spIssuer = `${baseUrl}/saml/metadata/${tenant.slug}`;

    const saml = buildSamlInstance(samlConfig, callbackUrl, spIssuer);

    // ── Encode tenant context in RelayState ──
    const relayState = encodeSamlRelayState({
        tenantSlug: tenant.slug,
        providerId: provider.id,
        returnTo,
    });

    // ── Generate AuthnRequest and redirect ──
    try {
        const redirectUrl = await generateAuthnRequest(saml, relayState);
        ssoLog('info', 'SAML AuthnRequest generated, redirecting to IdP', {
            requestId, tenantSlug: tenant.slug, providerType: 'SAML',
            providerId: provider.id, stage: 'redirect',
        });
        return NextResponse.redirect(redirectUrl);
    } catch (err) {
        ssoLog('error', 'AuthnRequest generation failed', {
            requestId, tenantSlug: tenant.slug, providerType: 'SAML',
            providerId: provider.id, stage: 'authn_request',
            meta: { error: (err as Error).message },
        });
        throw externalServiceError('Failed to initiate SAML authentication');
    }
});
