import type { RequestContext } from '@/app-layer/types';
import type { TenantIdentityProvider, UserIdentityLink } from '@prisma/client';
import * as SsoConfigRepo from '@/app-layer/repositories/SsoConfigRepository';
import * as IdentityLinkRepo from '@/app-layer/repositories/IdentityLinkRepository';
import { UpsertSsoConfigInput } from '@/app-layer/schemas/sso-config.schemas';
import { forbidden, notFound } from '@/lib/errors/types';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { hashForLookup, hashForLookupCandidates } from '@/lib/security/encryption';

/**
 * Enterprise SSO Usecases
 *
 * These usecases manage tenant-scoped identity provider configuration and
 * external identity linking. They enforce RBAC, tenant isolation, and safe
 * account linking rules.
 */

// ─── Configuration Management ────────────────────────────────────────

/**
 * List all SSO identity providers configured for the tenant.
 * Requires ADMIN role.
 */
export async function getTenantSsoConfig(
    ctx: RequestContext
): Promise<TenantIdentityProvider[]> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can view SSO configuration');
    return SsoConfigRepo.findByTenantId(ctx.tenantId);
}

/**
 * Get a single SSO provider by ID.
 * Requires ADMIN role.
 */
export async function getTenantSsoConfigById(
    ctx: RequestContext,
    providerId: string
): Promise<TenantIdentityProvider> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can view SSO configuration');
    const provider = await SsoConfigRepo.findById(ctx.tenantId, providerId);
    if (!provider) throw notFound('Identity provider not found');
    return provider;
}

/**
 * Create or update a tenant identity provider.
 * Requires ADMIN role. Validates input via Zod schema.
 */
export async function upsertTenantSsoConfig(
    ctx: RequestContext,
    input: UpsertSsoConfigInput
): Promise<TenantIdentityProvider> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can manage SSO configuration');

    logger.info('sso config upsert', {
        component: 'sso', action: input.id ? 'update' : 'create',
        providerType: input.type, isEnforced: input.isEnforced,
    });

    // If updating, verify the provider belongs to this tenant
    if (input.id) {
        const existing = await SsoConfigRepo.findById(ctx.tenantId, input.id);
        if (!existing) throw notFound('Identity provider not found');
    }

    return SsoConfigRepo.upsert(ctx.tenantId, {
        id: input.id,
        name: input.name,
        type: input.type,
        isEnabled: input.isEnabled,
        isEnforced: input.isEnforced,
        emailDomains: input.emailDomains,
        configJson: {
            ...input.config,
            // Persist JIT settings alongside IdP config
            _jit: {
                allowJitProvisioning: input.allowJitProvisioning,
                jitDefaultRole: input.jitDefaultRole,
            },
        },
    });
}

/**
 * Delete a tenant identity provider.
 * Requires ADMIN role. Also removes all identity links for this provider.
 */
export async function deleteTenantSsoConfig(
    ctx: RequestContext,
    providerId: string
): Promise<void> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can manage SSO configuration');

    const existing = await SsoConfigRepo.findById(ctx.tenantId, providerId);
    if (!existing) throw notFound('Identity provider not found');

    // Cascade: remove identity links, then the provider
    await SsoConfigRepo.remove(ctx.tenantId, providerId);
}

/**
 * Enable or disable a tenant SSO provider.
 * Requires ADMIN role.
 */
export async function toggleTenantSso(
    ctx: RequestContext,
    providerId: string,
    enabled: boolean
): Promise<TenantIdentityProvider> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can manage SSO configuration');

    const existing = await SsoConfigRepo.findById(ctx.tenantId, providerId);
    if (!existing) throw notFound('Identity provider not found');

    return SsoConfigRepo.setEnabled(ctx.tenantId, providerId, enabled);
}

/**
 * Set whether SSO is enforced (local login disabled) for a provider.
 * Requires ADMIN role.
 *
 * When enforced:
 *   - Users cannot log in with credentials
 *   - SSO is the only authentication method
 *   - Break-glass: ADMIN users who have passwordHash set can still use local login
 */
export async function setTenantSsoEnforced(
    ctx: RequestContext,
    providerId: string,
    enforced: boolean
): Promise<TenantIdentityProvider> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can manage SSO configuration');

    logger.info('sso enforcement toggle', {
        component: 'sso', providerId, enforced,
    });

    const existing = await SsoConfigRepo.findById(ctx.tenantId, providerId);
    if (!existing) throw notFound('Identity provider not found');

    // Safety check: if enabling enforcement, ensure at least one admin has SSO linked
    if (enforced) {
        const adminMembers = await prisma.tenantMembership.findMany({
            where: { tenantId: ctx.tenantId, role: 'ADMIN' },
            include: { user: true },
        });

        // At least one admin must have a password (break-glass) or SSO link
        const hasBreakGlassAdmin = adminMembers.some((m) => m.user.passwordHash);
        if (!hasBreakGlassAdmin) {
            logger.warn('sso enforcement blocked — no break-glass admin', { component: 'sso', providerId });
            throw forbidden(
                'Cannot enforce SSO: at least one admin must have a local password for break-glass access'
            );
        }
    }

    return SsoConfigRepo.setEnforced(ctx.tenantId, providerId, enforced);
}

// ─── SSO Login Resolution ────────────────────────────────────────────

/**
 * Resolve the SSO configuration for a tenant login page.
 * This is a public/unauthenticated operation — no ctx required.
 *
 * Returns only the minimal info needed for the login page:
 * - provider type, name, isEnforced
 * - does NOT expose configJson secrets
 */
export async function resolveSsoForTenant(
    tenantSlug: string
): Promise<{
    hasSso: boolean;
    isEnforced: boolean;
    providers: Array<{ id: string; type: string; name: string }>;
}> {
    const tenant = await prisma.tenant.findUnique({
        where: { slug: tenantSlug },
        select: { id: true },
    });

    if (!tenant) {
        return { hasSso: false, isEnforced: false, providers: [] };
    }

    const enabledProviders = await SsoConfigRepo.findEnabledByTenantId(tenant.id);

    if (enabledProviders.length === 0) {
        return { hasSso: false, isEnforced: false, providers: [] };
    }

    return {
        hasSso: true,
        isEnforced: enabledProviders.some((p) => p.isEnforced),
        providers: enabledProviders.map((p) => ({
            id: p.id,
            type: p.type,
            name: p.name,
        })),
    };
}

/**
 * Resolve SSO provider by email domain.
 * Used for domain-based auto-discovery on the login page.
 */
export async function resolveSsoByDomain(
    email: string
): Promise<{
    found: boolean;
    tenantSlug?: string;
    providerId?: string;
    providerName?: string;
}> {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return { found: false };

    const provider = await SsoConfigRepo.findByDomain(domain);
    if (!provider) return { found: false };

    const tenant = await prisma.tenant.findUnique({
        where: { id: provider.tenantId },
        select: { slug: true },
    });

    return {
        found: true,
        tenantSlug: tenant?.slug,
        providerId: provider.id,
        providerName: provider.name,
    };
}

// ─── Identity Linking ────────────────────────────────────────────

/**
 * Result type for linkExternalIdentity — provides explicit rejection reasons.
 */
export type LinkResult =
    | { status: 'linked'; userId: string; isNewLink: boolean }
    | { status: 'jit_created'; userId: string }
    | { status: 'rejected'; reason: LinkRejectionReason };

export type LinkRejectionReason =
    | 'cross_tenant'       // Existing link belongs to different tenant
    | 'domain_mismatch'    // Email domain not in provider's allowed domains
    | 'no_user'            // No local user found
    | 'no_membership'      // User exists but has no tenant membership
    | 'subject_conflict'   // User linked to a different subject for same provider
    | 'jit_disabled'       // Would need JIT but it's turned off
    | 'no_email';          // IdP didn't provide an email

/**
 * Validate an email against a provider's allowed domains.
 * Returns true if:
 *   - provider has no domain restrictions (emailDomains is empty)
 *   - email's domain is in the allowed list
 */
export function validateEmailAgainstDomains(
    email: string,
    emailDomains: string[]
): boolean {
    if (emailDomains.length === 0) return true;
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return false;
    return emailDomains.some((d) => d.toLowerCase() === domain);
}

/**
 * Link an external identity to a local user during SSO callback.
 *
 * Hardened resolution with explicit safety checks:
 * 1. Validate email against provider's allowed domains
 * 2. Check for existing link by (providerId, externalSubject)
 * 3. Verify cross-tenant safety
 * 4. If no link, match by email → User → TenantMembership
 * 5. If no user/membership found, attempt JIT provisioning if enabled
 * 6. Never auto-provision ADMIN role via JIT
 *
 * Returns explicit status with rejection reasons for audit logging.
 */
export async function linkExternalIdentity(
    tenantId: string,
    providerId: string,
    externalSubject: string,
    email: string
): Promise<LinkResult> {
    logger.info('sso identity link started', { component: 'sso', providerId });

    if (!email) {
        logger.warn('sso identity link rejected', { component: 'sso', reason: 'no_email' });
        return { status: 'rejected', reason: 'no_email' };
    }

    const normalizedEmail = email.toLowerCase();

    // Load provider config for domain validation and JIT settings
    const provider = await prisma.tenantIdentityProvider.findFirst({
        where: { id: providerId, tenantId },
    });

    // ── Step 1: Domain validation ──
    if (provider) {
        if (!validateEmailAgainstDomains(normalizedEmail, provider.emailDomains)) {
            logger.warn('sso identity link rejected', { component: 'sso', reason: 'domain_mismatch' });
            return { status: 'rejected', reason: 'domain_mismatch' };
        }
    }

    // ── Step 2: Check for existing link ──
    const existingLink = await IdentityLinkRepo.findByProviderAndSubject(
        providerId,
        externalSubject
    );

    if (existingLink) {
        // ── Step 3: Cross-tenant safety ──
        if (existingLink.tenantId !== tenantId) {
            logger.warn('sso identity link rejected', { component: 'sso', reason: 'cross_tenant' });
            return { status: 'rejected', reason: 'cross_tenant' };
        }
        await IdentityLinkRepo.updateLastLogin(existingLink.id);
        logger.info('sso identity link resolved', { component: 'sso', status: 'linked', isNewLink: false });
        return { status: 'linked', userId: existingLink.userId, isNewLink: false };
    }

    // ── Step 4: Match by email ──
    const user = await prisma.user.findFirst({
        where: { emailHash: { in: hashForLookupCandidates(normalizedEmail) } },
        select: { id: true },
    });

    if (user) {
        // Check tenant membership
        const membership = await prisma.tenantMembership.findUnique({
            where: {
                tenantId_userId: { tenantId, userId: user.id },
            },
        });

        if (!membership) {
            return { status: 'rejected', reason: 'no_membership' };
        }

        // Check for subject conflict
        const existingUserLink = await IdentityLinkRepo.findByUserAndProvider(
            user.id,
            providerId
        );

        if (existingUserLink) {
            return { status: 'rejected', reason: 'subject_conflict' };
        }

        // Create link for existing user
        await IdentityLinkRepo.linkIdentity({
            userId: user.id,
            tenantId,
            providerId,
            externalSubject,
            emailAtLinkTime: normalizedEmail,
            emailAtLinkTimeHash: hashForLookup(normalizedEmail),
        });

        logger.info('sso identity link resolved', { component: 'sso', status: 'linked', isNewLink: true });
        return { status: 'linked', userId: user.id, isNewLink: true };
    }

    // ── Step 5: JIT provisioning ──
    const jitConfig = extractJitConfig(provider);

    if (!jitConfig.allowJitProvisioning) {
        return { status: 'rejected', reason: 'jit_disabled' };
    }

    // JIT: create user + membership + link in a transaction
    // SAFETY: JIT role is always READER or EDITOR — never ADMIN
    const safeRole = jitConfig.jitDefaultRole === 'EDITOR' ? 'EDITOR' : 'READER';

    const newUser = await prisma.$transaction(async (tx) => {
        // Create user
        const created = await tx.user.create({
            data: {
                email: normalizedEmail,
                emailHash: hashForLookup(normalizedEmail),
                name: normalizedEmail.split('@')[0],
            },
        });

        // Create membership
        await tx.tenantMembership.create({
            data: {
                tenantId,
                userId: created.id,
                role: safeRole as 'READER' | 'EDITOR',
            },
        });

        // Create identity link
        await tx.userIdentityLink.create({
            data: {
                userId: created.id,
                tenantId,
                providerId,
                externalSubject,
                emailAtLinkTime: normalizedEmail,
                emailAtLinkTimeHash: hashForLookup(normalizedEmail),
            },
        });

        return created;
    });

    logger.info('sso identity link resolved', { component: 'sso', status: 'jit_created' });
    return { status: 'jit_created', userId: newUser.id };
}

/**
 * Extract JIT provisioning config from provider's configJson.
 * Returns safe defaults if not configured.
 */
function extractJitConfig(provider: { configJson: unknown } | null): {
    allowJitProvisioning: boolean;
    jitDefaultRole: string;
} {
    if (!provider) return { allowJitProvisioning: false, jitDefaultRole: 'READER' };
    const config = provider.configJson as Record<string, unknown>;
    const jit = config?._jit as Record<string, unknown> | undefined;
    return {
        allowJitProvisioning: jit?.allowJitProvisioning === true,
        jitDefaultRole: jit?.jitDefaultRole === 'EDITOR' ? 'EDITOR' : 'READER',
    };
}

/**
 * Check if local login is allowed for a user in a specific tenant.
 * Returns false if SSO is enforced AND the user is not a break-glass admin.
 *
 * Break-glass criteria:
 *   1. User has ADMIN role in tenant
 *   2. User has a local passwordHash set
 *   Both conditions must be true.
 */
export async function isLocalLoginAllowed(
    tenantId: string,
    userId: string
): Promise<boolean> {
    // Check if any provider in this tenant enforces SSO
    const enforcedProviders = await prisma.tenantIdentityProvider.findMany({
        where: { tenantId, isEnabled: true, isEnforced: true },
    });

    if (enforcedProviders.length === 0) return true;

    // SSO is enforced — check if user is a break-glass admin
    const membership = await prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
    });

    if (membership?.role !== 'ADMIN') return false;

    // Admin — check if they have a local password (break-glass)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true },
    });

    return !!user?.passwordHash;
}

/**
 * Pre-login enforcement check for the credentials/local login path.
 * Given an email, resolves all tenant memberships and checks if any
 * has SSO enforced.
 *
 * Returns:
 *   - { allowed: true } — local login permitted
 *   - { allowed: false, tenantSlug, providerName } — must use SSO
 *   - { allowed: true } — break-glass admin
 */
export async function checkSsoEnforcementForEmail(
    email: string
): Promise<{
    allowed: boolean;
    enforced?: {
        tenantSlug: string;
        tenantName: string;
        providerName: string;
        providerId: string;
        providerType: string;
    };
}> {
    const normalizedEmail = email.toLowerCase();

    // Find user
    const user = await prisma.user.findFirst({
        where: { emailHash: { in: hashForLookupCandidates(normalizedEmail) } },
        select: {
            id: true,
            passwordHash: true,
            tenantMemberships: {
                include: {
                    tenant: { select: { id: true, slug: true, name: true } },
                },
            },
        },
    });

    if (!user) return { allowed: true }; // User doesn't exist yet — let normal auth handle it

    // Check each membership for SSO enforcement
    for (const membership of user.tenantMemberships) {
        const enforcedProvider = await prisma.tenantIdentityProvider.findFirst({
            where: {
                tenantId: membership.tenantId,
                isEnabled: true,
                isEnforced: true,
            },
        });

        if (enforcedProvider) {
            // SSO is enforced in this tenant — check break-glass
            const isBreakGlass = membership.role === 'ADMIN' && !!user.passwordHash;

            if (!isBreakGlass) {
                return {
                    allowed: false,
                    enforced: {
                        tenantSlug: membership.tenant.slug,
                        tenantName: membership.tenant.name,
                        providerName: enforcedProvider.name,
                        providerId: enforcedProvider.id,
                        providerType: enforcedProvider.type,
                    },
                };
            }
        }
    }

    return { allowed: true };
}

// ─── Identity Link Admin ────────────────────────────────────────────

/**
 * List all identity links for a user. Requires ADMIN role.
 */
export async function getIdentityLinks(
    ctx: RequestContext,
    userId: string
): Promise<UserIdentityLink[]> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can view identity links');
    return IdentityLinkRepo.findByUserId(userId);
}

/**
 * Remove an identity link for a user. Requires ADMIN role.
 */
export async function unlinkIdentity(
    ctx: RequestContext,
    userId: string,
    providerId: string
): Promise<void> {
    if (!ctx.permissions.canAdmin) throw forbidden('Only admins can manage identity links');
    await IdentityLinkRepo.unlinkIdentity(userId, providerId);
}
