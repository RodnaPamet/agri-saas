/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks + fake DB. */
/**
 * Unit tests for `src/app-layer/usecases/org-invites.ts` — the
 * organization-invite lifecycle.
 *
 * Wave-6 / stage-3d branch coverage. The biggest remaining
 * untested usecase file (512 lines) and one of the THREE paths
 * that can write an `OrgMembership` row (per CLAUDE.md's Epic 1
 * section + `tests/guardrails/no-auto-join.test.ts`). A bug here
 * either lets a leaked token redeem successfully OR silently
 * fails to fire the provisioning fan-out for an ORG_ADMIN —
 * both compliance-critical.
 *
 * Branch matrix covered:
 *
 *   createOrgInviteToken:
 *     - empty email reject
 *     - invalid role reject
 *     - existing user → already-member reject
 *     - new email → no membership check, upsert create
 *     - audit-emit success + audit-emit failure (swallowed)
 *
 *   revokeOrgInvite:
 *     - not-found (or already accepted / revoked)
 *     - happy path + audit
 *     - audit failure swallowed
 *
 *   listPendingOrgInvites:
 *     - active filter shape (non-expired, non-revoked, non-accepted)
 *
 *   previewOrgInviteByToken (5 outcome branches):
 *     - invite not found → null
 *     - revoked → null
 *     - accepted → null
 *     - expired → null
 *     - happy + matchesSession TRUE (case-insensitive)
 *     - happy + matchesSession FALSE (no session email)
 *
 *   redeemOrgInvite (the high-risk path):
 *     - atomic claim succeeds (count === 1)
 *     - claim fails + invite not found → notFound
 *     - claim fails + revoked → gone
 *     - claim fails + expired → gone
 *     - claim fails + already accepted → gone
 *     - claim fails + race (no specific reason) → internal
 *     - Step 2 invariant: re-fetch returns null → internal
 *     - Step 3 email mismatch → forbidden (token already burnt)
 *     - Step 4 organization missing → internal
 *     - Step 5 provision triggers for ORG_ADMIN (not ORG_READER)
 *     - Step 6 audits fire for INVITE_REDEEMED + MEMBER_ADDED
 *     - Step 6 PROVISIONED_TO_TENANTS only when provision.created > 0
 *     - safeOrgAudit swallows audit-emit failures
 */

const auditCalls: any[] = [];
const provisionCalls: any[] = [];

jest.mock('@/lib/audit/org-audit-writer', () => ({
    appendOrgAuditEntry: jest.fn(async (entry: any) => {
        auditCalls.push(entry);
    }),
}));

jest.mock('@/app-layer/usecases/org-provisioning', () => ({
    provisionOrgAdminToTenants: jest.fn(async (orgId: string, userId: string) => {
        provisionCalls.push({ orgId, userId });
        return { created: 1, tenantIds: ['t-1'] };
    }),
}));

jest.mock('@/lib/security/encryption', () => ({
    hashForLookup: jest.fn((s: string) => `hash(${s})`),
    hashForLookupCandidates: jest.fn((s: string) => [`hash(${s})`]),
}));

const mockPrisma: any = {
    // #1237: the email lookup is `findFirst` over the candidate list now. Both
    // names share ONE fn so a test's single `mockResolvedValue` drives the code
    // whichever method it calls.
    user: (() => {
        const find = jest.fn();
        return { findUnique: find, findFirst: find };
    })(),
    orgMembership: { findUnique: jest.fn(), upsert: jest.fn() },
    orgInvite: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
    organization: { findUnique: jest.fn() },
    $transaction: jest.fn(async (cb: any) =>
        cb({
            orgMembership: { upsert: mockPrisma.orgMembership.upsert },
            organization: { findUnique: mockPrisma.organization.findUnique },
        }),
    ),
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    prisma: mockPrisma,
    default: mockPrisma,
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import {
    createOrgInviteToken,
    revokeOrgInvite,
    listPendingOrgInvites,
    previewOrgInviteByToken,
    redeemOrgInvite,
} from '@/app-layer/usecases/org-invites';
import { appendOrgAuditEntry } from '@/lib/audit/org-audit-writer';
import { provisionOrgAdminToTenants } from '@/app-layer/usecases/org-provisioning';
import type { OrgContext } from '@/app-layer/types';

const orgCtx: OrgContext = {
    requestId: 'req-test',
    userId: 'user-actor',
    organizationId: 'org-1',
    orgSlug: 'acme',
    orgRole: 'ORG_ADMIN' as any,
    permissions: {} as any,
};

beforeEach(() => {
    auditCalls.length = 0;
    provisionCalls.length = 0;
    [
        mockPrisma.user.findUnique,
        mockPrisma.orgMembership.findUnique, mockPrisma.orgMembership.upsert,
        mockPrisma.orgInvite.findUnique, mockPrisma.orgInvite.findFirst,
        mockPrisma.orgInvite.findMany, mockPrisma.orgInvite.upsert,
        mockPrisma.orgInvite.update, mockPrisma.orgInvite.updateMany,
        mockPrisma.organization.findUnique,
        appendOrgAuditEntry as jest.Mock,
        provisionOrgAdminToTenants as jest.Mock,
    ].forEach((m: any) => m.mockReset && m.mockReset());
    // Re-arm default behaviours.
    (appendOrgAuditEntry as jest.Mock).mockImplementation(async (entry: any) => {
        auditCalls.push(entry);
    });
    (provisionOrgAdminToTenants as jest.Mock).mockImplementation(async (orgId: string, userId: string) => {
        provisionCalls.push({ orgId, userId });
        return { created: 1, tenantIds: ['t-1'] };
    });
});

// ──────────────────────────────────────────────────────────────────────
// createOrgInviteToken
// ──────────────────────────────────────────────────────────────────────
describe('createOrgInviteToken', () => {
    it('rejects empty email with badRequest', async () => {
        await expect(
            createOrgInviteToken(orgCtx, { email: '   ', role: 'ORG_READER' as any }),
        ).rejects.toThrow(/email is required/i);
    });

    it('rejects an invalid role with badRequest naming the value', async () => {
        await expect(
            createOrgInviteToken(orgCtx, { email: 'x@y.z', role: 'OWNER' as any }),
        ).rejects.toThrow(/invalid role 'owner'/i);
    });

    it('REJECTS when the user already has an OrgMembership in this org', async () => {
        // Compliance-critical guard: prevents an admin from "inviting"
        // a current member to a different role via the invite flow
        // (the proper path is `updateOrgMemberRole`).
        mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'u-existing' });
        mockPrisma.orgMembership.findUnique.mockResolvedValueOnce({ role: 'ORG_READER' });

        await expect(
            createOrgInviteToken(orgCtx, { email: 'bob@example.com', role: 'ORG_ADMIN' as any }),
        ).rejects.toThrow(/already a member.*ORG_READER/);
        expect(mockPrisma.orgInvite.upsert).not.toHaveBeenCalled();
    });

    it('creates a fresh invite when the email has no existing user', async () => {
        mockPrisma.user.findUnique.mockResolvedValueOnce(null);
        mockPrisma.orgInvite.upsert.mockResolvedValueOnce({
            id: 'inv-1', token: 'tok-abc', email: 'new@example.com',
        });

        const result = await createOrgInviteToken(orgCtx, {
            email: 'NEW@example.com',
            role: 'ORG_READER' as any,
        });

        // Email normalized to lowercase + trimmed; URL uses raw token.
        expect(mockPrisma.orgInvite.upsert.mock.calls[0][0].create.email).toBe('new@example.com');
        expect(result.url).toBe('/invite/org/tok-abc');
        // Membership-lookup is skipped when the user doesn't exist.
        expect(mockPrisma.orgMembership.findUnique).not.toHaveBeenCalled();
    });

    it('re-issues an invite (upsert update branch) when the email already had a prior invite', async () => {
        // Re-invite after expiry / revocation: upsert.update clears
        // acceptedAt + revokedAt so the new token works cleanly.
        mockPrisma.user.findUnique.mockResolvedValueOnce(null);
        mockPrisma.orgInvite.upsert.mockResolvedValueOnce({
            id: 'inv-1', token: 'tok-new', email: 'reinvite@example.com',
        });

        await createOrgInviteToken(orgCtx, { email: 'reinvite@example.com', role: 'ORG_ADMIN' as any });

        const update = mockPrisma.orgInvite.upsert.mock.calls[0][0].update;
        expect(update.acceptedAt).toBeNull();
        expect(update.revokedAt).toBeNull();
        expect(update.role).toBe('ORG_ADMIN');
    });

    it('audit-emit failure does NOT fail the user-facing create', async () => {
        mockPrisma.user.findUnique.mockResolvedValueOnce(null);
        mockPrisma.orgInvite.upsert.mockResolvedValueOnce({
            id: 'inv-1', token: 'tok-1', email: 'x@y.z',
        });
        (appendOrgAuditEntry as jest.Mock).mockRejectedValueOnce(new Error('audit db down'));

        const result = await createOrgInviteToken(orgCtx, {
            email: 'x@y.z', role: 'ORG_READER' as any,
        });

        // Best-effort audit — the privilege change is durable in the
        // DB row, audit failure can't roll that back.
        expect(result.invite.id).toBe('inv-1');
    });
});

// ──────────────────────────────────────────────────────────────────────
// revokeOrgInvite
// ──────────────────────────────────────────────────────────────────────
describe('revokeOrgInvite', () => {
    it('throws notFound when the invite is missing OR already accepted/revoked', async () => {
        // The findFirst filter already excludes accepted/revoked rows,
        // so any null result is the not-found path — collapsing all
        // three states into one 404 keeps the API enumeration-safe.
        mockPrisma.orgInvite.findFirst.mockResolvedValueOnce(null);
        await expect(
            revokeOrgInvite(orgCtx, { inviteId: 'inv-missing' }),
        ).rejects.toThrow(/invite not found or already accepted\/revoked/i);
        expect(mockPrisma.orgInvite.update).not.toHaveBeenCalled();
    });

    it('stamps revokedAt + fires ORG_INVITE_REVOKED audit on happy path', async () => {
        mockPrisma.orgInvite.findFirst.mockResolvedValueOnce({
            id: 'inv-1', email: 'bob@example.com', role: 'ORG_READER',
        });
        mockPrisma.orgInvite.update.mockResolvedValueOnce({ id: 'inv-1' });

        await revokeOrgInvite(orgCtx, { inviteId: 'inv-1' });

        expect(mockPrisma.orgInvite.update).toHaveBeenCalledWith({
            where: { id: 'inv-1' },
            data: { revokedAt: expect.any(Date) },
        });
        expect(auditCalls).toHaveLength(1);
        expect(auditCalls[0].action).toBe('ORG_INVITE_REVOKED');
    });

    it('SWALLOWS audit failure — the revoke still succeeds', async () => {
        mockPrisma.orgInvite.findFirst.mockResolvedValueOnce({
            id: 'inv-1', email: 'x@y.z', role: 'ORG_READER',
        });
        mockPrisma.orgInvite.update.mockResolvedValueOnce({ id: 'inv-1' });
        (appendOrgAuditEntry as jest.Mock).mockRejectedValueOnce(new Error('audit db down'));

        // Should resolve cleanly (revoke is durable in the DB).
        await expect(revokeOrgInvite(orgCtx, { inviteId: 'inv-1' })).resolves.toBeUndefined();
    });
});

// ──────────────────────────────────────────────────────────────────────
// listPendingOrgInvites
// ──────────────────────────────────────────────────────────────────────
describe('listPendingOrgInvites', () => {
    it('filters by (org, acceptedAt=null, revokedAt=null, not-expired) — non-leaking shape', async () => {
        mockPrisma.orgInvite.findMany.mockResolvedValueOnce([]);
        await listPendingOrgInvites(orgCtx);

        const where = mockPrisma.orgInvite.findMany.mock.calls[0][0].where;
        expect(where.organizationId).toBe('org-1');
        expect(where.acceptedAt).toBeNull();
        expect(where.revokedAt).toBeNull();
        expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
    });
});

// ──────────────────────────────────────────────────────────────────────
// previewOrgInviteByToken — five outcome branches
// ──────────────────────────────────────────────────────────────────────
describe('previewOrgInviteByToken', () => {
    it('returns null when no invite matches the token', async () => {
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce(null);
        const result = await previewOrgInviteByToken('bogus', 'user@x.y');
        expect(result).toBeNull();
    });

    it('returns null when the invite has been revoked', async () => {
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            email: 'x@y.z', revokedAt: new Date(), acceptedAt: null,
            expiresAt: new Date(Date.now() + 1_000_000),
            role: 'ORG_READER', organization: { name: 'X', slug: 'x' },
        });
        const result = await previewOrgInviteByToken('tok-revoked', null);
        expect(result).toBeNull();
    });

    it('returns null when the invite has already been accepted', async () => {
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            email: 'x@y.z', revokedAt: null, acceptedAt: new Date(),
            expiresAt: new Date(Date.now() + 1_000_000),
            role: 'ORG_READER', organization: { name: 'X', slug: 'x' },
        });
        const result = await previewOrgInviteByToken('tok-accepted', null);
        expect(result).toBeNull();
    });

    it('returns null when the invite has expired', async () => {
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            email: 'x@y.z', revokedAt: null, acceptedAt: null,
            expiresAt: new Date('2020-01-01'),
            role: 'ORG_READER', organization: { name: 'X', slug: 'x' },
        });
        const result = await previewOrgInviteByToken('tok-expired', null);
        expect(result).toBeNull();
    });

    it('matchesSession=true when sessionEmail equals invite.email (case-insensitive)', async () => {
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            email: 'bob@example.com', revokedAt: null, acceptedAt: null,
            expiresAt: new Date(Date.now() + 1_000_000),
            role: 'ORG_ADMIN',
            organization: { name: 'Acme', slug: 'acme' },
        });

        const result = await previewOrgInviteByToken('tok', '  BOB@example.com ');

        expect(result?.matchesSession).toBe(true);
        expect(result?.organizationName).toBe('Acme');
        expect(result?.role).toBe('ORG_ADMIN');
    });

    it('matchesSession=false when sessionEmail is null', async () => {
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            email: 'bob@example.com', revokedAt: null, acceptedAt: null,
            expiresAt: new Date(Date.now() + 1_000_000),
            role: 'ORG_READER',
            organization: { name: 'Acme', slug: 'acme' },
        });
        const result = await previewOrgInviteByToken('tok', null);
        expect(result?.matchesSession).toBe(false);
    });

    it('matchesSession=false when sessionEmail differs', async () => {
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            email: 'bob@example.com', revokedAt: null, acceptedAt: null,
            expiresAt: new Date(Date.now() + 1_000_000),
            role: 'ORG_READER',
            organization: { name: 'Acme', slug: 'acme' },
        });
        const result = await previewOrgInviteByToken('tok', 'alice@example.com');
        expect(result?.matchesSession).toBe(false);
    });
});

// ──────────────────────────────────────────────────────────────────────
// redeemOrgInvite — the high-risk path
// ──────────────────────────────────────────────────────────────────────
describe('redeemOrgInvite', () => {
    const redeemInput = {
        token: 'tok-1',
        userId: 'u-redeemer',
        userEmail: 'bob@example.com',
        requestId: 'req-r',
    };

    it('atomic-claim-fails + invite missing → notFound', async () => {
        mockPrisma.orgInvite.updateMany.mockResolvedValueOnce({ count: 0 });
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce(null);
        await expect(redeemOrgInvite(redeemInput)).rejects.toThrow(/invite not found/i);
    });

    it('atomic-claim-fails + revoked → gone', async () => {
        mockPrisma.orgInvite.updateMany.mockResolvedValueOnce({ count: 0 });
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            acceptedAt: null, revokedAt: new Date(), expiresAt: new Date(Date.now() + 1_000_000),
        });
        await expect(redeemOrgInvite(redeemInput)).rejects.toThrow(/revoked/i);
    });

    it('atomic-claim-fails + expired → gone', async () => {
        mockPrisma.orgInvite.updateMany.mockResolvedValueOnce({ count: 0 });
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            acceptedAt: null, revokedAt: null, expiresAt: new Date('2020-01-01'),
        });
        await expect(redeemOrgInvite(redeemInput)).rejects.toThrow(/expired/i);
    });

    it('atomic-claim-fails + already accepted → gone', async () => {
        mockPrisma.orgInvite.updateMany.mockResolvedValueOnce({ count: 0 });
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            acceptedAt: new Date(), revokedAt: null, expiresAt: new Date(Date.now() + 1_000_000),
        });
        await expect(redeemOrgInvite(redeemInput)).rejects.toThrow(/already been redeemed/i);
    });

    it('atomic-claim-fails + no specific reason → internal (race condition)', async () => {
        // The expiresAt re-check is the load-bearing branch here —
        // an invite that's not-yet-expired AND not-accepted AND
        // not-revoked but still failed the updateMany means a
        // concurrent claim raced.
        mockPrisma.orgInvite.updateMany.mockResolvedValueOnce({ count: 0 });
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            acceptedAt: null, revokedAt: null,
            expiresAt: new Date(Date.now() + 1_000_000),
        });
        await expect(redeemOrgInvite(redeemInput)).rejects.toThrow(/race condition/i);
    });

    it('Step-2 invariant: refetch returns null → internal', async () => {
        // updateMany succeeded but the row vanished before re-fetch.
        // A non-recoverable state — but the surface is internal, not
        // notFound, because the burn has already committed.
        mockPrisma.orgInvite.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce(null);
        await expect(redeemOrgInvite(redeemInput)).rejects.toThrow(/disappeared/i);
    });

    it('Step-3 EMAIL MISMATCH: token is already burnt; mismatch → forbidden', async () => {
        // Compliance-critical: a leaked token reaches the burn step
        // (count=1) but the redeemer's session email differs. The
        // burn STILL committed — re-trying with the right session
        // is impossible (good!), and the response is forbidden, not
        // notFound, so the user gets a clear "wrong account" signal.
        mockPrisma.orgInvite.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            id: 'inv-1',
            organizationId: 'org-1',
            email: 'alice@example.com',
            role: 'ORG_READER',
            invitedById: 'u-admin',
        });

        await expect(
            redeemOrgInvite({ ...redeemInput, userEmail: 'bob@example.com' }),
        ).rejects.toThrow(/email does not match/i);
        // No membership write attempted on the email-mismatch branch.
        expect(mockPrisma.orgMembership.upsert).not.toHaveBeenCalled();
    });

    it('Step-4 organization missing → internal (invariant violation)', async () => {
        mockPrisma.orgInvite.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            id: 'inv-1', organizationId: 'org-1', email: 'bob@example.com',
            role: 'ORG_READER', invitedById: 'u-admin',
        });
        mockPrisma.orgMembership.upsert.mockResolvedValueOnce({ id: 'mem-1' });
        mockPrisma.organization.findUnique.mockResolvedValueOnce(null);

        await expect(redeemOrgInvite(redeemInput)).rejects.toThrow(/organization disappeared/i);
    });

    it('ORG_READER happy path: upserts membership + emits 2 audit rows + NO provision call', async () => {
        mockPrisma.orgInvite.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            id: 'inv-1', organizationId: 'org-1', email: 'bob@example.com',
            role: 'ORG_READER', invitedById: 'u-admin',
        });
        mockPrisma.orgMembership.upsert.mockResolvedValueOnce({ id: 'mem-1' });
        mockPrisma.organization.findUnique.mockResolvedValueOnce({ slug: 'acme' });

        const result = await redeemOrgInvite(redeemInput);

        expect(result.role).toBe('ORG_READER');
        expect(result.organizationSlug).toBe('acme');
        expect(result.provision).toBeUndefined();
        expect(provisionCalls).toHaveLength(0);
        // 2 audits: INVITE_REDEEMED + MEMBER_ADDED (no PROVISIONED).
        expect(auditCalls).toHaveLength(2);
        expect(auditCalls[0].action).toBe('ORG_INVITE_REDEEMED');
        expect(auditCalls[1].action).toBe('ORG_MEMBER_ADDED');
    });

    it('ORG_ADMIN happy path: fires provisioning + 3 audit rows including PROVISIONED_TO_TENANTS', async () => {
        mockPrisma.orgInvite.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            id: 'inv-1', organizationId: 'org-1', email: 'bob@example.com',
            role: 'ORG_ADMIN', invitedById: 'u-admin',
        });
        mockPrisma.orgMembership.upsert.mockResolvedValueOnce({ id: 'mem-1' });
        mockPrisma.organization.findUnique.mockResolvedValueOnce({ slug: 'acme' });

        const result = await redeemOrgInvite(redeemInput);

        expect(result.role).toBe('ORG_ADMIN');
        expect(result.provision).toEqual({ created: 1, tenantIds: ['t-1'] });
        // Provisioning ran AFTER membership commit + BEFORE audits.
        expect(provisionCalls).toEqual([{ orgId: 'org-1', userId: 'u-redeemer' }]);
        // 3 audits: REDEEMED + MEMBER_ADDED + PROVISIONED_TO_TENANTS.
        expect(auditCalls).toHaveLength(3);
        const actions = auditCalls.map((a) => a.action);
        expect(actions).toContain('ORG_ADMIN_PROVISIONED_TO_TENANTS');
    });

    it('ORG_ADMIN with zero tenants provisioned: NO PROVISIONED_TO_TENANTS audit fires', async () => {
        // The PROVISIONED_TO_TENANTS audit is conditional on
        // provision.created > 0 — a fan-out that touched zero
        // tenants does not pollute the audit log.
        (provisionOrgAdminToTenants as jest.Mock).mockResolvedValueOnce({ created: 0, tenantIds: [] });

        mockPrisma.orgInvite.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            id: 'inv-1', organizationId: 'org-1', email: 'bob@example.com',
            role: 'ORG_ADMIN', invitedById: 'u-admin',
        });
        mockPrisma.orgMembership.upsert.mockResolvedValueOnce({ id: 'mem-1' });
        mockPrisma.organization.findUnique.mockResolvedValueOnce({ slug: 'acme' });

        await redeemOrgInvite(redeemInput);

        const actions = auditCalls.map((a) => a.action);
        expect(actions).toContain('ORG_INVITE_REDEEMED');
        expect(actions).toContain('ORG_MEMBER_ADDED');
        expect(actions).not.toContain('ORG_ADMIN_PROVISIONED_TO_TENANTS');
    });

    it('safeOrgAudit swallows failures: redemption returns its happy-path result', async () => {
        // Audit emission is best-effort. A failure in the audit
        // emitter must NOT undo a successful membership.
        mockPrisma.orgInvite.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            id: 'inv-1', organizationId: 'org-1', email: 'bob@example.com',
            role: 'ORG_READER', invitedById: 'u-admin',
        });
        mockPrisma.orgMembership.upsert.mockResolvedValueOnce({ id: 'mem-1' });
        mockPrisma.organization.findUnique.mockResolvedValueOnce({ slug: 'acme' });
        (appendOrgAuditEntry as jest.Mock).mockRejectedValue(new Error('audit db down'));

        const result = await redeemOrgInvite(redeemInput);

        expect(result.role).toBe('ORG_READER');
        expect(result.organizationSlug).toBe('acme');
    });

    it('case-insensitive email match: bob@x.y === BOB@X.Y (trimmed)', async () => {
        // Email is normalized at compare time; mixed case in either
        // the invite or the session must still match.
        mockPrisma.orgInvite.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.orgInvite.findUnique.mockResolvedValueOnce({
            id: 'inv-1', organizationId: 'org-1',
            email: 'BOB@example.com',
            role: 'ORG_READER', invitedById: 'u-admin',
        });
        mockPrisma.orgMembership.upsert.mockResolvedValueOnce({ id: 'mem-1' });
        mockPrisma.organization.findUnique.mockResolvedValueOnce({ slug: 'acme' });

        const result = await redeemOrgInvite({
            ...redeemInput,
            userEmail: '  bob@example.com ',
        });

        expect(result.role).toBe('ORG_READER');
    });
});
