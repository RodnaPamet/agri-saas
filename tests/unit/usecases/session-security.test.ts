/**
 * Unit tests for src/app-layer/usecases/session-security.ts
 *
 * Wave 4 of GAP-02. JWT revocation works by incrementing
 * `User.sessionVersion`. The auth callback compares the JWT's stamped
 * version against the DB on every request. A regression here breaks
 * the only mechanism we have to force-logout a compromised user.
 *
 * Behaviours protected:
 *   1. revokeUserSessions: self-revoke is always allowed (no admin
 *      check); revoking ANOTHER user requires canAdmin AND the target
 *      must share the caller's tenant.
 *   2. The membership lookup keys on `tenantId_userId` — a refactor
 *      that lookups by `userId` alone would let admin in tenant A
 *      revoke admin in tenant B.
 *   3. revokeAllTenantSessions is canAdmin-only and bulk-increments
 *      every member's sessionVersion.
 *   4. Audit emit is best-effort (failure NEVER blocks the revoke).
 *   5. getUserSessionVersion returns 0 when the user row is absent
 *      (safe default — auth callback treats this as "no session has
 *      ever been issued for this user").
 */

jest.mock('@/lib/prisma', () => ({
    prisma: {
        user: {
            findUnique: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        tenantMembership: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
        },
    },
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    revokeUserSessions,
    revokeCurrentSession,
    revokeAllTenantSessions,
    getUserSessionVersion,
} from '@/app-layer/usecases/session-security';
import { prisma } from '@/lib/prisma';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockUserFindUnique = prisma.user.findUnique as jest.MockedFunction<typeof prisma.user.findUnique>;
const mockUserUpdate = prisma.user.update as jest.MockedFunction<typeof prisma.user.update>;
const mockUserUpdateMany = prisma.user.updateMany as jest.MockedFunction<typeof prisma.user.updateMany>;
const mockMembershipFindUnique = prisma.tenantMembership.findUnique as jest.MockedFunction<typeof prisma.tenantMembership.findUnique>;
const mockMembershipFindMany = prisma.tenantMembership.findMany as jest.MockedFunction<typeof prisma.tenantMembership.findMany>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
    mockUserUpdate.mockResolvedValue({ id: 'user-1', sessionVersion: 2 } as never);
});

describe('revokeUserSessions — self vs other', () => {
    it('allows self-revoke without admin check (no canAdmin required)', async () => {
        const ctx = makeRequestContext('READER'); // even READER can self-revoke

        await revokeUserSessions(ctx, ctx.userId);

        // Regression: a refactor that tightened the gate to canAdmin
        // for ALL revokes would prevent users from logging themselves
        // out — the absolute baseline session-security practice.
        expect(mockMembershipFindUnique).not.toHaveBeenCalled();
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: ctx.userId },
                data: { sessionVersion: { increment: 1 } },
            }),
        );
    });

    it('rejects EDITOR revoking ANOTHER user (canAdmin required for cross-user revoke)', async () => {
        await expect(
            revokeUserSessions(makeRequestContext('EDITOR'), 'other-user'),
        ).rejects.toThrow(/Only admins/);
    });

    it('rejects ADMIN when target is NOT a member of the same tenant', async () => {
        mockMembershipFindUnique.mockResolvedValueOnce(null);

        await expect(
            revokeUserSessions(
                makeRequestContext('ADMIN', { tenantId: 'tenant-A' }),
                'tenant-B-user',
            ),
        ).rejects.toThrow(/not a member/);
        // Regression: a refactor that dropped the membership check
        // would let admin in A revoke admin in B's sessions — a
        // cross-tenant denial-of-service vector.
    });

    it('looks up membership keyed on tenantId_userId (composite, not userId alone)', async () => {
        mockMembershipFindUnique.mockResolvedValueOnce({
            id: 'm1', tenantId: 'tenant-1', userId: 'other',
        } as never);

        await revokeUserSessions(makeRequestContext('ADMIN'), 'other');

        expect(mockMembershipFindUnique).toHaveBeenCalledWith({
            where: {
                tenantId_userId: { tenantId: 'tenant-1', userId: 'other' },
            },
        });
    });

    it('audit emit is best-effort — revoke succeeds even if logEvent throws', async () => {
        mockLog.mockRejectedValueOnce(new Error('audit-chain-down'));

        const result = await revokeUserSessions(makeRequestContext('READER'));

        expect(result.newSessionVersion).toBe(2);
        // Regression: a refactor that let audit failure abort the revoke
        // would leave a compromised user with active sessions during
        // an audit-chain outage — the WORST possible window for this.
    });
});

describe('revokeCurrentSession', () => {
    it('delegates to revokeUserSessions with the caller userId', async () => {
        const ctx = makeRequestContext('EDITOR');

        const result = await revokeCurrentSession(ctx);

        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: ctx.userId } }),
        );
        expect(result.userId).toBe('user-1');
    });
});

describe('revokeAllTenantSessions', () => {
    it('rejects EDITOR (admin-only)', async () => {
        await expect(
            revokeAllTenantSessions(makeRequestContext('EDITOR')),
        ).rejects.toThrow(/Only admins/);
    });

    it('returns {usersAffected: 0} when the tenant has no memberships', async () => {
        mockMembershipFindMany.mockResolvedValueOnce([] as never);

        const result = await revokeAllTenantSessions(makeRequestContext('ADMIN'));

        expect(result.usersAffected).toBe(0);
        expect(mockUserUpdateMany).not.toHaveBeenCalled();
    });

    it('bulk-increments sessionVersion for every member of the tenant', async () => {
        mockMembershipFindMany.mockResolvedValueOnce([
            { userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' },
        ] as never);
        mockUserUpdateMany.mockResolvedValueOnce({ count: 3 } as never);

        const result = await revokeAllTenantSessions(makeRequestContext('ADMIN'));

        expect(mockUserUpdateMany).toHaveBeenCalledWith({
            where: { id: { in: ['u1', 'u2', 'u3'] } },
            data: { sessionVersion: { increment: 1 } },
        });
        expect(result.usersAffected).toBe(3);
    });
});

describe('getUserSessionVersion', () => {
    it('returns sessionVersion from the User row', async () => {
        mockUserFindUnique.mockResolvedValueOnce({ sessionVersion: 7 } as never);
        const v = await getUserSessionVersion('u1');
        expect(v).toBe(7);
    });

    it('returns 0 when the user row is missing (safe default)', async () => {
        mockUserFindUnique.mockResolvedValueOnce(null);
        const v = await getUserSessionVersion('missing');
        // Regression: returning undefined would force the auth callback's
        // strict-equality compare to fail and force-logout every JWT
        // for that userId — a real cascade if the user row is mid-delete.
        expect(v).toBe(0);
    });
});
