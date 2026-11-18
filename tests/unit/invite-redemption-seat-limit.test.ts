/**
 * #3183 — the plan's seat limit is checked where a seat is TAKEN, not only
 * where an invite is written.
 *
 * `createInviteToken` already called `assertWithinLimit(ctx, 'user')`, but a
 * farm could issue any number of invites while under its limit and every one
 * of them redeemed into a membership afterwards. Redemption now runs the same
 * check inside the transaction that writes the membership — except when the
 * person is already an ACTIVE member, because re-redeeming adds no seat.
 */

const mockAssertWithinLimit = jest.fn();
jest.mock('@/lib/billing/entitlements', () => ({
    ...jest.requireActual('@/lib/billing/entitlements'),
    assertWithinLimit: (...args: unknown[]) => mockAssertWithinLimit(...args),
}));

jest.mock('@/lib/prisma', () => ({
    prisma: {
        tenantInvite: { findUnique: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
        tenant: { findUnique: jest.fn(), findFirst: jest.fn() },
        tenantMembership: { upsert: jest.fn() },
        $transaction: jest.fn(),
    },
}));
jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('@/lib/audit', () => ({ appendAuditEntry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));

import { redeemInvite } from '@/app-layer/usecases/tenant-invites';
import { prisma } from '@/lib/prisma';

const mocked = prisma as unknown as {
    tenantInvite: { findUnique: jest.Mock; updateMany: jest.Mock };
    $transaction: jest.Mock;
};

function arrangeClaim() {
    mocked.tenantInvite.updateMany.mockResolvedValueOnce({ count: 1 });
    mocked.tenantInvite.findUnique.mockResolvedValueOnce({
        id: 'invite-1',
        tenantId: 't1',
        email: 'me@example.test',
        role: 'EDITOR',
        invitedById: 'admin-1',
    });
}

function arrangeTx(existingStatus: string | null) {
    const upsert = jest.fn().mockResolvedValue({ id: 'm-1' });
    const tx = {
        tenantMembership: {
            upsert,
            findUnique: jest
                .fn()
                .mockResolvedValue(existingStatus ? { status: existingStatus } : null),
        },
        tenant: {
            findUnique: jest.fn().mockResolvedValue({ slug: 'acme' }),
            findFirst: jest.fn().mockResolvedValue({ slug: 'acme' }),
        },
    };
    mocked.$transaction.mockImplementationOnce(async (fn: (t: unknown) => unknown) => fn(tx));
    return { tx, upsert };
}

const redeem = () =>
    redeemInvite({ token: 'tok', userId: 'user-1', userEmail: 'me@example.test' });

beforeEach(() => {
    jest.clearAllMocks();
    mockAssertWithinLimit.mockReset();
    mockAssertWithinLimit.mockResolvedValue(undefined);
});

describe('invite redemption — seat limit (#3183)', () => {
    it('a NEW member is counted against the plan, on the redemption transaction', async () => {
        arrangeClaim();
        const { tx } = arrangeTx(null);

        await redeem();

        expect(mockAssertWithinLimit).toHaveBeenCalledTimes(1);
        expect(mockAssertWithinLimit).toHaveBeenCalledWith({ tenantId: 't1' }, 'user', tx);
    });

    it('a farm at its limit cannot gain a member by redeeming an old invite', async () => {
        arrangeClaim();
        const { upsert } = arrangeTx(null);
        mockAssertWithinLimit.mockRejectedValueOnce(new Error('plan_limit_exceeded: user'));

        await expect(redeem()).rejects.toThrow(/plan_limit_exceeded/);
        expect(upsert).not.toHaveBeenCalled();
    });

    it('a returning (REMOVED) member takes a seat again, so is counted', async () => {
        arrangeClaim();
        arrangeTx('REMOVED');

        await redeem();

        expect(mockAssertWithinLimit).toHaveBeenCalledTimes(1);
    });

    it('an already-ACTIVE member adds no seat, so is NOT counted', async () => {
        arrangeClaim();
        const { upsert } = arrangeTx('ACTIVE');

        await redeem();

        expect(mockAssertWithinLimit).not.toHaveBeenCalled();
        // Control: the redemption itself still ran.
        expect(upsert).toHaveBeenCalled();
    });
});
