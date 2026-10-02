/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/scim-users.ts
 *
 * Wave 5 of GAP-02. SCIM is the only path by which an external IdP
 * (Okta, Azure AD, Google Workspace) provisions users into the
 * tenant. The security contract is unique because SCIM has no user
 * session — `actorType: 'SCIM'` audit entries record the IdP-driven
 * mutations. Three load-bearing invariants:
 *
 *   1. ADMIN role can NEVER be granted via SCIM. The IdP can send
 *      `roles: [{ value: "admin" }]` and the usecase silently blocks
 *      it, falling back to READER + emitting a warning. A regression
 *      that mapped "admin" → ADMIN is a privilege-escalation path
 *      the security team has no visibility into (the IdP isn't in
 *      the local audit chain).
 *   2. SCIM cannot demote an ADMIN. If a tenant member was
 *      independently elevated to ADMIN by a tenant owner, a later
 *      SCIM patch with `roles: [{ value: "reader" }]` must NOT
 *      strip the admin powers — that would let an IdP integration
 *      lock out tenant admins.
 *   3. Every lookup is keyed on `ctx.tenantId`. A SCIM token for
 *      tenant A presenting a user id from tenant B must return null,
 *      not silently mutate the wrong row.
 */

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: (() => {
            // #1237: the email lookup is `findFirst` over the candidate list
            // (an `in` predicate is not valid on `findUnique`). ONE fn behind
            // both names, so a test's single `mockResolvedValue` drives the
            // code whichever method it calls — two separate fns silently stop
            // reaching it and every lookup reports "not found".
            const find = jest.fn();
            return { update: jest.fn(), findUnique: find, findFirst: find };
        })(),
        tenantMembership: {
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            count: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

jest.mock('@/lib/audit/audit-writer', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

import {
    resolveScimRole,
    scimCreateUser,
    scimGetUser,
    scimPatchUser,
    scimPutUser,
    scimDeleteUser,
    toScimUser,
} from '@/app-layer/usecases/scim-users';
import prisma from '@/lib/prisma';
import { appendAuditEntry } from '@/lib/audit/audit-writer';

const mockUserFindUnique = prisma.user.findUnique as jest.MockedFunction<typeof prisma.user.findUnique>;
const mockMembershipFindFirst = prisma.tenantMembership.findFirst as jest.MockedFunction<typeof prisma.tenantMembership.findFirst>;
const mockMembershipFindUnique = prisma.tenantMembership.findUnique as jest.MockedFunction<typeof prisma.tenantMembership.findUnique>;
const mockMembershipCreate = prisma.tenantMembership.create as jest.MockedFunction<typeof prisma.tenantMembership.create>;
const mockMembershipUpdate = prisma.tenantMembership.update as jest.MockedFunction<typeof prisma.tenantMembership.update>;
const mockTransaction = prisma.$transaction as jest.MockedFunction<any>;
const mockAppendAudit = appendAuditEntry as jest.MockedFunction<typeof appendAuditEntry>;

const scimCtx = (tenantId = 'tenant-1') => ({
    tenantId,
    tokenLabel: 'okta-prod',
    tokenId: 'tok-1',
});

beforeEach(() => {
    jest.clearAllMocks();
});

describe('resolveScimRole — ADMIN block + allow-list', () => {
    it('blocks "admin" silently — falls back to READER with blocked=true', () => {
        const result = resolveScimRole('admin');
        // Regression: a refactor that added "admin" to the allow-list
        // is a privilege-escalation path the IdP can mint silently.
        expect(result.role).toBe('READER');
        expect(result.blocked).toBe(true);
        expect(result.requestedRole).toBe('admin');
    });

    it('blocks any unmapped value (typos, custom labels) with blocked=true', () => {
        const result = resolveScimRole('superadmin');
        expect(result.role).toBe('READER');
        expect(result.blocked).toBe(true);
    });

    it('case-insensitive mapping — "EDITOR", "Editor", "editor" all → EDITOR', () => {
        expect(resolveScimRole('EDITOR').role).toBe('EDITOR');
        expect(resolveScimRole('Editor').role).toBe('EDITOR');
        expect(resolveScimRole('editor').role).toBe('EDITOR');
    });

    it('returns READER + blocked=false when no value is supplied (default)', () => {
        const result = resolveScimRole(undefined);
        expect(result.role).toBe('READER');
        expect(result.blocked).toBe(false);
    });
});

describe('toScimUser — name parsing + active flag', () => {
    it('marks user inactive when membership is null or status≠ACTIVE', () => {
        const user = {
            id: 'u1', email: 'a@b.com', name: 'Alice Doe',
            createdAt: new Date(), updatedAt: new Date(),
        };
        const inactive = toScimUser(user, { status: 'DEACTIVATED' }, 'https://x');
        expect(inactive.active).toBe(false);

        const noMembership = toScimUser(user, null, 'https://x');
        expect(noMembership.active).toBe(false);
    });
});

describe('scimGetUser — tenant scoping', () => {
    it('returns null when user belongs to a DIFFERENT tenant', async () => {
        mockMembershipFindFirst.mockResolvedValueOnce(null);

        const result = await scimGetUser(scimCtx('tenant-A'), 'tenant-B-user', 'https://x');

        expect(result).toBeNull();
        expect(mockMembershipFindFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: 'tenant-A', userId: 'tenant-B-user' },
            }),
        );
        // Regression: a refactor that dropped the tenantId from the
        // WHERE would let a SCIM token for tenant A read users from
        // tenant B by id — cross-tenant disclosure.
    });
});

describe('scimCreateUser — idempotency + reactivation', () => {
    it('returns existing user with created=false when membership is already ACTIVE (idempotent)', async () => {
        mockUserFindUnique.mockResolvedValueOnce({
            id: 'u1', email: 'a@b.com', name: 'A',
            createdAt: new Date(), updatedAt: new Date(),
        } as never);
        mockMembershipFindUnique.mockResolvedValueOnce({
            id: 'm1', status: 'ACTIVE', role: 'EDITOR',
        } as never);

        const result = await scimCreateUser(scimCtx(), {
            userName: 'a@b.com',
        }, 'https://x');

        expect(result.created).toBe(false);
        // Regression: idempotency is a SCIM 2.0 contract requirement.
        // An IdP that retries provisioning after a transient timeout
        // must not create a duplicate user — and must not bump the
        // audit chain with a fake "created" event.
        expect(mockMembershipCreate).not.toHaveBeenCalled();
    });

    it('reactivates a DEACTIVATED membership and emits SCIM_USER_REACTIVATED', async () => {
        mockUserFindUnique.mockResolvedValueOnce({
            id: 'u1', email: 'a@b.com', name: 'A',
            createdAt: new Date(), updatedAt: new Date(),
        } as never);
        mockMembershipFindUnique.mockResolvedValueOnce({
            id: 'm1', status: 'DEACTIVATED', role: 'READER',
        } as never);

        await scimCreateUser(scimCtx(), {
            userName: 'a@b.com', active: true,
        }, 'https://x');

        expect(mockMembershipUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: 'ACTIVE',
                    deactivatedAt: null,
                }),
            }),
        );
        expect(mockAppendAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'SCIM_USER_REACTIVATED' }),
        );
    });

    it('blocks role=admin on create — falls back to READER without throwing', async () => {
        mockUserFindUnique.mockResolvedValueOnce(null);
        mockTransaction.mockImplementationOnce(async (fn: any) =>
            fn({
                user: {
                    create: jest.fn().mockResolvedValue({
                        id: 'u-new', email: 'a@b.com', name: 'A',
                        createdAt: new Date(), updatedAt: new Date(),
                    }),
                },
                tenantMembership: {
                    create: jest.fn().mockImplementation((args: any) => ({
                        id: 'm-new', ...args.data,
                    })),
                },
            }),
        );

        await scimCreateUser(scimCtx(), {
            userName: 'a@b.com',
            roles: [{ value: 'admin' }],
        }, 'https://x');

        // The transaction call had role=READER, NOT ADMIN.
        const txCallback = mockTransaction.mock.calls[0][0];
        // Re-invoke with a spy to check what role was passed
        let observedRole: string | undefined;
        await txCallback({
            user: {
                create: jest.fn().mockResolvedValue({
                    id: 'u-new', email: 'a@b.com', name: 'A',
                    createdAt: new Date(), updatedAt: new Date(),
                }),
            },
            tenantMembership: {
                create: jest.fn().mockImplementation((args: any) => {
                    observedRole = args.data.role;
                    return { id: 'm-new', ...args.data };
                }),
            },
        });
        expect(observedRole).toBe('READER');
    });

    it('creates user inactive when input.active === false', async () => {
        mockUserFindUnique.mockResolvedValueOnce(null);

        let observedStatus: string | undefined;
        mockTransaction.mockImplementationOnce(async (fn: any) =>
            fn({
                user: {
                    create: jest.fn().mockResolvedValue({
                        id: 'u-new', email: 'a@b.com', name: 'A',
                        createdAt: new Date(), updatedAt: new Date(),
                    }),
                },
                tenantMembership: {
                    create: jest.fn().mockImplementation((args: any) => {
                        observedStatus = args.data.status;
                        return { id: 'm-new', ...args.data };
                    }),
                },
            }),
        );

        await scimCreateUser(scimCtx(), {
            userName: 'a@b.com',
            active: false,
        }, 'https://x');

        expect(observedStatus).toBe('DEACTIVATED');
    });

    it('attaches existing-user (e.g. cross-tenant member) with new membership in caller tenant', async () => {
        mockUserFindUnique.mockResolvedValueOnce({
            id: 'shared-user', email: 'shared@b.com', name: 'Shared',
            createdAt: new Date(), updatedAt: new Date(),
        } as never);
        // No existing membership in caller tenant.
        mockMembershipFindUnique.mockResolvedValueOnce(null);
        mockMembershipCreate.mockResolvedValueOnce({
            id: 'm-new', status: 'ACTIVE', role: 'READER',
        } as never);

        await scimCreateUser(scimCtx('tenant-A'), {
            userName: 'shared@b.com',
        }, 'https://x');

        expect(mockMembershipCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    tenantId: 'tenant-A',
                    userId: 'shared-user',
                }),
            }),
        );
        // Regression: a refactor that bailed on "user already exists"
        // would prevent shared users (e.g. consultants on multiple
        // tenants) from being provisioned via SCIM into a new tenant.
    });
});

describe('scimPatchUser — admin-protection', () => {
    it('returns null when user is not in the caller tenant', async () => {
        mockMembershipFindFirst.mockResolvedValueOnce(null);

        const result = await scimPatchUser(
            scimCtx('tenant-A'),
            'tenant-B-user',
            [{ op: 'replace', path: 'active', value: false }],
            'https://x',
        );

        expect(result).toBeNull();
    });

    it('does NOT touch role when existing membership.role === ADMIN', async () => {
        mockMembershipFindFirst
            .mockResolvedValueOnce({
                id: 'm1',
                role: 'ADMIN',
                status: 'ACTIVE',
                user: { id: 'u1', email: 'a@b.com', name: 'A' },
            } as never)
            // Second call from scimGetUser at the end
            .mockResolvedValueOnce({
                id: 'm1', status: 'ACTIVE',
                user: {
                    id: 'u1', email: 'a@b.com', name: 'A',
                    createdAt: new Date(), updatedAt: new Date(),
                },
            } as never);

        await scimPatchUser(
            scimCtx(),
            'u1',
            [{ op: 'replace', path: 'roles', value: [{ value: 'reader' }] }],
            'https://x',
        );

        // Regression: a SCIM patch from the IdP must NOT be able to
        // demote a tenant ADMIN back to READER. Tenant ownership of
        // the role assignment trumps the IdP's directory.
        // The membership.update call should NOT have been invoked
        // for the role field — only the audit trail should fire.
        expect(mockMembershipUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ role: expect.any(String) }),
            }),
        );
    });

    it('blocks role=admin on patch — silent fall-back to no role change', async () => {
        mockMembershipFindFirst
            .mockResolvedValueOnce({
                id: 'm1',
                role: 'EDITOR',
                status: 'ACTIVE',
                user: { id: 'u1', email: 'a@b.com', name: 'A' },
            } as never)
            .mockResolvedValueOnce({
                id: 'm1', status: 'ACTIVE',
                user: {
                    id: 'u1', email: 'a@b.com', name: 'A',
                    createdAt: new Date(), updatedAt: new Date(),
                },
            } as never);

        await scimPatchUser(
            scimCtx(),
            'u1',
            [{ op: 'replace', path: 'roles', value: [{ value: 'admin' }] }],
            'https://x',
        );

        expect(mockMembershipUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ role: 'ADMIN' }),
            }),
        );
    });

    it('active=false → status=DEACTIVATED + deactivatedAt set', async () => {
        mockMembershipFindFirst
            .mockResolvedValueOnce({
                id: 'm1',
                role: 'READER',
                status: 'ACTIVE',
                user: { id: 'u1', email: 'a@b.com', name: 'A' },
            } as never)
            .mockResolvedValueOnce({
                id: 'm1', status: 'DEACTIVATED',
                user: {
                    id: 'u1', email: 'a@b.com', name: 'A',
                    createdAt: new Date(), updatedAt: new Date(),
                },
            } as never);

        await scimPatchUser(
            scimCtx(),
            'u1',
            [{ op: 'replace', path: 'active', value: false }],
            'https://x',
        );

        expect(mockMembershipUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: 'DEACTIVATED',
                    deactivatedAt: expect.any(Date),
                }),
            }),
        );
        expect(mockAppendAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'SCIM_USER_DEACTIVATED' }),
        );
    });
});

describe('scimPutUser — admin-protection on full replace', () => {
    it('does NOT change role when existing membership is ADMIN (full-replace path)', async () => {
        mockMembershipFindFirst
            .mockResolvedValueOnce({
                id: 'm1', role: 'ADMIN', status: 'ACTIVE',
            } as never)
            .mockResolvedValueOnce(null);

        await scimPutUser(
            scimCtx(),
            'u1',
            { userName: 'a@b.com', roles: [{ value: 'reader' }] },
            'https://x',
        );

        // Same admin-protection invariant as scimPatchUser.
        expect(mockMembershipUpdate).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ role: expect.any(String) }),
            }),
        );
    });
});

describe('scimDeleteUser — soft-delete', () => {
    it('returns false when user is not in the caller tenant', async () => {
        mockMembershipFindFirst.mockResolvedValueOnce(null);

        const result = await scimDeleteUser(scimCtx('tenant-A'), 'tenant-B-user');
        expect(result).toBe(false);
    });

    it('soft-deletes (status=DEACTIVATED, NOT removed/hard-deleted) and audits', async () => {
        mockMembershipFindFirst.mockResolvedValueOnce({
            id: 'm1', status: 'ACTIVE',
            user: { email: 'a@b.com' },
        } as never);

        await scimDeleteUser(scimCtx(), 'u1');

        expect(mockMembershipUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: 'DEACTIVATED',
                    deactivatedAt: expect.any(Date),
                }),
            }),
        );
        // Regression: a refactor that hard-deletes the User row would
        // break referential integrity for audit-log entries, evidence
        // ownership, task assignment history, and audit-pack snapshots
        // that point at userId. Soft-delete preserves the chain while
        // revoking access.
        expect(mockAppendAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'SCIM_USER_DEACTIVATED',
                detailsJson: expect.objectContaining({ method: 'DELETE' }),
            }),
        );
    });
});
