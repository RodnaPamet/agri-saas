/**
 * SSO Identity Linking and Tenant Resolution Tests
 *
 * Tests the usecase logic for identity linking, SSO enforcement,
 * tenant resolution, and cross-tenant rejection.
 *
 * Updated for LinkResult return type with explicit rejection reasons.
 */

// ─── Mocks ──────────────────────────────────────────────────────────

// Mock prisma before importing usecases
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: { findUnique: jest.fn() },
        tenantMembership: { findUnique: jest.fn(), findMany: jest.fn() },
        user: (() => {
            // #1237: the email lookup is `findFirst` over the candidate list
            // (an `in` predicate is not valid on `findUnique`). ONE fn behind
            // both names, so a test's single `mockResolvedValue` drives the
            // code whichever method it calls — two separate fns silently stop
            // reaching it and every lookup reports "not found".
            const find = jest.fn();
            return { findUnique: find, findFirst: find };
        })(),
        tenantIdentityProvider: { findMany: jest.fn(), findFirst: jest.fn() },
        userIdentityLink: {
            findUnique: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            deleteMany: jest.fn(),
            findMany: jest.fn(),
        },
    },
}));

jest.mock('@/lib/errors/types', () => ({
    forbidden: (msg: string) => {
        const err = new Error(msg);
        (err as unknown as Record<string, unknown>).statusCode = 403;
        return err;
    },
    notFound: (msg: string) => {
        const err = new Error(msg);
        (err as unknown as Record<string, unknown>).statusCode = 404;
        return err;
    },
}));

import prisma from '@/lib/prisma';
import {
    linkExternalIdentity,
    isLocalLoginAllowed,
    resolveSsoForTenant,
    resolveSsoByDomain,
} from '@/app-layer/usecases/sso';

const mockPrisma = prisma as unknown as {
    tenant: { findUnique: jest.Mock };
    tenantMembership: { findUnique: jest.Mock; findMany: jest.Mock };
    user: { findUnique: jest.Mock; findFirst: jest.Mock };
    tenantIdentityProvider: { findMany: jest.Mock; findFirst: jest.Mock };
    userIdentityLink: {
        findUnique: jest.Mock;
        create: jest.Mock;
        update: jest.Mock;
        deleteMany: jest.Mock;
        findMany: jest.Mock;
    };
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('linkExternalIdentity', () => {
    const TENANT_ID = 'tenant-1';
    const PROVIDER_ID = 'provider-1';
    const SUBJECT = 'external-sub-123';
    const EMAIL = 'alice@acme.com';

    it('returns existing user if identity link already exists for this tenant', async () => {
        // Provider with no domain restrictions
        mockPrisma.tenantIdentityProvider.findFirst.mockResolvedValueOnce({
            id: PROVIDER_ID, tenantId: TENANT_ID, emailDomains: [], configJson: {},
        });
        mockPrisma.userIdentityLink.findUnique.mockResolvedValueOnce({
            id: 'link-1',
            userId: 'user-1',
            tenantId: TENANT_ID,
            providerId: PROVIDER_ID,
            externalSubject: SUBJECT,
        });

        // updateLastLogin mock
        mockPrisma.userIdentityLink.update.mockResolvedValueOnce({});

        const result = await linkExternalIdentity(TENANT_ID, PROVIDER_ID, SUBJECT, EMAIL);
        expect(result).toEqual({ status: 'linked', userId: 'user-1', isNewLink: false });
    });

    it('rejects if existing link belongs to a different tenant (cross-tenant attack)', async () => {
        mockPrisma.tenantIdentityProvider.findFirst.mockResolvedValueOnce({
            id: PROVIDER_ID, tenantId: TENANT_ID, emailDomains: [], configJson: {},
        });
        mockPrisma.userIdentityLink.findUnique.mockResolvedValueOnce({
            id: 'link-1',
            userId: 'user-1',
            tenantId: 'other-tenant', // Different tenant!
            providerId: PROVIDER_ID,
            externalSubject: SUBJECT,
        });

        const result = await linkExternalIdentity(TENANT_ID, PROVIDER_ID, SUBJECT, EMAIL);
        expect(result).toEqual({ status: 'rejected', reason: 'cross_tenant' });
    });

    it('creates a new link if user exists with membership but no prior link', async () => {
        mockPrisma.tenantIdentityProvider.findFirst.mockResolvedValueOnce({
            id: PROVIDER_ID, tenantId: TENANT_ID, emailDomains: [], configJson: {},
        });
        // No existing link by subject
        mockPrisma.userIdentityLink.findUnique
            .mockResolvedValueOnce(null)   // findByProviderAndSubject
            .mockResolvedValueOnce(null);  // findByUserAndProvider

        // User exists
        mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'user-1' });

        // User has membership
        mockPrisma.tenantMembership.findUnique.mockResolvedValueOnce({
            tenantId: TENANT_ID,
            userId: 'user-1',
            role: 'EDITOR',
        });

        // Create link
        mockPrisma.userIdentityLink.create.mockResolvedValueOnce({
            id: 'link-new',
            userId: 'user-1',
        });

        const result = await linkExternalIdentity(TENANT_ID, PROVIDER_ID, SUBJECT, EMAIL);
        expect(result).toEqual({ status: 'linked', userId: 'user-1', isNewLink: true });
        expect(mockPrisma.userIdentityLink.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 'user-1',
                tenantId: TENANT_ID,
                providerId: PROVIDER_ID,
                externalSubject: SUBJECT,
                emailAtLinkTime: EMAIL.toLowerCase(),
            }),
        });
    });

    it('rejects if user has no membership in the target tenant', async () => {
        mockPrisma.tenantIdentityProvider.findFirst.mockResolvedValueOnce({
            id: PROVIDER_ID, tenantId: TENANT_ID, emailDomains: [], configJson: {},
        });
        mockPrisma.userIdentityLink.findUnique.mockResolvedValueOnce(null);
        mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'user-1' });
        mockPrisma.tenantMembership.findUnique.mockResolvedValueOnce(null);

        const result = await linkExternalIdentity(TENANT_ID, PROVIDER_ID, SUBJECT, EMAIL);
        expect(result).toEqual({ status: 'rejected', reason: 'no_membership' });
    });

    it('rejects if no user matches the email (JIT disabled)', async () => {
        mockPrisma.tenantIdentityProvider.findFirst.mockResolvedValueOnce({
            id: PROVIDER_ID, tenantId: TENANT_ID, emailDomains: [], configJson: {},
        });
        mockPrisma.userIdentityLink.findUnique.mockResolvedValueOnce(null);
        mockPrisma.user.findUnique.mockResolvedValueOnce(null);

        const result = await linkExternalIdentity(TENANT_ID, PROVIDER_ID, SUBJECT, EMAIL);
        expect(result).toEqual({ status: 'rejected', reason: 'jit_disabled' });
    });

    it('rejects if user already has a different subject linked for this provider', async () => {
        mockPrisma.tenantIdentityProvider.findFirst.mockResolvedValueOnce({
            id: PROVIDER_ID, tenantId: TENANT_ID, emailDomains: [], configJson: {},
        });
        mockPrisma.userIdentityLink.findUnique
            .mockResolvedValueOnce(null)                        // No link by subject
            .mockResolvedValueOnce({ id: 'existing-link' });    // Has existing link for provider

        mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'user-1' });
        mockPrisma.tenantMembership.findUnique.mockResolvedValueOnce({
            tenantId: TENANT_ID,
            userId: 'user-1',
        });

        const result = await linkExternalIdentity(TENANT_ID, PROVIDER_ID, SUBJECT, EMAIL);
        expect(result).toEqual({ status: 'rejected', reason: 'subject_conflict' });
    });

    it('rejects email not matching allowed domains', async () => {
        mockPrisma.tenantIdentityProvider.findFirst.mockResolvedValueOnce({
            id: PROVIDER_ID, tenantId: TENANT_ID,
            emailDomains: ['acme.com'], // Only acme.com allowed
            configJson: {},
        });

        // Try with wrong domain
        const result = await linkExternalIdentity(TENANT_ID, PROVIDER_ID, SUBJECT, 'user@evil.com');
        expect(result).toEqual({ status: 'rejected', reason: 'domain_mismatch' });
    });
});

describe('isLocalLoginAllowed', () => {
    const TENANT_ID = 'tenant-1';
    const USER_ID = 'user-1';

    it('allows local login when no SSO enforcement is active', async () => {
        mockPrisma.tenantIdentityProvider.findMany.mockResolvedValueOnce([]);

        const result = await isLocalLoginAllowed(TENANT_ID, USER_ID);
        expect(result).toBe(true);
    });

    it('blocks local login for non-admin when SSO is enforced', async () => {
        mockPrisma.tenantIdentityProvider.findMany.mockResolvedValueOnce([
            { id: 'p1', isEnabled: true, isEnforced: true },
        ]);
        mockPrisma.tenantMembership.findUnique.mockResolvedValueOnce({
            role: 'EDITOR',
        });

        const result = await isLocalLoginAllowed(TENANT_ID, USER_ID);
        expect(result).toBe(false);
    });

    it('allows local login for admin with password (break-glass)', async () => {
        mockPrisma.tenantIdentityProvider.findMany.mockResolvedValueOnce([
            { id: 'p1', isEnabled: true, isEnforced: true },
        ]);
        mockPrisma.tenantMembership.findUnique.mockResolvedValueOnce({
            role: 'ADMIN',
        });
        mockPrisma.user.findUnique.mockResolvedValueOnce({
            passwordHash: '$2b$12$...',
        });

        const result = await isLocalLoginAllowed(TENANT_ID, USER_ID);
        expect(result).toBe(true);
    });

    it('blocks local login for admin without password when SSO is enforced', async () => {
        mockPrisma.tenantIdentityProvider.findMany.mockResolvedValueOnce([
            { id: 'p1', isEnabled: true, isEnforced: true },
        ]);
        mockPrisma.tenantMembership.findUnique.mockResolvedValueOnce({
            role: 'ADMIN',
        });
        mockPrisma.user.findUnique.mockResolvedValueOnce({
            passwordHash: null,
        });

        const result = await isLocalLoginAllowed(TENANT_ID, USER_ID);
        expect(result).toBe(false);
    });
});

describe('resolveSsoForTenant', () => {
    it('returns hasSso: false if tenant not found', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValueOnce(null);

        const result = await resolveSsoForTenant('nonexistent');
        expect(result).toEqual({ hasSso: false, isEnforced: false, providers: [] });
    });

    it('returns hasSso: false if no enabled providers', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValueOnce({ id: 'tenant-1' });
        mockPrisma.tenantIdentityProvider.findMany.mockResolvedValueOnce([]);

        const result = await resolveSsoForTenant('acme');
        expect(result).toEqual({ hasSso: false, isEnforced: false, providers: [] });
    });

    it('returns enabled providers without exposing configJson', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValueOnce({ id: 'tenant-1' });
        mockPrisma.tenantIdentityProvider.findMany.mockResolvedValueOnce([
            { id: 'p1', type: 'SAML', name: 'Okta', isEnforced: false },
        ]);

        const result = await resolveSsoForTenant('acme');
        expect(result.hasSso).toBe(true);
        expect(result.providers).toEqual([
            { id: 'p1', type: 'SAML', name: 'Okta' },
        ]);
        // Ensure no config secrets leaked
        expect((result.providers[0] as Record<string, unknown>).configJson).toBeUndefined();
    });

    it('sets isEnforced: true if any provider is enforced', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValueOnce({ id: 'tenant-1' });
        mockPrisma.tenantIdentityProvider.findMany.mockResolvedValueOnce([
            { id: 'p1', type: 'SAML', name: 'Okta', isEnforced: true },
            { id: 'p2', type: 'OIDC', name: 'Azure', isEnforced: false },
        ]);

        const result = await resolveSsoForTenant('acme');
        expect(result.isEnforced).toBe(true);
    });
});

describe('resolveSsoByDomain', () => {
    it('returns found: false for email without domain', async () => {
        const result = await resolveSsoByDomain('nodomain');
        expect(result.found).toBe(false);
    });

    it('returns found: false when no provider claims the domain', async () => {
        mockPrisma.tenantIdentityProvider.findFirst.mockResolvedValueOnce(null);

        const result = await resolveSsoByDomain('alice@unknown.com');
        expect(result.found).toBe(false);
    });

    it('returns provider info when domain matches', async () => {
        mockPrisma.tenantIdentityProvider.findFirst.mockResolvedValueOnce({
            id: 'p1',
            name: 'Okta',
            tenantId: 'tenant-1',
        });
        mockPrisma.tenant.findUnique.mockResolvedValueOnce({ slug: 'acme-corp' });

        const result = await resolveSsoByDomain('alice@acme.com');
        expect(result).toEqual({
            found: true,
            tenantSlug: 'acme-corp',
            providerId: 'p1',
            providerName: 'Okta',
        });
    });
});
