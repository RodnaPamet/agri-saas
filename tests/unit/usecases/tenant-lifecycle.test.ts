/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/tenant-lifecycle.ts
 *
 * Wave 3 of GAP-02. Epic 1's last-OWNER protection is what stops
 * a tenant from becoming permanently un-administrable. The two-step
 * `transferTenantOwnership` flow is correctness-critical: it MUST
 * promote the new OWNER before demoting the old one or the DB
 * trigger `tenant_membership_last_owner_guard` fires and the whole
 * transaction rolls back.
 *
 * Behaviours protected:
 *   1. createTenantWithOwner: email is normalised (trim + lowercase),
 *      user is upserted (idempotent), tenant + membership +
 *      onboarding are created in a single $transaction, and TWO
 *      audit entries are appended (TENANT_CREATED +
 *      TENANT_MEMBERSHIP_GRANTED with role:OWNER reason:tenant_creation).
 *   2. transferTenantOwnership input contract: either tenantId OR
 *      tenantSlug required; ValidationError otherwise.
 *   3. ConflictError when new owner === current owner (no-op).
 *   4. ValidationError when new owner is not an ACTIVE member.
 *   5. NotFoundError when the current owner has no ACTIVE OWNER row.
 *   6. The transaction promotes the new OWNER FIRST then demotes the
 *      old to ADMIN (call ordering matters for the DB trigger).
 *   7. TENANT_OWNERSHIP_TRANSFERRED audit emitted after the swap.
 */

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        // #1237: `transferTenantOwnership` resolves the new owner with
        // `findFirst` over the candidate list, and the owner bootstrap reads
        // candidates before its upsert. `findUnique` and `findFirst` share one
        // fn so each test's existing `mockResolvedValue` drives whichever the
        // flow under test calls — separate fns silently stopped reaching the
        // code and every ownership guard reported "no user found".
        user: (() => {
            const find = jest.fn();
            return { upsert: jest.fn(), findUnique: find, findFirst: find };
        })(),
        tenant: {
            findUnique: jest.fn(),
        },
        tenantMembership: {
            findFirst: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

jest.mock('@/lib/security/tenant-keys', () => ({
    generateAndWrapDek: jest.fn(() => ({
        dek: Buffer.alloc(32),
        wrapped: 'wrapped-blob',
    })),
}));

jest.mock('@/lib/security/tenant-key-manager', () => ({
    createTenantWithDek: jest.fn(),
}));

jest.mock('@/lib/audit/audit-writer', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

import {
    createTenantWithOwner,
    transferTenantOwnership,
} from '@/app-layer/usecases/tenant-lifecycle';
import prisma from '@/lib/prisma';
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import { hashForLookup } from '@/lib/security/encryption';

const mockUserUpsert = prisma.user.upsert as jest.MockedFunction<typeof prisma.user.upsert>;
const mockUserFind = prisma.user.findUnique as jest.MockedFunction<typeof prisma.user.findUnique>;
const mockTenantFind = prisma.tenant.findUnique as jest.MockedFunction<typeof prisma.tenant.findUnique>;
const mockMembershipFind = prisma.tenantMembership.findFirst as jest.MockedFunction<typeof prisma.tenantMembership.findFirst>;
const mockTransaction = prisma.$transaction as jest.MockedFunction<any>;
const mockAppendAudit = appendAuditEntry as jest.MockedFunction<typeof appendAuditEntry>;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('createTenantWithOwner', () => {
    function setupTransaction() {
        const tx = {
            tenant: {
                create: jest.fn().mockResolvedValue({
                    id: 'tenant-1', slug: 'acme', name: 'Acme',
                }),
            },
            tenantMembership: {
                create: jest.fn().mockResolvedValue({}),
            },
            tenantOnboarding: {
                create: jest.fn().mockResolvedValue({}),
            },
        };
        mockTransaction.mockImplementationOnce(async (fn: any) => fn(tx));
        return tx;
    }

    it('normalises ownerEmail (trim + lowercase) before User upsert', async () => {
        setupTransaction();
        mockUserUpsert.mockResolvedValueOnce({ id: 'user-1' } as never);

        await createTenantWithOwner({
            name: 'Acme',
            slug: 'acme',
            ownerEmail: '   Alice@Example.COM  ',
            requestId: 'req-1',
        });

        // GAP-21: lookup is anchored on emailHash. The expected hash
        // is computed from the normalised form, so this assertion
        // proves both that normalisation happens AND that the call
        // site has been migrated off the plaintext column.
        expect(mockUserUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { emailHash: hashForLookup('alice@example.com') },
            }),
        );
        // Regression: a missed normalisation would produce a different
        // hash for "Alice@Example.com" vs "alice@example.com" and the
        // unique constraint would let two distinct rows coexist.
    });

    it('upserts the user (idempotent — reuses existing row by email)', async () => {
        setupTransaction();
        mockUserUpsert.mockResolvedValueOnce({ id: 'user-existing' } as never);

        await createTenantWithOwner({
            name: 'A', slug: 'a', ownerEmail: 'a@b.com', requestId: 'r1',
        });

        const args = mockUserUpsert.mock.calls[0][0] as any;
        // The `update: {}` is the idempotency contract — if the email
        // already exists, do nothing; otherwise create a placeholder
        // User. GAP-21: the create payload now also carries
        // `emailHash` (deterministic) so the DB-level NOT NULL is
        // satisfied without relying on the middleware to populate it
        // — making the call site self-evident at audit time.
        expect(args.update).toEqual({});
        expect(args.create).toEqual({
            email: 'a@b.com',
            emailHash: hashForLookup('a@b.com'),
        });
    });

    it('creates tenant + membership + onboarding inside one $transaction', async () => {
        const tx = setupTransaction();
        mockUserUpsert.mockResolvedValueOnce({ id: 'user-1' } as never);

        await createTenantWithOwner({
            name: 'Acme', slug: 'acme', ownerEmail: 'a@b.com', requestId: 'r1',
        });

        expect(tx.tenant.create).toHaveBeenCalledTimes(1);
        expect(tx.tenantMembership.create).toHaveBeenCalledTimes(1);
        expect(tx.tenantOnboarding.create).toHaveBeenCalledTimes(1);

        // Membership is OWNER + ACTIVE.
        const membershipArgs = (tx.tenantMembership.create as jest.Mock).mock.calls[0][0];
        expect(membershipArgs.data.role).toBe('OWNER');
        expect(membershipArgs.data.status).toBe('ACTIVE');
        expect(membershipArgs.data.userId).toBe('user-1');
    });

    it('emits TENANT_CREATED + TENANT_MEMBERSHIP_GRANTED audits AFTER tx commits', async () => {
        setupTransaction();
        mockUserUpsert.mockResolvedValueOnce({ id: 'user-1' } as never);

        await createTenantWithOwner({
            name: 'Acme', slug: 'acme', ownerEmail: 'a@b.com', requestId: 'r1',
        });

        const actions = mockAppendAudit.mock.calls.map(c => (c[0] as any).action);
        expect(actions).toContain('TENANT_CREATED');
        expect(actions).toContain('TENANT_MEMBERSHIP_GRANTED');

        const grantCall = mockAppendAudit.mock.calls.find(
            c => (c[0] as any).action === 'TENANT_MEMBERSHIP_GRANTED',
        );
        const grant = (grantCall as any[])[0];
        expect(grant.detailsJson.role).toBe('OWNER');
        expect(grant.detailsJson.reason).toBe('tenant_creation');
        // Regression: an audit emitted INSIDE the tx that then rolled
        // back would leave a chain entry pointing at a non-existent
        // tenant. We rely on the post-commit ordering for chain
        // correctness.
    });
});

describe('transferTenantOwnership — input contract', () => {
    it('throws ValidationError when neither tenantId nor tenantSlug is provided', async () => {
        await expect(
            transferTenantOwnership({
                currentOwnerUserId: 'u1',
                newOwnerEmail: 'new@b.com',
            }),
        ).rejects.toThrow(/tenantId or tenantSlug is required/);
    });

    it('resolves tenantSlug → tenantId via prisma.tenant.findUnique', async () => {
        mockTenantFind.mockResolvedValueOnce({ id: 'resolved-tenant' } as never);
        mockUserFind.mockResolvedValueOnce(null);

        await expect(
            transferTenantOwnership({
                tenantSlug: 'acme',
                currentOwnerUserId: 'u1',
                newOwnerEmail: 'new@b.com',
            }),
        ).rejects.toThrow();

        expect(mockTenantFind).toHaveBeenCalledWith(
            expect.objectContaining({ where: { slug: 'acme' } }),
        );
    });

    it('throws NotFoundError when the slug does not resolve to a tenant', async () => {
        mockTenantFind.mockResolvedValueOnce(null);

        await expect(
            transferTenantOwnership({
                tenantSlug: 'no-such-slug',
                currentOwnerUserId: 'u1',
                newOwnerEmail: 'new@b.com',
            }),
        ).rejects.toThrow(/Tenant not found/);
    });
});

describe('transferTenantOwnership — guards', () => {
    it('throws NotFoundError when the new-owner email has no User row', async () => {
        mockUserFind.mockResolvedValueOnce(null);

        await expect(
            transferTenantOwnership({
                tenantId: 't1',
                currentOwnerUserId: 'u1',
                newOwnerEmail: 'unknown@b.com',
            }),
        ).rejects.toThrow(/No user found/);
    });

    it('throws ValidationError when new owner is not an ACTIVE member', async () => {
        mockUserFind.mockResolvedValueOnce({ id: 'u-new' } as never);
        mockMembershipFind.mockResolvedValueOnce(null);

        await expect(
            transferTenantOwnership({
                tenantId: 't1',
                currentOwnerUserId: 'u1',
                newOwnerEmail: 'new@b.com',
            }),
        ).rejects.toThrow(/active tenant member/);
        // Regression: a refactor that auto-onboarded the new user as
        // part of transfer would bypass the invite flow and leak
        // membership without a token check.
    });

    it('throws ConflictError when new owner === current owner', async () => {
        mockUserFind.mockResolvedValueOnce({ id: 'u1' } as never);
        mockMembershipFind.mockResolvedValueOnce({ id: 'm1', role: 'OWNER' } as never);

        await expect(
            transferTenantOwnership({
                tenantId: 't1',
                currentOwnerUserId: 'u1',
                newOwnerEmail: 'self@b.com',
            }),
        ).rejects.toThrow(/same as the current owner/);
    });

    it('throws NotFoundError when current owner has no ACTIVE OWNER row', async () => {
        mockUserFind.mockResolvedValueOnce({ id: 'u-new' } as never);
        mockMembershipFind
            .mockResolvedValueOnce({ id: 'm-new', role: 'EDITOR' } as never) // new owner
            .mockResolvedValueOnce(null); // current owner — none ACTIVE OWNER

        await expect(
            transferTenantOwnership({
                tenantId: 't1',
                currentOwnerUserId: 'u-deposed',
                newOwnerEmail: 'new@b.com',
            }),
        ).rejects.toThrow(/no ACTIVE OWNER membership/);
    });
});

describe('transferTenantOwnership — happy path', () => {
    it('promotes new OWNER FIRST then demotes the old (call order satisfies the DB trigger)', async () => {
        mockUserFind.mockResolvedValueOnce({ id: 'u-new' } as never);
        mockMembershipFind
            .mockResolvedValueOnce({ id: 'm-new', role: 'EDITOR' } as never) // new owner ACTIVE
            .mockResolvedValueOnce({ id: 'm-old' } as never); // current OWNER

        const calls: { id: string; role: string }[] = [];
        const tx = {
            tenantMembership: {
                update: jest.fn().mockImplementation((args: any) => {
                    calls.push({ id: args.where.id, role: args.data.role });
                    return Promise.resolve({});
                }),
            },
        };
        mockTransaction.mockImplementationOnce(async (fn: any) => fn(tx));

        await transferTenantOwnership({
            tenantId: 't1',
            currentOwnerUserId: 'u-old',
            newOwnerEmail: 'new@b.com',
        });

        expect(calls).toEqual([
            { id: 'm-new', role: 'OWNER' },  // promote first
            { id: 'm-old', role: 'ADMIN' },  // then demote
        ]);
        // Regression: reversing the order would demote the old OWNER
        // first, leaving the tenant with zero ACTIVE OWNERs and tripping
        // the `tenant_membership_last_owner_guard` trigger — the whole
        // transfer fails with a P0001 SQLSTATE.
    });

    it('emits TENANT_OWNERSHIP_TRANSFERRED audit with from/to user ids', async () => {
        mockUserFind.mockResolvedValueOnce({ id: 'u-new' } as never);
        mockMembershipFind
            .mockResolvedValueOnce({ id: 'm-new', role: 'EDITOR' } as never)
            .mockResolvedValueOnce({ id: 'm-old' } as never);

        mockTransaction.mockImplementationOnce(async (fn: any) =>
            fn({
                tenantMembership: { update: jest.fn().mockResolvedValue({}) },
            }),
        );

        await transferTenantOwnership({
            tenantId: 't1',
            currentOwnerUserId: 'u-old',
            newOwnerEmail: 'new@b.com',
        });

        const auditCall = mockAppendAudit.mock.calls.find(
            c => (c[0] as any).action === 'TENANT_OWNERSHIP_TRANSFERRED',
        );
        expect(auditCall).toBeTruthy();
        const audit = (auditCall as any[])[0];
        expect(audit.detailsJson.fromUserId).toBe('u-old');
        expect(audit.detailsJson.toUserId).toBe('u-new');
        expect(audit.detailsJson.previousOwnerNewRole).toBe('ADMIN');
    });
});
