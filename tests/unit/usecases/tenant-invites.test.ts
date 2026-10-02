/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/tenant-invites.ts
 *
 * Wave 5 of GAP-02. Epic 1's invite flow is the ONLY way new
 * TenantMembership rows land — everything else (OAuth sign-in,
 * SCIM, even credentials self-signup) eventually goes through
 * `redeemInvite`. The security contract is dense:
 *
 *   1. Token is a 256-bit base64url random string with 7-day TTL.
 *   2. Email binding is strict, case-insensitive — a leaked
 *      token used by anyone other than the invitee is BURNT on
 *      first claim, not just rejected.
 *   3. The atomic claim is an `updateMany` predicate (the
 *      acceptedAt+revokedAt+expiresAt liveness gates), not a
 *      separate read-then-write — concurrent claims see
 *      count=0 and get a 410 Gone.
 *   4. OWNER role invites require admin.owner_management on top
 *      of admin.members — separation of duty.
 *   5. Audit emit is post-commit so the chain entry never points
 *      at a transaction that rolled back.
 */

jest.mock('@/lib/prisma', () => ({
    prisma: {
        tenantInvite: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            updateMany: jest.fn(),
        },
        tenant: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
        },
        tenantMembership: {
            upsert: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    createInviteToken,
    revokeInvite,
    bulkRevokeInvite,
    listPendingInvites,
    previewInviteByToken,
    redeemInvite,
} from '@/app-layer/usecases/tenant-invites';
import { prisma } from '@/lib/prisma';
import { runInTenantContext } from '@/lib/db-context';
import { appendAuditEntry } from '@/lib/audit';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockInviteFindUnique = prisma.tenantInvite.findUnique as jest.MockedFunction<typeof prisma.tenantInvite.findUnique>;
const mockInviteUpdateMany = prisma.tenantInvite.updateMany as jest.MockedFunction<typeof prisma.tenantInvite.updateMany>;
const mockTransaction = prisma.$transaction as jest.MockedFunction<any>;
const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockAppendAudit = appendAuditEntry as jest.MockedFunction<typeof appendAuditEntry>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('createInviteToken — RBAC + OWNER guard', () => {
    function txDb(opts: {
        existingUser?: { id: string } | null;
        existingMembershipStatus?: string;
        upsertResult?: object;
    } = {}) {
        return {
            user: (() => {
            // #1237: the email lookup is `findFirst` over the candidate list
            // (an `in` predicate is not valid on `findUnique`). ONE fn behind
            // both names, so a test's single `mockResolvedValue` drives the
            // code whichever method it calls — two separate fns silently stop
            // reaching it and every lookup reports "not found".
            const find = jest.fn().mockResolvedValue(opts.existingUser ?? null);
            return { findUnique: find, findFirst: find };
        })(),
            tenantMembership: {
                findUnique: jest.fn().mockResolvedValue(
                    opts.existingMembershipStatus
                        ? { status: opts.existingMembershipStatus }
                        : null,
                ),
            },
            tenantInvite: {
                upsert: jest.fn().mockResolvedValue(
                    opts.upsertResult ?? {
                        id: 'invite-1',
                        token: 'tok',
                        email: 'a@b.com',
                        role: 'EDITOR',
                    },
                ),
            },
        };
    }

    it('rejects EDITOR (canManageMembers gate)', async () => {
        await expect(
            createInviteToken(makeRequestContext('EDITOR'), {
                email: 'a@b.com',
                role: 'EDITOR',
            }),
        ).rejects.toThrow();
    });

    it('rejects OWNER role invite when caller lacks admin.owner_management', async () => {
        const ctx = makeRequestContext('ADMIN');
        // ADMIN's resolved permissions DENY owner_management — the
        // resolver should produce false. Verify here too in case a
        // future schema change widens ADMIN.
        ctx.appPermissions.admin.owner_management = false;

        await expect(
            createInviteToken(ctx, { email: 'a@b.com', role: 'OWNER' }),
        ).rejects.toThrow(/Only OWNERs can invite other OWNERs/);
        // Regression: a refactor that collapsed both gates into
        // canManageMembers alone would let any ADMIN promote
        // themselves to OWNER by inviting their own alt account.
    });

    it('allows OWNER role invite when caller is OWNER (has owner_management)', async () => {
        const ctx = makeRequestContext('OWNER');
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(txDb() as never));

        await expect(
            createInviteToken(ctx, { email: 'a@b.com', role: 'OWNER' }),
        ).resolves.toBeDefined();
    });

    it('rejects when the email already has an ACTIVE membership', async () => {
        const fakeDb = txDb({
            existingUser: { id: 'user-1' },
            existingMembershipStatus: 'ACTIVE',
        });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await expect(
            createInviteToken(makeRequestContext('ADMIN'), {
                email: 'existing@b.com',
                role: 'EDITOR',
            }),
        ).rejects.toThrow(/already a member/);
        // Regression: skipping this guard would let an admin
        // re-invite an active member, refresh the token, and
        // overwrite the role on redemption — privilege escalation.
        expect(fakeDb.tenantInvite.upsert).not.toHaveBeenCalled();
    });

    it('normalises email (trim + lowercase) before persistence', async () => {
        const fakeDb = txDb();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await createInviteToken(makeRequestContext('ADMIN'), {
            email: '   Mixed.Case@EXAMPLE.com  ',
            role: 'EDITOR',
        });

        const upsertArgs = (fakeDb.tenantInvite.upsert as jest.Mock).mock.calls[0][0];
        expect(upsertArgs.where.tenantId_email.email).toBe('mixed.case@example.com');
        expect(upsertArgs.create.email).toBe('mixed.case@example.com');
    });

    it('emits MEMBER_INVITED audit', async () => {
        const fakeDb = txDb();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await createInviteToken(makeRequestContext('ADMIN'), {
            email: 'a@b.com',
            role: 'EDITOR',
        });

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ action: 'MEMBER_INVITED' }),
        );
    });

    it('returns the relative URL `/invite/<token>` for emailing', async () => {
        const fakeDb = txDb({
            upsertResult: {
                id: 'invite-1',
                token: 'random-tok-xyz',
                email: 'a@b.com',
                role: 'EDITOR',
            },
        });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        const result = await createInviteToken(makeRequestContext('ADMIN'), {
            email: 'a@b.com',
            role: 'EDITOR',
        });

        expect(result.url).toBe('/invite/random-tok-xyz');
    });
});

describe('revokeInvite', () => {
    it('rejects EDITOR (canManageMembers gate)', async () => {
        await expect(
            revokeInvite(makeRequestContext('EDITOR'), { inviteId: 'i1' }),
        ).rejects.toThrow();
    });

    it('throws notFound on cross-tenant invite id', async () => {
        const fakeDb = {
            tenantInvite: {
                findFirst: jest.fn().mockResolvedValue(null),
                update: jest.fn(),
            },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        await expect(
            revokeInvite(makeRequestContext('ADMIN'), { inviteId: 'tenant-B-invite' }),
        ).rejects.toThrow(/already accepted\/revoked/);
        // Regression: a refactor that revoked by id without the
        // tenantId filter would let admin in A invalidate B's invites.
        expect(fakeDb.tenantInvite.update).not.toHaveBeenCalled();
    });
});

describe('bulkRevokeInvite', () => {
    it('rejects EDITOR (canManageMembers gate)', async () => {
        await expect(
            bulkRevokeInvite(makeRequestContext('EDITOR'), { inviteIds: ['i1'] }),
        ).rejects.toThrow();
    });

    it('returns { revoked: 0 } and skips updateMany when nothing matches', async () => {
        const fakeDb = {
            tenantInvite: {
                findMany: jest.fn().mockResolvedValue([]),
                updateMany: jest.fn(),
            },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        const result = await bulkRevokeInvite(makeRequestContext('ADMIN'), {
            inviteIds: ['gone', 'accepted'],
        });
        expect(result).toEqual({ revoked: 0 });
        expect(fakeDb.tenantInvite.updateMany).not.toHaveBeenCalled();
    });

    it('revokes matching invites tenant-scoped + audits each + returns count', async () => {
        const fakeDb = {
            tenantInvite: {
                findMany: jest.fn().mockResolvedValue([
                    { id: 'i1', email: 'a@x.io' },
                    { id: 'i2', email: 'b@x.io' },
                ]),
                updateMany: jest.fn().mockResolvedValue({ count: 2 }),
            },
        };
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDb as never));

        const result = await bulkRevokeInvite(makeRequestContext('ADMIN'), {
            inviteIds: ['i1', 'i2', 'foreign'],
        });

        expect(result).toEqual({ revoked: 2 });
        // Tenant + lifecycle filter on the find — a refactor dropping
        // tenantId would let an admin in A revoke B's invites.
        const findWhere = fakeDb.tenantInvite.findMany.mock.calls[0][0].where;
        expect(findWhere.tenantId).toBeDefined();
        expect(findWhere.acceptedAt).toBeNull();
        expect(findWhere.revokedAt).toBeNull();
        // updateMany carries the same tenant + lifecycle guard.
        const updWhere = fakeDb.tenantInvite.updateMany.mock.calls[0][0].where;
        expect(updWhere.tenantId).toBeDefined();
        expect(updWhere.acceptedAt).toBeNull();
        // One audit row per actually-revoked invite (not per requested id).
        expect(mockLog).toHaveBeenCalledTimes(2);
    });
});

describe('listPendingInvites', () => {
    it('rejects when caller cannot view admin settings', async () => {
        // canViewAdminSettings is satisfied by ADMIN; READER cannot.
        await expect(
            listPendingInvites(makeRequestContext('READER')),
        ).rejects.toThrow();
    });
});

describe('previewInviteByToken — null on every failure mode', () => {
    it('returns null when the token does not exist', async () => {
        mockInviteFindUnique.mockResolvedValueOnce(null);
        const result = await previewInviteByToken('nope', null);
        expect(result).toBeNull();
    });

    it('returns null for revoked invites', async () => {
        mockInviteFindUnique.mockResolvedValueOnce({
            email: 'a@b.com',
            role: 'EDITOR',
            revokedAt: new Date(),
            acceptedAt: null,
            expiresAt: new Date(Date.now() + 100000),
            tenant: { name: 'Acme', slug: 'acme' },
        } as never);

        expect(await previewInviteByToken('tok', null)).toBeNull();
        // Regression: surfacing tenant name + role for revoked
        // invites would let an attacker probe valid token strings
        // for tenant metadata.
    });

    it('returns null for accepted invites', async () => {
        mockInviteFindUnique.mockResolvedValueOnce({
            email: 'a@b.com',
            acceptedAt: new Date(),
            revokedAt: null,
            expiresAt: new Date(Date.now() + 100000),
            tenant: { name: 'Acme', slug: 'acme' },
        } as never);

        expect(await previewInviteByToken('tok', null)).toBeNull();
    });

    it('returns null for expired invites', async () => {
        mockInviteFindUnique.mockResolvedValueOnce({
            email: 'a@b.com',
            acceptedAt: null,
            revokedAt: null,
            expiresAt: new Date(Date.now() - 1000),
            tenant: { name: 'Acme', slug: 'acme' },
        } as never);

        expect(await previewInviteByToken('tok', null)).toBeNull();
    });

    it('matchesSession is case-insensitive', async () => {
        mockInviteFindUnique.mockResolvedValueOnce({
            email: 'Mixed.Case@Example.COM',
            role: 'EDITOR',
            acceptedAt: null,
            revokedAt: null,
            expiresAt: new Date(Date.now() + 100000),
            tenant: { name: 'Acme', slug: 'acme' },
        } as never);

        const result = await previewInviteByToken('tok', 'mixed.case@example.com');
        expect(result?.matchesSession).toBe(true);
        // Regression: a strict-equal compare would force the
        // signed-in user to use the exact case of the invite
        // email — most OAuth providers normalise email to
        // lowercase, so the user would be locked out of valid
        // invites sent to "John.Doe@..." style addresses.
    });
});

describe('redeemInvite — atomic claim + email binding', () => {
    it('throws notFound when the token does not exist', async () => {
        mockInviteUpdateMany.mockResolvedValueOnce({ count: 0 } as never);
        mockInviteFindUnique.mockResolvedValueOnce(null);

        await expect(
            redeemInvite({
                token: 'nope',
                userId: 'user-1',
                userEmail: 'a@b.com',
            }),
        ).rejects.toThrow(/Invite not found/);
    });

    it('throws gone when the invite was revoked', async () => {
        mockInviteUpdateMany.mockResolvedValueOnce({ count: 0 } as never);
        mockInviteFindUnique.mockResolvedValueOnce({
            acceptedAt: null,
            revokedAt: new Date(),
            expiresAt: new Date(Date.now() + 100000),
        } as never);

        await expect(
            redeemInvite({
                token: 'tok',
                userId: 'user-1',
                userEmail: 'a@b.com',
            }),
        ).rejects.toThrow(/revoked/);
    });

    it('throws gone when the invite has expired', async () => {
        mockInviteUpdateMany.mockResolvedValueOnce({ count: 0 } as never);
        mockInviteFindUnique.mockResolvedValueOnce({
            acceptedAt: null,
            revokedAt: null,
            expiresAt: new Date(Date.now() - 1000),
        } as never);

        await expect(
            redeemInvite({
                token: 'tok',
                userId: 'user-1',
                userEmail: 'a@b.com',
            }),
        ).rejects.toThrow(/expired/);
    });

    it('throws gone when the invite was already redeemed (race lost)', async () => {
        mockInviteUpdateMany.mockResolvedValueOnce({ count: 0 } as never);
        mockInviteFindUnique.mockResolvedValueOnce({
            acceptedAt: new Date(),
            revokedAt: null,
            expiresAt: new Date(Date.now() + 100000),
        } as never);

        await expect(
            redeemInvite({
                token: 'tok',
                userId: 'user-1',
                userEmail: 'a@b.com',
            }),
        ).rejects.toThrow(/already been redeemed/);
        // Regression: a refactor that returned the existing membership
        // instead of throwing would let two concurrent redemptions of
        // the same token both "succeed" — the second sees an active
        // membership and silently no-ops, masking a possible token
        // leak from the security team.
    });

    it('email mismatch: invite IS BURNT — the throw must NOT roll back the claim', async () => {
        // The claim is committed (count=1). Then the email check fails.
        // The thrown error must come from the standalone post-claim path,
        // NOT from inside a transaction that would roll back the claim.
        mockInviteUpdateMany.mockResolvedValueOnce({ count: 1 } as never);
        mockInviteFindUnique.mockResolvedValueOnce({
            id: 'invite-1',
            tenantId: 't1',
            email: 'real-invitee@b.com',
            role: 'EDITOR',
            invitedById: 'admin-1',
        } as never);

        await expect(
            redeemInvite({
                token: 'leaked-tok',
                userId: 'attacker-id',
                userEmail: 'attacker@b.com',
            }),
        ).rejects.toThrow(/Invite email does not match/);
        // Regression: putting the email-binding inside a $transaction
        // would have Prisma roll back the acceptedAt write on throw.
        // A leaked token could then be tried again by the legitimate
        // invitee — but worse, an attacker could keep retrying with
        // different userEmail values until they found one that
        // matched.  We check that the $transaction was NOT entered
        // (the post-claim email check is sequenced before the tx).
        expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('happy path: $transaction upserts membership, post-commit audit fires', async () => {
        mockInviteUpdateMany.mockResolvedValueOnce({ count: 1 } as never);
        mockInviteFindUnique.mockResolvedValueOnce({
            id: 'invite-1',
            tenantId: 't1',
            email: 'me@b.com',
            role: 'EDITOR',
            invitedById: 'admin-1',
        } as never);

        const upsertSpy = jest.fn().mockResolvedValue({ id: 'membership-1' });
        mockTransaction.mockImplementationOnce(async (fn: any) =>
            fn({
                tenantMembership: { upsert: upsertSpy },
                tenant: {
                    findUnique: jest.fn().mockResolvedValue({ slug: 'acme' }),
                    findFirst: jest.fn().mockResolvedValue({ slug: 'acme' }),
                },
            }),
        );

        const result = await redeemInvite({
            token: 'tok',
            userId: 'user-1',
            userEmail: 'me@b.com',
        });

        expect(result).toEqual({
            tenantId: 't1',
            slug: 'acme',
            role: 'EDITOR',
        });
        expect(upsertSpy).toHaveBeenCalled();
        // Regression: appendAuditEntry is INTENTIONALLY post-tx
        // because it opens its own advisory-locked transaction.
        // Calling it inside the tx would deadlock; calling it
        // pre-tx would emit chain entries pointing at writes that
        // could still roll back.
        expect(mockAppendAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'MEMBER_INVITE_ACCEPTED',
                entity: 'TenantMembership',
            }),
        );
    });
});
