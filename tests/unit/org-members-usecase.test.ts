/**
 * Epic O-2 — `org-members.ts` usecase unit contract.
 *
 * Mocks Prisma + the provisioning service at the module boundary so
 * the test exercises the side-effect wiring (provision on ORG_ADMIN
 * add, deprovision on ORG_ADMIN remove, last-admin guard).
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

// Epic B — the org-members usecase now also emits a per-org audit
// row through the OrgAuditLog writer. This test focuses on the
// existing per-tenant fan-out wiring, so we stub the org writer to
// a successful no-op. Dedicated org-audit emission assertions live
// in `tests/unit/org-audit-emission.test.ts`.
const appendOrgAuditEntryMock = jest.fn().mockResolvedValue({
    id: 'oa-mock',
    entryHash: 'h-mock',
    previousHash: null,
});
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
import { hashForLookup } from '@/lib/security/encryption';

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
    // Default audit emission is a successful no-op so existing tests
    // that don't specifically assert on audit behaviour stay green.
    appendAuditEntryMock.mockResolvedValue(undefined);
});

// ── addOrgMember ───────────────────────────────────────────────────────

describe('addOrgMember', () => {
    it('upserts the user, creates OrgMembership, fans out provisioning for ORG_ADMIN', async () => {
        userUpsertMock.mockResolvedValue({ id: 'user-2', email: 'ciso@example.com' });
        orgMembershipFindUniqueMock.mockResolvedValue(null);
        orgMembershipCreateMock.mockResolvedValue({
            id: 'mem-1',
            organizationId: 'org-1',
            userId: 'user-2',
            role: 'ORG_ADMIN',
        });
        provisionOrgAdminMock.mockResolvedValue({
            created: 3,
            skipped: 0,
            totalConsidered: 3,
            tenantIds: ['t-1', 't-2', 't-3'],
        });

        const result = await addOrgMember(ctxFor(), {
            userEmail: 'CISO@example.com',
            role: 'ORG_ADMIN',
        });

        // GAP-21: lookup is anchored on emailHash. The expected hash
        // is computed from the normalised form, so this assertion
        // proves both that normalisation happens AND that the call
        // site has been migrated off the plaintext column.
        expect(userUpsertMock).toHaveBeenCalledTimes(1);
        const upsertArg = userUpsertMock.mock.calls[0][0];
        expect(upsertArg.where.emailHash).toBe(hashForLookup('ciso@example.com'));

        // Provisioning fired with the correct (orgId, userId).
        expect(provisionOrgAdminMock).toHaveBeenCalledTimes(1);
        expect(provisionOrgAdminMock).toHaveBeenCalledWith('org-1', 'user-2');

        expect(result.membership.role).toBe('ORG_ADMIN');
        expect(result.provision).toEqual({
            created: 3,
            skipped: 0,
            totalConsidered: 3,
            tenantIds: ['t-1', 't-2', 't-3'],
        });
    });

    it('writes one ORG_AUDITOR_PROVISIONED audit row per affected tenant on ORG_ADMIN add', async () => {
        userUpsertMock.mockResolvedValue({ id: 'user-2', email: 'ciso@example.com' });
        orgMembershipFindUniqueMock.mockResolvedValue(null);
        orgMembershipCreateMock.mockResolvedValue({
            id: 'mem-1',
            organizationId: 'org-1',
            userId: 'user-2',
            role: 'ORG_ADMIN',
        });
        provisionOrgAdminMock.mockResolvedValue({
            created: 2,
            skipped: 1,
            totalConsidered: 3,
            tenantIds: ['t-1', 't-2'], // skipped tenant t-3 has no audit
        });

        await addOrgMember(ctxFor(), {
            userEmail: 'ciso@example.com',
            role: 'ORG_ADMIN',
        });

        // One AuditLog write per newly-created TenantMembership row.
        expect(appendAuditEntryMock).toHaveBeenCalledTimes(2);

        const tenantIdsAudited = appendAuditEntryMock.mock.calls
            .map((c) => (c[0] as { tenantId: string }).tenantId)
            .sort();
        expect(tenantIdsAudited).toEqual(['t-1', 't-2']);

        // Spot-check the payload shape for one of the calls.
        const sample = appendAuditEntryMock.mock.calls[0][0] as Record<string, unknown>;
        expect(sample.entity).toBe('TenantMembership');
        expect(sample.entityId).toBe('user-2');
        expect(sample.action).toBe('ORG_AUDITOR_PROVISIONED');
        expect(sample.userId).toBe('caller-1'); // actor from ctx
        expect(sample.actorType).toBe('USER');
        expect(sample.requestId).toBe('req-test');
        const details = sample.detailsJson as Record<string, unknown>;
        expect(details.category).toBe('access');
        expect(details.targetUserId).toBe('user-2');
        expect(details.sourceAction).toBe('org_member_added');
        expect(details.organizationId).toBe('org-1');
        expect(details.orgSlug).toBe('acme-org');
        expect(details.newOrgRole).toBe('ORG_ADMIN');
    });

    it('does NOT emit any audit row when ORG_ADMIN add has nothing to provision', async () => {
        userUpsertMock.mockResolvedValue({ id: 'user-2', email: 'ciso@example.com' });
        orgMembershipFindUniqueMock.mockResolvedValue(null);
        orgMembershipCreateMock.mockResolvedValue({
            id: 'mem-1',
            organizationId: 'org-1',
            userId: 'user-2',
            role: 'ORG_ADMIN',
        });
        // Empty org — no tenants → no provisioning → no audit.
        provisionOrgAdminMock.mockResolvedValue({
            created: 0,
            skipped: 0,
            totalConsidered: 0,
            tenantIds: [],
        });

        await addOrgMember(ctxFor(), {
            userEmail: 'ciso@example.com',
            role: 'ORG_ADMIN',
        });

        expect(appendAuditEntryMock).not.toHaveBeenCalled();
    });

    it('does NOT fan out provisioning OR emit audit rows for ORG_READER', async () => {
        userUpsertMock.mockResolvedValue({ id: 'user-3', email: 'reader@example.com' });
        orgMembershipFindUniqueMock.mockResolvedValue(null);
        orgMembershipCreateMock.mockResolvedValue({
            id: 'mem-2',
            organizationId: 'org-1',
            userId: 'user-3',
            role: 'ORG_READER',
        });

        const result = await addOrgMember(ctxFor(), {
            userEmail: 'reader@example.com',
            role: 'ORG_READER',
        });

        expect(provisionOrgAdminMock).not.toHaveBeenCalled();
        // ORG_READER add doesn't change tenant access — no audit
        // evidence is written. Structured logger.info still records
        // the org-level event for ops observability.
        expect(appendAuditEntryMock).not.toHaveBeenCalled();
        expect(result.provision).toBeUndefined();
        expect(result.membership.role).toBe('ORG_READER');
    });

    it('throws ConflictError when the user is already a member', async () => {
        userUpsertMock.mockResolvedValue({ id: 'user-2', email: 'ciso@example.com' });
        orgMembershipFindUniqueMock.mockResolvedValue({ role: 'ORG_READER' });

        await expect(
            addOrgMember(ctxFor(), { userEmail: 'ciso@example.com', role: 'ORG_ADMIN' }),
        ).rejects.toMatchObject({ status: 409 });

        // Membership creation must NOT happen on conflict.
        expect(orgMembershipCreateMock).not.toHaveBeenCalled();
        expect(provisionOrgAdminMock).not.toHaveBeenCalled();
    });
});

// ── removeOrgMember ────────────────────────────────────────────────────

describe('removeOrgMember', () => {
    it('deprovisions and deletes when removing an ORG_ADMIN (count > 1)', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue({ id: 'mem-1', role: 'ORG_ADMIN' });
        orgMembershipCountMock.mockResolvedValue(2); // not the last admin
        deprovisionOrgAdminMock.mockResolvedValue({
            deleted: 3,
            tenantIds: ['t-1', 't-2', 't-3'],
        });
        orgMembershipDeleteMock.mockResolvedValue({ id: 'mem-1' });

        const result = await removeOrgMember(ctxFor(), { userId: 'user-2' });

        // Deprovision fired BEFORE the OrgMembership delete.
        const deprovisionOrder =
            (deprovisionOrgAdminMock.mock.invocationCallOrder[0] ?? 0) <
            (orgMembershipDeleteMock.mock.invocationCallOrder[0] ?? 0);
        expect(deprovisionOrder).toBe(true);

        expect(deprovisionOrgAdminMock).toHaveBeenCalledWith('org-1', 'user-2');
        expect(result.wasOrgAdmin).toBe(true);
        expect(result.deprovision).toEqual({ deleted: 3, tenantIds: ['t-1', 't-2', 't-3'] });
        expect(result.deletedMembershipId).toBe('mem-1');
    });

    it('does NOT deprovision OR emit audit rows when removing an ORG_READER', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue({ id: 'mem-2', role: 'ORG_READER' });
        orgMembershipDeleteMock.mockResolvedValue({ id: 'mem-2' });

        const result = await removeOrgMember(ctxFor(), { userId: 'user-3' });

        expect(orgMembershipCountMock).not.toHaveBeenCalled();
        expect(deprovisionOrgAdminMock).not.toHaveBeenCalled();
        expect(appendAuditEntryMock).not.toHaveBeenCalled();
        expect(result.wasOrgAdmin).toBe(false);
        expect(result.deprovision).toBeUndefined();
    });

    it('writes one ORG_AUDITOR_DEPROVISIONED audit row per affected tenant on ORG_ADMIN remove', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue({ id: 'mem-1', role: 'ORG_ADMIN' });
        orgMembershipCountMock.mockResolvedValue(2);
        deprovisionOrgAdminMock.mockResolvedValue({
            deleted: 3,
            tenantIds: ['t-1', 't-2', 't-3'],
        });
        orgMembershipDeleteMock.mockResolvedValue({ id: 'mem-1' });

        await removeOrgMember(ctxFor(), { userId: 'user-2' });

        expect(appendAuditEntryMock).toHaveBeenCalledTimes(3);
        const tenantIdsAudited = appendAuditEntryMock.mock.calls
            .map((c) => (c[0] as { tenantId: string }).tenantId)
            .sort();
        expect(tenantIdsAudited).toEqual(['t-1', 't-2', 't-3']);

        const sample = appendAuditEntryMock.mock.calls[0][0] as Record<string, unknown>;
        expect(sample.action).toBe('ORG_AUDITOR_DEPROVISIONED');
        expect(sample.entity).toBe('TenantMembership');
        expect(sample.entityId).toBe('user-2');
        const details = sample.detailsJson as Record<string, unknown>;
        expect(details.sourceAction).toBe('org_member_removed');
        expect(details.previousOrgRole).toBe('ORG_ADMIN');
    });

    it('audit emission runs AFTER the OrgMembership delete (not before)', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue({ id: 'mem-1', role: 'ORG_ADMIN' });
        orgMembershipCountMock.mockResolvedValue(2);
        deprovisionOrgAdminMock.mockResolvedValue({
            deleted: 1,
            tenantIds: ['t-1'],
        });
        orgMembershipDeleteMock.mockResolvedValue({ id: 'mem-1' });

        await removeOrgMember(ctxFor(), { userId: 'user-2' });

        // Order: deprovision → orgMembership.delete → audit emit. The
        // tenant-side AUDITOR row is gone before the org-level row,
        // and audit fires post-commit so a rollback (in a future
        // refactor that wraps these in a tx) wouldn't leave a dangling
        // audit entry.
        const orgDelete = orgMembershipDeleteMock.mock.invocationCallOrder[0] ?? 0;
        const audit = appendAuditEntryMock.mock.invocationCallOrder[0] ?? 0;
        expect(audit).toBeGreaterThan(orgDelete);
    });

    it('refuses to remove the last ORG_ADMIN (last-admin guard)', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue({ id: 'mem-1', role: 'ORG_ADMIN' });
        orgMembershipCountMock.mockResolvedValue(1); // last admin

        await expect(
            removeOrgMember(ctxFor(), { userId: 'user-2' }),
        ).rejects.toMatchObject({ status: 409 });

        expect(deprovisionOrgAdminMock).not.toHaveBeenCalled();
        expect(orgMembershipDeleteMock).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the membership does not exist', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue(null);

        await expect(
            removeOrgMember(ctxFor(), { userId: 'user-99' }),
        ).rejects.toMatchObject({ status: 404 });

        expect(deprovisionOrgAdminMock).not.toHaveBeenCalled();
        expect(orgMembershipDeleteMock).not.toHaveBeenCalled();
    });

    it('throws ValidationError when userId is empty', async () => {
        await expect(
            removeOrgMember(ctxFor(), { userId: '' }),
        ).rejects.toMatchObject({ status: 400 });

        expect(orgMembershipFindUniqueMock).not.toHaveBeenCalled();
    });
});

// ── changeOrgMemberRole ───────────────────────────────────────────────

describe('changeOrgMemberRole', () => {
    // Default $transaction mock — invokes the callback with the same
    // prisma client, so methods called on `tx` resolve through the
    // outer mocks. Each test that needs a different shape overrides
    // this in its setup.
    function wireTransactionPassthrough() {
        transactionMock.mockImplementation(async (cb: unknown) => {
            const fn = cb as (tx: unknown) => Promise<unknown>;
            // The tx client is a structural subset of prisma — we
            // pass the orgMembership + tenant + tenantMembership
            // accessors the helpers might call. Provisioning helpers
            // are mocked at module boundary so they don't reach the
            // tx client; the role-change usecase only touches
            // tx.orgMembership.update + tx.orgMembership.count here.
            return fn({
                orgMembership: {
                    update: orgMembershipUpdateMock,
                    count: orgMembershipCountMock,
                },
            });
        });
    }

    it('READER → ADMIN: updates role inside tx and triggers provisioning fan-out', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue({
            id: 'mem-1',
            role: 'ORG_READER',
        });
        orgMembershipUpdateMock.mockResolvedValue({
            id: 'mem-1',
            organizationId: 'org-1',
            userId: 'user-2',
            role: 'ORG_ADMIN',
        });
        provisionOrgAdminMock.mockResolvedValue({
            created: 4,
            skipped: 0,
            totalConsidered: 4,
            tenantIds: ['t-1', 't-2', 't-3', 't-4'],
        });
        wireTransactionPassthrough();

        const result = await changeOrgMemberRole(ctxFor(), {
            userId: 'user-2',
            role: 'ORG_ADMIN',
        });

        // Single transaction wrapping both sides.
        expect(transactionMock).toHaveBeenCalledTimes(1);

        // Role updated.
        expect(orgMembershipUpdateMock).toHaveBeenCalledWith({
            where: { id: 'mem-1' },
            data: { role: 'ORG_ADMIN' },
            select: expect.any(Object),
        });

        // Provisioning called with the tx client (3rd arg, NOT the
        // global prisma).
        expect(provisionOrgAdminMock).toHaveBeenCalledTimes(1);
        const provisionCall = provisionOrgAdminMock.mock.calls[0];
        expect(provisionCall[0]).toBe('org-1');
        expect(provisionCall[1]).toBe('user-2');
        expect(provisionCall[2]).toBeDefined(); // tx client passed

        // Demotion side effect MUST NOT fire.
        expect(deprovisionOrgAdminMock).not.toHaveBeenCalled();

        expect(result.transition).toBe('reader_to_admin');
        expect(result.provision).toEqual({
            created: 4,
            skipped: 0,
            totalConsidered: 4,
            tenantIds: ['t-1', 't-2', 't-3', 't-4'],
        });
        expect(result.deprovision).toBeUndefined();
        expect(result.membership.role).toBe('ORG_ADMIN');

        // Audit fan-out: one ORG_AUDITOR_PROVISIONED row per
        // affected tenant, with previous/new role + promoted source
        // attribution.
        expect(appendAuditEntryMock).toHaveBeenCalledTimes(4);
        const tenantIdsAudited = appendAuditEntryMock.mock.calls
            .map((c) => (c[0] as { tenantId: string }).tenantId)
            .sort();
        expect(tenantIdsAudited).toEqual(['t-1', 't-2', 't-3', 't-4']);
        const sample = appendAuditEntryMock.mock.calls[0][0] as Record<string, unknown>;
        expect(sample.action).toBe('ORG_AUDITOR_PROVISIONED');
        const details = sample.detailsJson as Record<string, unknown>;
        expect(details.sourceAction).toBe('org_member_promoted');
        expect(details.previousOrgRole).toBe('ORG_READER');
        expect(details.newOrgRole).toBe('ORG_ADMIN');
    });

    it('ADMIN → READER: updates role inside tx and triggers deprovisioning (count > 1)', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue({
            id: 'mem-1',
            role: 'ORG_ADMIN',
        });
        // Outer count check + inner re-check in tx — both > 1.
        orgMembershipCountMock.mockResolvedValue(3);
        orgMembershipUpdateMock.mockResolvedValue({
            id: 'mem-1',
            organizationId: 'org-1',
            userId: 'user-2',
            role: 'ORG_READER',
        });
        deprovisionOrgAdminMock.mockResolvedValue({
            deleted: 4,
            tenantIds: ['t-1', 't-2', 't-3', 't-4'],
        });
        wireTransactionPassthrough();

        const result = await changeOrgMemberRole(ctxFor(), {
            userId: 'user-2',
            role: 'ORG_READER',
        });

        expect(transactionMock).toHaveBeenCalledTimes(1);

        // Deprovision called with the tx client (3rd arg).
        expect(deprovisionOrgAdminMock).toHaveBeenCalledTimes(1);
        const deprovisionCall = deprovisionOrgAdminMock.mock.calls[0];
        expect(deprovisionCall[0]).toBe('org-1');
        expect(deprovisionCall[1]).toBe('user-2');
        expect(deprovisionCall[2]).toBeDefined();

        // Provision side effect MUST NOT fire.
        expect(provisionOrgAdminMock).not.toHaveBeenCalled();

        expect(result.transition).toBe('admin_to_reader');
        expect(result.deprovision).toEqual({
            deleted: 4,
            tenantIds: ['t-1', 't-2', 't-3', 't-4'],
        });
        expect(result.provision).toBeUndefined();
        expect(result.membership.role).toBe('ORG_READER');

        // Audit fan-out: one ORG_AUDITOR_DEPROVISIONED row per
        // affected tenant, with previous/new role + demoted source
        // attribution.
        expect(appendAuditEntryMock).toHaveBeenCalledTimes(4);
        const tenantIdsAudited = appendAuditEntryMock.mock.calls
            .map((c) => (c[0] as { tenantId: string }).tenantId)
            .sort();
        expect(tenantIdsAudited).toEqual(['t-1', 't-2', 't-3', 't-4']);
        const sample = appendAuditEntryMock.mock.calls[0][0] as Record<string, unknown>;
        expect(sample.action).toBe('ORG_AUDITOR_DEPROVISIONED');
        const details = sample.detailsJson as Record<string, unknown>;
        expect(details.sourceAction).toBe('org_member_demoted');
        expect(details.previousOrgRole).toBe('ORG_ADMIN');
        expect(details.newOrgRole).toBe('ORG_READER');
    });

    it('no-op transition emits zero audit rows (no access change to evidence)', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue({
            id: 'mem-1',
            role: 'ORG_READER',
        });

        await changeOrgMemberRole(ctxFor(), {
            userId: 'user-2',
            role: 'ORG_READER',
        });

        expect(appendAuditEntryMock).not.toHaveBeenCalled();
    });

    it('ADMIN → READER: refuses to demote the last ORG_ADMIN (outer guard)', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue({
            id: 'mem-1',
            role: 'ORG_ADMIN',
        });
        // Last admin — guard refuses BEFORE opening the transaction.
        orgMembershipCountMock.mockResolvedValue(1);

        await expect(
            changeOrgMemberRole(ctxFor(), {
                userId: 'user-2',
                role: 'ORG_READER',
            }),
        ).rejects.toMatchObject({ status: 409 });

        // Transaction never opened, no role mutation, no
        // deprovisioning fan-in.
        expect(transactionMock).not.toHaveBeenCalled();
        expect(orgMembershipUpdateMock).not.toHaveBeenCalled();
        expect(deprovisionOrgAdminMock).not.toHaveBeenCalled();
    });

    it('ADMIN → READER: also catches the race inside the tx (inner re-check)', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue({
            id: 'mem-1',
            role: 'ORG_ADMIN',
        });
        // Outer count returns 2 (passes), inner returns 1 (race).
        orgMembershipCountMock
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(1);
        wireTransactionPassthrough();

        await expect(
            changeOrgMemberRole(ctxFor(), {
                userId: 'user-2',
                role: 'ORG_READER',
            }),
        ).rejects.toMatchObject({ status: 409 });

        // Transaction opened, but the tx body threw before the role
        // update or the deprovision call.
        expect(transactionMock).toHaveBeenCalledTimes(1);
        expect(orgMembershipUpdateMock).not.toHaveBeenCalled();
        expect(deprovisionOrgAdminMock).not.toHaveBeenCalled();
    });

    it('no-op transition: same role, no transaction, no provisioning', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue({
            id: 'mem-1',
            role: 'ORG_READER',
        });

        const result = await changeOrgMemberRole(ctxFor(), {
            userId: 'user-2',
            role: 'ORG_READER',
        });

        expect(result.transition).toBe('noop');
        expect(transactionMock).not.toHaveBeenCalled();
        expect(orgMembershipUpdateMock).not.toHaveBeenCalled();
        expect(provisionOrgAdminMock).not.toHaveBeenCalled();
        expect(deprovisionOrgAdminMock).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the membership does not exist', async () => {
        orgMembershipFindUniqueMock.mockResolvedValue(null);

        await expect(
            changeOrgMemberRole(ctxFor(), {
                userId: 'user-99',
                role: 'ORG_ADMIN',
            }),
        ).rejects.toMatchObject({ status: 404 });

        expect(transactionMock).not.toHaveBeenCalled();
    });

    it('throws ValidationError when userId is empty', async () => {
        await expect(
            changeOrgMemberRole(ctxFor(), {
                userId: '',
                role: 'ORG_ADMIN',
            }),
        ).rejects.toMatchObject({ status: 400 });
        expect(orgMembershipFindUniqueMock).not.toHaveBeenCalled();
    });
});
