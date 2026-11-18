import { SAML } from '@node-saml/node-saml';
import type { SamlConfig } from '@/app-layer/schemas/sso-config.schemas';

/**
 * SAML 2.0 Client for tenant-scoped enterprise SSO.
 *
 * Architecture choice: @node-saml/node-saml
 *
 * Rationale:
 * - Most mature and actively maintained SAML library for Node.js
 * - Handles AuthnRequest generation, response parsing, XML-DSig validation
 * - Used under the hood by passport-saml, but usable standalone
 * - No dependency on Express/passport — fits Next.js App Router cleanly
 * - Dynamic per-request configuration (essential for multi-tenant)
 *
 * Alternative considered: saml-jackson (BoxyHQ)
 * - Overkill for this use case — it's a full SAML proxy/service
 * - Adds unnecessary infrastructure complexity
 * - We only need client-side SP functionality
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface SamlAuthRequest {
    /** URL to redirect the user to (IdP's SSO endpoint with SAMLRequest) */
    redirectUrl: string;
    /** RelayState value for round-trip context */
    relayState: string;
}

export interface SamlValidatedResponse {
    /** SAML NameID (unique subject identifier) */
    nameId: string;
    /** Email address from attributes or NameID */
    email: string | null;
    /** Display name from attributes */
    name: string | null;
    /** Raw SAML profile for debugging */
    sessionIndex: string | null;
}

export interface SamlRelayState {
    tenantSlug: string;
    providerId: string;
    /** A same-origin relative path, or null (#3205). */
    returnTo?: string | null;
}

// RelayState is no longer an encoding of this payload: it is a random token,
// and the payload is sealed in a browser-bound cookie by
// `@/lib/security/sso-flow-binding` (#3205).

// ─── SAML Instance Builder ──────────────────────────────────────────

/**
 * Build a SAML instance configured for a specific tenant's IdP.
 * Creates a new instance per request (no shared state — critical for multi-tenant).
 */
export function buildSamlInstance(
    config: SamlConfig,
    callbackUrl: string,
    issuer: string
): SAML {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const samlOptions: any = {
        callbackUrl,
        issuer,
        // IdP configuration
        entryPoint: config.ssoUrl,
        idpIssuer: config.entityId,
        cert: config.certificate ?? '',
        // Request signing
        wantAuthnResponseSigned: true,
        wantAssertionsSigned: false,
        // NameID format
        identifierFormat: config.nameIdFormat
            ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        // Signature
        signatureAlgorithm: 'sha256',
        digestAlgorithm: 'sha256',
        // Disable request signing by default (most enterprise IdPs don't require it)
        authnRequestBinding: 'HTTP-Redirect',
    };

    return new SAML(samlOptions);
}

/**
 * Generate a SAML AuthnRequest and return the redirect URL.
 */
export async function generateAuthnRequest(
    saml: SAML,
    relayState: string
): Promise<string> {
    const url = await saml.getAuthorizeUrlAsync(relayState, undefined, {});
    return url;
}

/**
 * Validate a SAML response (POST to ACS) and extract the authenticated profile.
 */
export async function validateSamlResponse(
    saml: SAML,
    samlResponseBody: string
): Promise<SamlValidatedResponse> {
    const { profile } = await saml.validatePostResponseAsync({
        SAMLResponse: samlResponseBody,
    } as Record<string, string>);

    if (!profile) {
        throw new Error('SAML response validation failed: no profile returned');
    }

    // Extract NameID — this is the primary subject identifier
    const nameId = profile.nameID;
    if (!nameId) {
        throw new Error('SAML response missing NameID');
    }

    // Extract email: prefer explicit attribute, fall back to NameID if it looks like an email
    let email: string | null = null;
    if (profile.email && typeof profile.email === 'string') {
        email = profile.email.toLowerCase();
    } else if (
        typeof profile.mail === 'string'
    ) {
        email = (profile.mail as string).toLowerCase();
    } else if (nameId.includes('@')) {
        email = nameId.toLowerCase();
    }

    // Extract display name
    let name: string | null = null;
    if (profile.displayName && typeof profile.displayName === 'string') {
        name = profile.displayName;
    } else if (profile.givenName || profile.familyName) {
        const parts = [profile.givenName, profile.familyName].filter(Boolean);
        name = parts.join(' ') || null;
    }

    return {
        nameId,
        email,
        name,
        sessionIndex: profile.sessionIndex ?? null,
    };
}

/**
 * Generate SP metadata XML for the tenant's SAML configuration.
 * Useful for automated IdP configuration via metadata exchange.
 */
export function generateSpMetadata(
    saml: SAML,
    signingCert?: string
): string {
    const decryptionCert = signingCert ?? '';
    return saml.generateServiceProviderMetadata(decryptionCert, signingCert);
}
