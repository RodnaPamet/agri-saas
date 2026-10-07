/**
 * `runUnverifiedAccountSweep` — a destructive job, so these tests are mostly
 * about what it must NOT delete.
 *
 * The dangerous case is specific and was live when this was written: the
 * legacy `/api/auth/register` creates a tenant, an UNVERIFIED user, an OWNER
 * membership and an onboarding row in one transaction. So every farm
 * registered that way whose owner never clicked the link is an unverified
 * account older than the grace period WITH a real workspace. The obvious
 * predicate would have deleted the person and taken the farm's only owner with
 * them by cascade — and `tenant_membership_last_owner_guard` would not have
 * stopped it, because that trigger watches membership UPDATE/DELETE
 * statements, not a cascade from the user.
 *
 * So "a user with a membership is never swept" is the property, and it is
 * asserted twice: once on the selection and once on the DELETE itself, because
 * those are two different windows and only one of them is a race.
 */
const mockFindMany = jest.fn();
const mockDeleteMany = jest.fn();
const mockLogInfo = jest.fn();

jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        info: (...a: unknown[]) => mockLogInfo(...a),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import {
    runUnverifiedAccountSweep,
    UNVERIFIED_GRACE_DAYS,
} from '@/app-layer/jobs/unverified-account-sweep';

type Db = Parameters<typeof runUnverifiedAccountSweep>[0];

const db = {
    user: {
        findMany: (...a: unknown[]) => mockFindMany(...a),
        deleteMany: (...a: unknown[]) => mockDeleteMany(...a),
    },
} as unknown as Db;

const NOW = new Date('2026-10-06T12:00:00Z');

/** An account with no farm and no org — the only kind that may be deleted. */
const loose = (id: string) => ({
    id,
    _count: { tenantMemberships: 0, orgMemberships: 0 },
});

/** An account that holds a farm. Must survive, whatever else is true of it. */
const withFarm = (id: string) => ({
    id,
    _count: { tenantMemberships: 1, orgMemberships: 0 },
});

const withOrg = (id: string) => ({
    id,
    _count: { tenantMemberships: 0, orgMemberships: 1 },
});

beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteMany.mockResolvedValue({ count: 0 });
});

describe('it deletes abandoned signups', () => {
    it('deletes accounts with no farm', async () => {
        mockFindMany.mockResolvedValue([loose('u1'), loose('u2')]);
        mockDeleteMany.mockResolvedValue({ count: 2 });

        const r = await runUnverifiedAccountSweep(db, { now: NOW });

        expect(r).toEqual({ scanned: 2, deleted: 2, skippedWithMembership: 0 });
        expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    });

    it('selects on the 7-day cutoff', async () => {
        mockFindMany.mockResolvedValue([]);
        await runUnverifiedAccountSweep(db, { now: NOW });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(UNVERIFIED_GRACE_DAYS).toBe(7);
        expect(where.emailVerified).toBeNull();
        expect(where.createdAt.lt).toEqual(
            new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000),
        );
    });

    it('does nothing at all when there is nothing to sweep', async () => {
        mockFindMany.mockResolvedValue([]);
        const r = await runUnverifiedAccountSweep(db, { now: NOW });
        expect(r.deleted).toBe(0);
        // No empty `deleteMany`: a delete with an empty id list is harmless
        // today but is one typo away from matching everything.
        expect(mockDeleteMany).not.toHaveBeenCalled();
    });
});

describe('it never deletes an account that holds a farm', () => {
    it('spares a tenant member and reports it as backlog', async () => {
        mockFindMany.mockResolvedValue([withFarm('legacy1'), loose('u1')]);
        mockDeleteMany.mockResolvedValue({ count: 1 });

        const r = await runUnverifiedAccountSweep(db, { now: NOW });

        expect(r.skippedWithMembership).toBe(1);
        expect(r.deleted).toBe(1);
        // The id list must not contain the spared account.
        expect(mockDeleteMany.mock.calls[0][0].where.id.in).toEqual(['u1']);
    });

    it('spares an org member too', async () => {
        mockFindMany.mockResolvedValue([withOrg('org1')]);
        const r = await runUnverifiedAccountSweep(db, { now: NOW });
        expect(r.skippedWithMembership).toBe(1);
        expect(mockDeleteMany).not.toHaveBeenCalled();
    });

    it('issues NO delete at all when every candidate holds a farm', async () => {
        // The whole-batch version of the dangerous case: a run where the
        // legacy backlog is everything must be a no-op, not a delete with an
        // empty list.
        mockFindMany.mockResolvedValue([withFarm('a'), withFarm('b'), withOrg('c')]);
        const r = await runUnverifiedAccountSweep(db, { now: NOW });
        expect(r).toEqual({ scanned: 3, deleted: 0, skippedWithMembership: 3 });
        expect(mockDeleteMany).not.toHaveBeenCalled();
    });

    it('restates the membership predicate ON THE DELETE, not just the read', async () => {
        mockFindMany.mockResolvedValue([loose('u1')]);
        mockDeleteMany.mockResolvedValue({ count: 1 });

        await runUnverifiedAccountSweep(db, { now: NOW });

        // Between the read and the write a user can be invited to a farm.
        // Deleting on the strength of the earlier read would remove a member
        // of a live workspace, so the delete carries the condition itself.
        const where = mockDeleteMany.mock.calls[0][0].where;
        expect(where.emailVerified).toBeNull();
        expect(where.tenantMemberships).toEqual({ none: {} });
        expect(where.orgMemberships).toEqual({ none: {} });
    });

    it('a delete that removes fewer rows than selected is reported, not ignored', async () => {
        mockFindMany.mockResolvedValue([loose('u1'), loose('u2')]);
        mockDeleteMany.mockResolvedValue({ count: 1 }); // one was invited mid-run

        const r = await runUnverifiedAccountSweep(db, { now: NOW });

        expect(r.deleted).toBe(1);
        const events = mockLogInfo.mock.calls.map((c) => c[1]?.event);
        expect(events).toContain('unverified_sweep_race');
    });
});

describe('it is bounded and quiet', () => {
    it('caps the batch', async () => {
        mockFindMany.mockResolvedValue([]);
        await runUnverifiedAccountSweep(db, { now: NOW, batchSize: 7 });
        expect(mockFindMany.mock.calls[0][0].take).toBe(7);
    });

    it('takes the oldest first, so a backlog drains instead of starving', async () => {
        mockFindMany.mockResolvedValue([]);
        await runUnverifiedAccountSweep(db, { now: NOW });
        expect(mockFindMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'asc' });
    });

    it('logs counts and never an address or a name', async () => {
        mockFindMany.mockResolvedValue([loose('u1'), withFarm('legacy1')]);
        mockDeleteMany.mockResolvedValue({ count: 1 });

        await runUnverifiedAccountSweep(db, { now: NOW });

        const payloads = JSON.stringify(mockLogInfo.mock.calls);
        // The job exists BECAUSE these addresses are unconfirmed personal
        // data. Logging one would defeat the deletion it is reporting.
        expect(payloads).not.toMatch(/@/);
        expect(payloads).toMatch(/"deleted":1/);
        expect(payloads).toMatch(/"skippedWithMembership":1/);
    });

    it('does not select the email or the name at all', async () => {
        mockFindMany.mockResolvedValue([]);
        await runUnverifiedAccountSweep(db, { now: NOW });
        // Cannot leak what was never read. The selection is ids plus counts.
        const select = mockFindMany.mock.calls[0][0].select;
        expect(select.email).toBeUndefined();
        expect(select.name).toBeUndefined();
        expect(select.id).toBe(true);
    });
});
