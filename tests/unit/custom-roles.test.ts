/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Custom Role CRUD Usecase Tests
 *
 * Verifies:
 * 1. Admin can create a valid custom role
 * 2. Invalid permissions JSON is rejected
 * 3. Admin can update a custom role
 * 4. Admin can delete (soft-delete) a custom role
 * 5. Admin can assign/unassign a custom role
 * 6. Non-admin cannot access role management
 * 7. Duplicate role names rejected
 * 8. Deleting clears customRoleId on members
 */
import { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';
import type { Role } from '@prisma/client';

// ─── Mock db-context ───
const mockTx: Record<string, any> = {};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => {
        return fn(mockTx);
    }),
}));

// ─── Mock audit ───
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async () => undefined),
}));

import {
    listCustomRoles,
    createCustomRole,
    updateCustomRole,
    deleteCustomRole,
    assignCustomRole,
} from '@/app-layer/usecases/custom-roles';

// ─── Helpers ───

function makeCtx(role: Role = 'ADMIN', userId = 'user-1'): RequestContext {
    return {
        requestId: 'req-test',
        userId,
        tenantId: 'tenant-1',
        tenantSlug: 'acme-co',
        role,
        permissions: {
            canRead: true,
            canWrite: role !== 'READER',
            canAdmin: role === 'ADMIN',
            canAudit: role === 'ADMIN' || role === 'AUDITOR',
            canExport: role !== 'READER',
        },
        appPermissions: getPermissionsForRole(role),
    };
}

const VALID_PERMISSIONS = getPermissionsForRole('EDITOR');

beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockTx).forEach(k => delete mockTx[k]);
});

// ─── Authorization Tests ───

describe('Custom Roles — Authorization', () => {
    const NON_ADMIN_ROLES: Role[] = ['EDITOR', 'READER', 'AUDITOR'];

    NON_ADMIN_ROLES.forEach((role) => {
        it(`${role} cannot list custom roles`, async () => {
            await expect(listCustomRoles(makeCtx(role))).rejects.toThrow(/permission|admin/i);
        });

        it(`${role} cannot create custom roles`, async () => {
            await expect(
                createCustomRole(makeCtx(role), {
                    name: 'Test Role',
                    baseRole: 'READER',
                    permissionsJson: VALID_PERMISSIONS,
                })
            ).rejects.toThrow(/permission|admin/i);
        });

        it(`${role} cannot update custom roles`, async () => {
            await expect(
                updateCustomRole(makeCtx(role), 'role-1', { name: 'New Name' })
            ).rejects.toThrow(/permission|admin/i);
        });

        it(`${role} cannot delete custom roles`, async () => {
            await expect(deleteCustomRole(makeCtx(role), 'role-1')).rejects.toThrow(/permission|admin/i);
        });

        it(`${role} cannot assign custom roles`, async () => {
            await expect(assignCustomRole(makeCtx(role), 'm-1', 'role-1')).rejects.toThrow(/permission|admin/i);
        });
    });
});

// ─── Create Tests ───

describe('Custom Roles — Create', () => {
    it('creates a valid custom role', async () => {
        const created = {
            id: 'cr-1',
            tenantId: 'tenant-1',
            name: 'Compliance Lead',
            description: 'Lead for compliance team',
            baseRole: 'EDITOR',
            permissionsJson: VALID_PERMISSIONS,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => null), // no duplicate
            create: jest.fn(async () => created),
        };

        const result = await createCustomRole(makeCtx(), {
            name: 'Compliance Lead',
            description: 'Lead for compliance team',
            baseRole: 'EDITOR',
            permissionsJson: VALID_PERMISSIONS,
        });

        expect(result.name).toBe('Compliance Lead');
        expect(mockTx.tenantCustomRole.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    tenantId: 'tenant-1',
                    name: 'Compliance Lead',
                    baseRole: 'EDITOR',
                }),
            })
        );
    });

    it('rejects invalid permissions JSON', async () => {
        await expect(
            createCustomRole(makeCtx(), {
                name: 'Bad Role',
                baseRole: 'READER',
                permissionsJson: { practices: 'not-an-object' },
            })
        ).rejects.toThrow(/Invalid permissions/);
    });

    it('rejects empty name', async () => {
        await expect(
            createCustomRole(makeCtx(), {
                name: '   ',
                baseRole: 'READER',
                permissionsJson: VALID_PERMISSIONS,
            })
        ).rejects.toThrow(/name/i);
    });

    it('rejects duplicate name within tenant', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => ({ id: 'existing' })), // duplicate exists
        };

        await expect(
            createCustomRole(makeCtx(), {
                name: 'Duplicate Role',
                baseRole: 'READER',
                permissionsJson: VALID_PERMISSIONS,
            })
        ).rejects.toThrow(/already exists/);
    });

    it('rejects missing permission domains', async () => {
        await expect(
            createCustomRole(makeCtx(), {
                name: 'Incomplete',
                baseRole: 'READER',
                permissionsJson: { practices: { view: true, create: false, edit: false } },
            })
        ).rejects.toThrow(/Invalid permissions/);
    });
});

// ─── Update Tests ───

describe('Custom Roles — Update', () => {
    const existingRole = {
        id: 'cr-1',
        tenantId: 'tenant-1',
        name: 'Old Name',
        baseRole: 'READER',
        isActive: true,
    };

    it('updates a custom role name', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn()
                .mockResolvedValueOnce(existingRole) // find existing
                .mockResolvedValueOnce(null), // no duplicate
            update: jest.fn(async () => ({ ...existingRole, name: 'New Name' })),
        };

        const result = await updateCustomRole(makeCtx(), 'cr-1', { name: 'New Name' });
        expect(result.name).toBe('New Name');
    });

    it('updates permissions with validation', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => existingRole),
            update: jest.fn(async () => ({ ...existingRole, permissionsJson: VALID_PERMISSIONS })),
        };

        const result = await updateCustomRole(makeCtx(), 'cr-1', {
            permissionsJson: VALID_PERMISSIONS,
        });
        expect(result.permissionsJson).toEqual(VALID_PERMISSIONS);
    });

    it('rejects invalid permissions on update', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => existingRole),
        };

        await expect(
            updateCustomRole(makeCtx(), 'cr-1', {
                permissionsJson: { practices: 'invalid' },
            })
        ).rejects.toThrow(/Invalid permissions/);
    });

    it('rejects update with no fields', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => existingRole),
        };

        await expect(
            updateCustomRole(makeCtx(), 'cr-1', {})
        ).rejects.toThrow(/No fields/);
    });

    it('returns not found for missing role', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => null),
        };

        await expect(
            updateCustomRole(makeCtx(), 'missing', { name: 'X' })
        ).rejects.toThrow(/not found/i);
    });
});

// ─── Delete Tests ───

describe('Custom Roles — Delete', () => {
    it('soft-deletes a role and clears member assignments', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => ({
                id: 'cr-1',
                tenantId: 'tenant-1',
                name: 'To Delete',
                isActive: true,
            })),
            update: jest.fn(async () => ({ id: 'cr-1', isActive: false })),
        };
        mockTx.tenantMembership = {
            updateMany: jest.fn(async () => ({ count: 3 })),
        };

        const result = await deleteCustomRole(makeCtx(), 'cr-1');
        expect(result.deleted.isActive).toBe(false);
        expect(result.membersCleared).toBe(3);
        expect(mockTx.tenantMembership.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ customRoleId: 'cr-1' }),
                data: { customRoleId: null },
            })
        );
    });

    it('returns not found for missing role', async () => {
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => null),
        };

        await expect(deleteCustomRole(makeCtx(), 'missing')).rejects.toThrow(/not found/i);
    });
});

// ─── Assign Tests ───

describe('Custom Roles — Assign', () => {
    const activeMembership = {
        id: 'm-1',
        tenantId: 'tenant-1',
        userId: 'user-2',
        role: 'READER',
        customRoleId: null,
        status: 'ACTIVE',
        user: { id: 'user-2', name: 'Test', email: 'test@t.com' },
    };

    it('assigns a custom role to a member', async () => {
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => activeMembership),
            update: jest.fn(async () => ({
                ...activeMembership,
                customRoleId: 'cr-1',
                customRole: { id: 'cr-1', name: 'Compliance Lead' },
            })),
        };
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => ({ id: 'cr-1', tenantId: 'tenant-1', isActive: true })),
        };

        const result = await assignCustomRole(makeCtx(), 'm-1', 'cr-1');
        expect(result.customRoleId).toBe('cr-1');
        expect(mockTx.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: { customRoleId: 'cr-1' },
            })
        );
    });

    it('unassigns a custom role (null)', async () => {
        const memberWithRole = { ...activeMembership, customRoleId: 'cr-1' };
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => memberWithRole),
            update: jest.fn(async () => ({
                ...memberWithRole,
                customRoleId: null,
                customRole: null,
            })),
        };

        const result = await assignCustomRole(makeCtx(), 'm-1', null);
        expect(result.customRoleId).toBeNull();
    });

    it('rejects assigning an inactive custom role', async () => {
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => activeMembership),
        };
        mockTx.tenantCustomRole = {
            findFirst: jest.fn(async () => null), // not found or inactive
        };

        await expect(
            assignCustomRole(makeCtx(), 'm-1', 'cr-inactive')
        ).rejects.toThrow(/not found|inactive/i);
    });

    it('rejects assigning to a non-existent member', async () => {
        mockTx.tenantMembership = {
            findFirst: jest.fn(async () => null),
        };

        await expect(
            assignCustomRole(makeCtx(), 'missing', 'cr-1')
        ).rejects.toThrow(/not found/i);
    });
});
