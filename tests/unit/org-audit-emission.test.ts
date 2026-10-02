/**
 * Epic B — durable org-scoped audit emission contract.
 *
 * Mocks the prisma + provisioning + writer boundaries so we can assert
 * exactly which OrgAuditAction(s) each privilege-mutating usecase
 * emits, with what targetUserId and what summarised payload.
 *
 * The writer correctness (deterministic hash, advisory-locked
 * append-only insert) is covered by `org-audit-writer.test.ts` (unit)
 * and `org-audit-immutability.test.ts` (integration).
 */
const userUpsertMock = jest.fn();
const userFindFirstMock = jest.fn();
const orgMembershipFindUniqueMock = jest.fn();
const orgMembershipCreateMock = jest.fn();
const orgMembershipDeleteMock = jest.fn();
const orgMembershipUpdateMock = jest.fn();
const orgMembershipCountMock = jest.fn();
const transactionMock = jest.fn();
const provisionOrgAdminMock = jest.fn();
const deprovisionOrgAdminMock = jest.fn();
const appendAuditEntryMock = jest.fn();
const appendOrgAuditEntryMock = jest.fn();

jest.mock('@/lib/prisma', () => {
    const client = {
        user: {
            upsert: (...a: unknown[]) => userUpsertMock(...a),
            // #1237: a candidate read now runs BEFORE the upsert, because an
            // upsert `where` cannot hold the candidate list and keying it on the
            // primary hash alone would create a duplicate User mid-rotation.
            // Returning undefined falls through to the upsert, which is exactly
            // the path these tests already exercise.
            findFirst: (...a: unknown[]) => userFindFirstMock(...a),
        },
        orgMembership: {
            findUnique: (...a: unknown[]) => orgMembershipFindUniqueMock(...a),
            findFirst: (...a: unknown[]) => orgMembershipFindUniqueMock(...a),
            create: (...a: unknown[]) => orgMembershipCreateMock(...a),
            delete: (...a: unknown[]) => orgMembershipDeleteMock(...a),
            update: (...a: unknown[]) => orgMembershipUpdateMock(...a),
            count: (...a: unknown[]) => orgMembershipCountMock(...a),
        },
        $transaction: (...a: unknown[]) => transactionMock(...a),
    };
    return { __esModule: true, default: client, prisma: client };
});

jest.mock('@/app-layer/usecases/org-provisioning', () => ({
    __esModule: true,
    provisionOrgAdminToTenants: (...a: unknown[]) => provisionOrgAdminMock(...a),
    deprovisionOrgAdmin: (...a: unknown[]) => deprovisionOrgAdminMock(...a),
}));

jest.mock('@/lib/audit', () => ({
    __esModule: true,
    appendAuditEntry: (...a: unknown[]) => appendAuditEntryMock(...a),
}));

jest.mock('@/lib/audit/org-audit-writer', () => ({
    __esModule: true,
    appendOrgAuditEntry: (...a: unknown[]) => appendOrgAuditEntryMock(...a),
}));

import {
    addOrgMember,
    changeOrgMemberRole,
    removeOrgMember,
} from '@/app-layer/usecases/org-members';
import type { OrgContext } from '@/app-layer/types';

function ctxFor(overrides: Partial<OrgContext> = {}): OrgContext {
    return {
        requestId: 'req-test',
        userId: 'caller-1',
        organizationId: 'org-1',
        orgSlug: 'acme-org',
        orgRole: 'ORG_ADMIN',
        permissions: {
            canViewPortfolio: true,
            canDrillDown: true,
            canExportReports: true,
            canManageTenants: true,
            canManageMembers: true,
            canConfigureDashboard: true,
        },
        ...overrides,
    };
}

beforeEach(() => {
    userUpsertMock.mockReset();
    orgMembershipFindUniqueMock.mockReset();
    orgMembershipCreateMock.mockReset();
    orgMembershipDeleteMock.mockReset();
    orgMembershipUpdateMock.mockReset();
    orgMembershipCountMock.mockReset();
    transactionMock.mockReset();
    provisionOrgAdminMock.mockReset();
    deprovisionOrgAdminMock.mockReset();
    appendAuditEntryMock.mockReset();
    appendOrgAuditEntryMock.mockReset();
    appendAuditEntryMock.mockResolvedValue(undefined);
    appendOrgAuditEntryMock.mockResolvedValue({
        id: 'oa-1',
        entryHash: 'h-1',
        previousHash: null,
    });
});

// ── Helpers ───────────────────────────────────────────────────────

interface OrgAuditCall {
    organizationId: string;
    actorUserId: string | null;
    actorType: string;
    action: string;
    targetUserId: string | null;
    detailsJson: Record<string, unknown> | null;
    requestId?: string | null;
}

function callsByAction(action: string): OrgAuditCall[] {
    return appendOrgAuditEntryMock.mock.calls
        .map((call) => call[0] as OrgAuditCall)
        .filter((arg) => arg.action === action);
}

// ── addOrgMember ──────────────────────────────────────────────────

describe('addOrgMember — org audit emission', () => {
    function setupHappyPath(role: 'ORG_ADMIN' | 'ORG_READER', provisioningCount = 0) {
        userUpsertMock.mockResolvedValue({ id: 'user-target', email: 'x@y.com' });
        orgMembershipFindUniqueMock.mockResolvedValue(null);
        orgMembershipCreateMock.mockResolvedValue({
            id: 'mem-1',
            organizationId: 'org-1',
            userId: 'user-target',
            role,
        });
        if (role === 'ORG_ADMIN') {
            const tenantIds = Array.from({ length: provisioningCount }, (_, i) => `t-${i + 1}`);
            provisionOrgAdminMock.mockResolvedValue({
                created: provisioningCount,
                skipped: 0,
                totalConsidered: provisioningCount,
                tenantIds,
            });
        }
    }

    it('emits ORG_MEMBER_ADDED with role + provisioning summary in detailsJson', async () => {
        setupHappyPath('ORG_ADMIN', 3);
        await addOrgMember(ctxFor(), { userEmail: 'x@y.com', role: 'ORG_ADMIN' });

        const added = callsByAction('ORG_MEMBER_ADDED');
        expect(added).toHaveLength(1);
        expect(added[0].organizationId).toBe('org-1');
        expect(added[0].actorUserId).toBe('caller-1');
        expect(added[0].targetUserId).toBe('user-target');
        expect(added[0].detailsJson).toMatchObject({
            role: 'ORG_ADMIN',
            provisionedTenantCount: 3,
        });
    });

    it('also emits ORG_ADMIN_PROVISIONED_TO_TENANTS with the tenant list when fan-out fires', async () => {
        setupHappyPath('ORG_ADMIN', 2);
        await addOrgMember(ctxFor(), { userEmail: 'x@y.com', role: 'ORG_ADMIN' });

        const provisioned = callsByAction('ORG_ADMIN_PROVISIONED_TO_TENANTS');
        expect(provisioned).toHaveLength(1);
        expect(provisioned[0].targetUserId).toBe('user-target');
        expect(provisioned[0].detailsJson).toMatchObject({
            trigger: 'org_member_added',
            tenantCount: 2,
            tenantIds: ['t-1', 't-2'],
            role: 'AUDITOR',
        });
    });

    it('does NOT emit ORG_ADMIN_PROVISIONED_TO_TENANTS for ORG_READER', async () => {
        setupHappyPath('ORG_READER');
        await addOrgMember(ctxFor(), { userEmail: 'x@y.com', role: 'ORG_READER' });
        expect(callsByAction('ORG_ADMIN_PROVISIONED_TO_TENANTS')).toHaveLength(0);
        expect(callsByAction('ORG_MEMBER_ADDED')).toHaveLength(1);
    });

    it('does NOT emit ORG_ADMIN_PROVISIONED_TO_TENANTS when fan-out created 0 rows', async () => {
        setupHappyPath('ORG_ADMIN', 0);
        await addOrgMember(ctxFor(), { userEmail: 'x@y.com', role: 'ORG_ADMIN' });
        expect(callsByAction('ORG_ADMIN_PROVISIONED_TO_TENANTS')).toHaveLength(0);
        // ORG_MEMBER_ADDED still fires because the privilege was granted.
        expect(callsByAction('ORG_MEMBER_ADDED')).toHaveLength(1);
    });
});

// ── removeOrgMember ──────────────────────────────────────────────

describe('removeOrgMember — org audit emission', () => {
    function setupHappyPath(role: 'ORG_ADMIN' | 'ORG_READER', deprovisioningCount = 0) {
        orgMembershipFindUniqueMock.mockResolvedValue({ id: 'mem-1', role });
        orgMembershipDeleteMock.mockResolvedValue({ id: 'mem-1' });
        if (role === 'ORG_ADMIN') {
            // Sufficient admin count so the last-admin guard doesn't block.
            orgMembershipCountMock.mockResolvedValue(2);
            const tenantIds = Array.from({ length: deprovisioningCount }, (_, i) => `t-${i + 1}`);
            deprovisionOrgAdminMock.mockResolvedValue({
                deleted: deprovisioningCount,
                tenantIds,
            });
        }
    }

    it('emits ORG_MEMBER_REMOVED with previousRole + deprovisioning summary', async () => {
        setupHappyPath('ORG_ADMIN', 2);
        await removeOrgMember(ctxFor(), { userId: 'user-target' });

        const removed = callsByAction('ORG_MEMBER_REMOVED');
        expect(removed).toHaveLength(1);
        expect(removed[0].targetUserId).toBe('user-target');
        expect(removed[0].detailsJson).toMatchObject({
            previousRole: 'ORG_ADMIN',
            deprovisionedTenantCount: 2,
        });
    });

    it('emits ORG_ADMIN_DEPROVISIONED_FROM_TENANTS with the tenant list when fan-in fires', async () => {
        setupHappyPath('ORG_ADMIN', 2);
        await removeOrgMember(ctxFor(), { userId: 'user-target' });

        const deprovisioned = callsByAction('ORG_ADMIN_DEPROVISIONED_FROM_TENANTS');
        expect(deprovisioned).toHaveLength(1);
        expect(deprovisioned[0].targetUserId).toBe('user-target');
        expect(deprovisioned[0].detailsJson).toMatchObject({
            trigger: 'org_member_removed',
            tenantCount: 2,
            tenantIds: ['t-1', 't-2'],
            role: 'AUDITOR',
        });
    });

    it('does NOT emit ORG_ADMIN_DEPROVISIONED_FROM_TENANTS for ORG_READER removal', async () => {
        setupHappyPath('ORG_READER');
        await removeOrgMember(ctxFor(), { userId: 'user-target' });
        expect(callsByAction('ORG_ADMIN_DEPROVISIONED_FROM_TENANTS')).toHaveLength(0);
        expect(callsByAction('ORG_MEMBER_REMOVED')).toHaveLength(1);
    });
});

// ── changeOrgMemberRole ──────────────────────────────────────────

describe('changeOrgMemberRole — org audit emission', () => {
    function setupReaderToAdmin(provisioningCount = 0) {
        orgMembershipFindUniqueMock.mockResolvedValue({ id: 'mem-1', role: 'ORG_READER' });
        orgMembershipCountMock.mockResolvedValue(2); // satisfies guard for any direction
        const tenantIds = Array.from({ length: provisioningCount }, (_, i) => `t-${i + 1}`);
        provisionOrgAdminMock.mockResolvedValue({
            created: provisioningCount,
            skipped: 0,
            totalConsidered: provisioningCount,
            tenantIds,
        });
        // The transaction callback mirrors the real impl — invoke the
        // callback with our mock client so the inner provisioning fires.
        transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) =>
            cb({
                orgMembership: {
                    update: (...a: unknown[]) => orgMembershipUpdateMock(...a),
                    count: (...a: unknown[]) => orgMembershipCountMock(...a),
                },
            }),
        );
        orgMembershipUpdateMock.mockResolvedValue({
            id: 'mem-1',
            organizationId: 'org-1',
            userId: 'user-target',
            role: 'ORG_ADMIN',
        });
    }

    function setupAdminToReader(deprovisioningCount = 0) {
        orgMembershipFindUniqueMock.mockResolvedValue({ id: 'mem-1', role: 'ORG_ADMIN' });
        orgMembershipCountMock.mockResolvedValue(2);
        const tenantIds = Array.from({ length: deprovisioningCount }, (_, i) => `t-${i + 1}`);
        deprovisionOrgAdminMock.mockResolvedValue({
            deleted: deprovisioningCount,
            tenantIds,
        });
        transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) =>
            cb({
                orgMembership: {
                    update: (...a: unknown[]) => orgMembershipUpdateMock(...a),
                    count: (...a: unknown[]) => orgMembershipCountMock(...a),
                },
            }),
        );
        orgMembershipUpdateMock.mockResolvedValue({
            id: 'mem-1',
            organizationId: 'org-1',
            userId: 'user-target',
            role: 'ORG_READER',
        });
    }

    it('emits ORG_MEMBER_ROLE_CHANGED with both roles + transition on reader→admin', async () => {
        setupReaderToAdmin(2);
        await changeOrgMemberRole(ctxFor(), { userId: 'user-target', role: 'ORG_ADMIN' });

        const changed = callsByAction('ORG_MEMBER_ROLE_CHANGED');
        expect(changed).toHaveLength(1);
        expect(changed[0].detailsJson).toMatchObject({
            previousRole: 'ORG_READER',
            newRole: 'ORG_ADMIN',
            transition: 'reader_to_admin',
            provisionedTenantCount: 2,
            deprovisionedTenantCount: 0,
        });
    });

    it('emits ORG_ADMIN_PROVISIONED_TO_TENANTS on reader→admin', async () => {
        setupReaderToAdmin(2);
        await changeOrgMemberRole(ctxFor(), { userId: 'user-target', role: 'ORG_ADMIN' });
        const provisioned = callsByAction('ORG_ADMIN_PROVISIONED_TO_TENANTS');
        expect(provisioned).toHaveLength(1);
        expect(provisioned[0].detailsJson).toMatchObject({
            trigger: 'org_member_promoted',
            tenantCount: 2,
            role: 'AUDITOR',
        });
    });

    it('emits ORG_ADMIN_DEPROVISIONED_FROM_TENANTS on admin→reader', async () => {
        setupAdminToReader(3);
        await changeOrgMemberRole(ctxFor(), { userId: 'user-target', role: 'ORG_READER' });
        const deprovisioned = callsByAction('ORG_ADMIN_DEPROVISIONED_FROM_TENANTS');
        expect(deprovisioned).toHaveLength(1);
        expect(deprovisioned[0].detailsJson).toMatchObject({
            trigger: 'org_member_demoted',
            tenantCount: 3,
            role: 'AUDITOR',
        });
    });

    it('emits NOTHING on no-op (same-role transition)', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue({ id: 'mem-1', role: 'ORG_READER' });
        await changeOrgMemberRole(ctxFor(), { userId: 'user-target', role: 'ORG_READER' });
        expect(appendOrgAuditEntryMock).not.toHaveBeenCalled();
    });
});
