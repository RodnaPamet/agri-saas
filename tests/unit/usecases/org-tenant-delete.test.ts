/**
 * Unit tests for `deleteTenantUnderOrg` (soft-delete / "remove tenant"
 * from the org admin panel).
 *
 * Contract:
 *   - Only a tenant that belongs to THIS org and isn't already removed
 *     is reachable (org-scoped findFirst). A foreign/unknown id is a
 *     notFound — never touches another org's tenant.
 *   - On success it sets `deletedAt` (soft-delete; data retained) and
 *     does NOT delete the row or its children.
 */

const findFirst = jest.fn();
const update = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: {
            findFirst: (...a: unknown[]) => findFirst(...a),
            update: (...a: unknown[]) => update(...a),
        },
    },
}));
// org-tenants.ts pulls these in at module load.
jest.mock('@/lib/security/tenant-keys', () => ({
    generateAndWrapDek: jest.fn(() => ({ wrapped: 'x' })),
}));
jest.mock('@/app-layer/usecases/org-provisioning', () => ({
    provisionAllOrgAdminsToTenant: jest.fn(),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { deleteTenantUnderOrg } from '@/app-layer/usecases/org-tenants';
import type { OrgContext } from '@/app-layer/types';

const ctx = {
    organizationId: 'org-1',
    userId: 'u-1',
    orgSlug: 'acme',
    requestId: 'req-1',
    orgRole: 'ORG_ADMIN',
    permissions: {},
} as unknown as OrgContext;

describe('deleteTenantUnderOrg', () => {
    beforeEach(() => {
        findFirst.mockReset();
        update.mockReset();
    });

    it('soft-deletes a tenant belonging to the org (sets deletedAt, no hard delete)', async () => {
        findFirst.mockResolvedValue({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });
        update.mockResolvedValue({});

        const res = await deleteTenantUnderOrg(ctx, 't-1');

        // Looked it up scoped to the org + not-already-deleted.
        expect(findFirst.mock.calls[0][0].where).toMatchObject({
            id: 't-1',
            organizationId: 'org-1',
            deletedAt: null,
        });
        // Soft-delete: update sets deletedAt, targets the row by id.
        const upd = update.mock.calls[0][0];
        expect(upd.where).toEqual({ id: 't-1' });
        expect(upd.data.deletedAt).toBeInstanceOf(Date);
        expect(res.tenant).toEqual({ id: 't-1', slug: 'pwc-nis2', name: 'pwc-nis2' });
    });

    it('rejects (notFound) a tenant not in this org — never updates', async () => {
        findFirst.mockResolvedValue(null);
        await expect(deleteTenantUnderOrg(ctx, 'foreign')).rejects.toThrow();
        expect(update).not.toHaveBeenCalled();
    });
});
