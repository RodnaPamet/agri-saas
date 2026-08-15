/**
 * Unit tests for the server-side tenant context resolver.
 *
 * Tests resolveTenantBySlug and getTenantServerContext from
 * @/lib/server/tenant-context.server.
 *
 * Uses mocked Prisma client (same pattern as tenant-context.test.ts).
 */

// ─── Mocks ───

const mockPrisma = {
    tenant: {
        findUnique: jest.fn(),
    },
    tenantMembership: {
        findUnique: jest.fn(),
    },
};

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: mockPrisma,
}));

import {
    resolveTenantBySlug,
    getTenantServerContext,
} from '@/lib/server/tenant-context.server';

// ─── Test fixtures ───

const TENANT = {
    id: 'tenant-1',
    slug: 'acme-corp',
    name: 'Acme Corp',
    industry: 'Tech',
    scope: null,
    context: null,
    interestedParties: null,
    boundaries: null,
    exclusions: null,
    reminderDaysBefore: 14,
    maxRiskScale: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
};

const MEMBERSHIP_ADMIN = {
    id: 'member-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    role: 'ADMIN' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
};

const MEMBERSHIP_EDITOR = {
    ...MEMBERSHIP_ADMIN,
    id: 'member-2',
    role: 'EDITOR' as const,
};

const MEMBERSHIP_DEACTIVATED = {
    ...MEMBERSHIP_ADMIN,
    id: 'member-3',
    status: 'DEACTIVATED',
};

// ─── resolveTenantBySlug ───

describe('resolveTenantBySlug', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns tenant record for valid slug', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            slug: 'acme-corp',
            name: 'Acme Corp',
        });

        const result = await resolveTenantBySlug('acme-corp');

        expect(result).toEqual({
            id: 'tenant-1',
            slug: 'acme-corp',
            name: 'Acme Corp',
        });
        expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
            where: { slug: 'acme-corp' },
            select: { id: true, slug: true, name: true, currencySymbol: true },
        });
    });

    it('throws NOT_FOUND for unknown slug', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(null);

        await expect(
            resolveTenantBySlug('does-not-exist')
        ).rejects.toThrow('Tenant not found');
    });

    it('only selects id, slug, name, currencySymbol (no overfetch)', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            slug: 'acme-corp',
            name: 'Acme Corp',
        });

        await resolveTenantBySlug('acme-corp');

        const call = mockPrisma.tenant.findUnique.mock.calls[0][0];
        expect(call.select).toEqual({ id: true, slug: true, name: true, currencySymbol: true });
    });
});

// ─── getTenantServerContext ───

describe('getTenantServerContext', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns full context for valid slug and membership', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(TENANT);
        mockPrisma.tenantMembership.findUnique.mockResolvedValue(MEMBERSHIP_ADMIN);

        const ctx = await getTenantServerContext({
            tenantSlug: 'acme-corp',
            userId: 'user-1',
        });

        expect(ctx.tenant).toEqual({
            id: 'tenant-1',
            slug: 'acme-corp',
            name: 'Acme Corp',
            // RQ3-OB-A — mock tenants without the column fall back to €.
            currencySymbol: '€',
        });
        expect(ctx.role).toBe('ADMIN');
        expect(ctx.permissions.canRead).toBe(true);
        expect(ctx.permissions.canWrite).toBe(true);
        expect(ctx.permissions.canAdmin).toBe(true);
    });

    it('returns correct editor permissions', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(TENANT);
        mockPrisma.tenantMembership.findUnique.mockResolvedValue(MEMBERSHIP_EDITOR);

        const ctx = await getTenantServerContext({
            tenantSlug: 'acme-corp',
            userId: 'user-1',
        });

        expect(ctx.role).toBe('EDITOR');
        expect(ctx.permissions.canWrite).toBe(true);
        expect(ctx.permissions.canAdmin).toBe(false);
    });

    it('throws for unknown tenant slug', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(null);

        await expect(
            getTenantServerContext({ tenantSlug: 'ghost', userId: 'user-1' })
        ).rejects.toThrow('Tenant not found');
    });

    it('throws for non-member user', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(TENANT);
        mockPrisma.tenantMembership.findUnique.mockResolvedValue(null);

        await expect(
            getTenantServerContext({ tenantSlug: 'acme-corp', userId: 'outsider' })
        ).rejects.toThrow('Not a member of this tenant');
    });

    it('throws for deactivated member', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(TENANT);
        mockPrisma.tenantMembership.findUnique.mockResolvedValue(MEMBERSHIP_DEACTIVATED);

        await expect(
            getTenantServerContext({ tenantSlug: 'acme-corp', userId: 'user-1' })
        ).rejects.toThrow(/deactivated/i);
    });

    it('returns plain serializable object (no Prisma model types)', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(TENANT);
        mockPrisma.tenantMembership.findUnique.mockResolvedValue(MEMBERSHIP_ADMIN);

        const ctx = await getTenantServerContext({
            tenantSlug: 'acme-corp',
            userId: 'user-1',
        });

        // The tenant field must be a plain object, not a Prisma model.
        // It should only contain id, slug, name — no createdAt, updatedAt, etc.
        const tenantKeys = Object.keys(ctx.tenant).sort();
        expect(tenantKeys).toEqual(['currencySymbol', 'id', 'name', 'slug']);

        // Should be JSON-safe (no Date objects or circular refs)
        expect(() => JSON.stringify(ctx)).not.toThrow();
    });

    it('includes appPermissions for ADMIN', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(TENANT);
        mockPrisma.tenantMembership.findUnique.mockResolvedValue(MEMBERSHIP_ADMIN);

        const ctx = await getTenantServerContext({
            tenantSlug: 'acme-corp',
            userId: 'user-1',
        });

        // appPermissions should have the expected shape.
        // GRC teardown phase 2 removed the practices domain; `tasks` is
        // the surviving content domain and proves the same bound — an
        // ADMIN gets content access AND admin access.
        expect(ctx.appPermissions).toBeDefined();
        expect(ctx.appPermissions.tasks).toBeDefined();
        expect(ctx.appPermissions.tasks.view).toBe(true);
        expect(ctx.appPermissions.admin.manage).toBe(true);
    });

    it('restricts appPermissions for EDITOR (no admin)', async () => {
        mockPrisma.tenant.findUnique.mockResolvedValue(TENANT);
        mockPrisma.tenantMembership.findUnique.mockResolvedValue(MEMBERSHIP_EDITOR);

        const ctx = await getTenantServerContext({
            tenantSlug: 'acme-corp',
            userId: 'user-1',
        });

        // Same bound as before the GRC teardown removed the practices
        // domain: an EDITOR keeps full content read/write but gets no
        // admin flag. `tasks` is the surviving content domain.
        expect(ctx.appPermissions.admin.view).toBe(false);
        expect(ctx.appPermissions.admin.manage).toBe(false);
        expect(ctx.appPermissions.tasks.view).toBe(true);
        expect(ctx.appPermissions.tasks.edit).toBe(true);
    });
});
