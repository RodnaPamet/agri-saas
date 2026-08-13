/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Zero-coverage jobs, wave 4: `soil-fetch`, `sharepoint-delta-sync`,
 * `sharepoint-policy-jobs`.
 *
 * Three job modules with no test importing them. They look like thin
 * delegators, but each one privately builds the `RequestContext` its work
 * runs under — and that context is the **authorization boundary for
 * background work**. A request handler gets its context from an
 * authenticated session; a job has no session, so it reconstructs one from
 * a membership row. Every rule about who a job is allowed to act as lives
 * in these ~30-line private helpers, and nothing was checking them:
 *
 *   - refuse outright when the initiator is not an ACTIVE member
 *   - resolve a custom role's `baseRole` + `permissionsJson`, not the raw
 *     membership role
 *   - re-check the specific permission before doing the work
 *
 * The two fan-out jobs additionally carry a batch contract worth pinning:
 * one admin lookup for the whole batch (not per connection), one Graph
 * client per tenant (not per policy), and per-item error isolation so a
 * single bad row cannot abort the sweep.
 */

const mockPrisma = {
    tenantMembership: { findFirst: jest.fn(), findMany: jest.fn() },
    policy: { findFirst: jest.fn(), findMany: jest.fn() },
    integrationConnection: { findMany: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockPrisma }));

const mockFetchAndStoreParcelSoil = jest.fn();
jest.mock('@/app-layer/usecases/soil', () => ({
    fetchAndStoreParcelSoil: (...a: unknown[]) => mockFetchAndStoreParcelSoil(...a),
}));

const mockRunSharePointDeltaSync = jest.fn();
jest.mock('@/app-layer/integrations/providers/sharepoint/import', () => ({
    runSharePointDeltaSync: (...a: unknown[]) => mockRunSharePointDeltaSync(...a),
}));

const mockPullPolicyFromSharePoint = jest.fn();
const mockGetSharePointClientForTenant = jest.fn();
jest.mock('@/app-layer/usecases/policy-sharepoint-sync', () => ({
    pullPolicyFromSharePoint: (...a: unknown[]) => mockPullPolicyFromSharePoint(...a),
    getSharePointClientForTenant: (...a: unknown[]) => mockGetSharePointClientForTenant(...a),
}));

const mockEnqueue = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: (...a: unknown[]) => mockEnqueue(...a) }));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logger } from '@/lib/observability/logger';
import { runSoilFetch } from '@/app-layer/jobs/soil-fetch';
import {
    runSharePointDeltaSyncJob,
    runSharePointDeltaSyncDispatch,
} from '@/app-layer/jobs/sharepoint-delta-sync';

beforeEach(() => {
    jest.clearAllMocks();
    mockFetchAndStoreParcelSoil.mockResolvedValue({ status: 'populated' });
});

// ─── soil-fetch ──────────────────────────────────────────────────────

describe('runSoilFetch', () => {
    const payload = {
        tenantId: 'tenant-1',
        initiatedByUserId: 'user-1',
        parcelIds: ['p1', 'p2', 'p3'],
    } as any;

    it('runs each parcel under a context built from the active membership', async () => {
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({
            userId: 'user-1',
            role: 'ADMIN',
            customRole: null,
        });

        const res = await runSoilFetch(payload);

        expect(res).toEqual({ scanned: 3, populated: 3, skipped: 0 });
        expect(mockFetchAndStoreParcelSoil).toHaveBeenCalledTimes(3);

        const [ctx, parcelId] = mockFetchAndStoreParcelSoil.mock.calls[0];
        expect(parcelId).toBe('p1');
        expect(ctx).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1', role: 'ADMIN' });
        // Only ACTIVE memberships count — a removed or invited member must
        // not be resurrectable as a job actor.
        expect(mockPrisma.tenantMembership.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: 'user-1', tenantId: 'tenant-1', status: 'ACTIVE' },
            }),
        );
    });

    it('refuses to run when the initiator is not an active member', async () => {
        // The whole point of the helper. Without this the job would run with
        // a fabricated context against another tenant's parcels.
        mockPrisma.tenantMembership.findFirst.mockResolvedValue(null);

        await expect(runSoilFetch(payload)).rejects.toThrow(/not an active member/);
        expect(mockFetchAndStoreParcelSoil).not.toHaveBeenCalled();
    });

    it('resolves a custom role through its baseRole and permissionsJson', async () => {
        // A custom role's effective authority is its baseRole plus overrides;
        // using the raw `membership.role` would silently over- or
        // under-privilege the job.
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({
            userId: 'user-1',
            role: 'READER',
            customRole: {
                baseRole: 'EDITOR',
                permissionsJson: { evidence: { upload: true } },
            },
        });

        await runSoilFetch({ ...payload, parcelIds: ['p1'] });

        const [ctx] = mockFetchAndStoreParcelSoil.mock.calls[0];
        expect(ctx.role).toBe('EDITOR');
        expect(ctx.appPermissions.evidence.upload).toBe(true);
    });

    it('counts skipped parcels separately from populated ones', async () => {
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({ role: 'ADMIN', customRole: null });
        mockFetchAndStoreParcelSoil
            .mockResolvedValueOnce({ status: 'populated' })
            .mockResolvedValueOnce({ status: 'skipped' }) // no geometry
            .mockResolvedValueOnce({ status: 'cached' });

        expect(await runSoilFetch(payload)).toEqual({ scanned: 3, populated: 2, skipped: 1 });
        expect(logger.info).toHaveBeenCalledWith(
            'soil-fetch batch complete',
            expect.objectContaining({ scanned: 3, populated: 2, skipped: 1 }),
        );
    });

    it('handles an empty batch without calling the provider', async () => {
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({ role: 'ADMIN', customRole: null });

        expect(await runSoilFetch({ ...payload, parcelIds: [] })).toEqual({
            scanned: 0,
            populated: 0,
            skipped: 0,
        });
        expect(mockFetchAndStoreParcelSoil).not.toHaveBeenCalled();
    });

    it('defaults parcelIds to an empty batch when omitted', async () => {
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({ role: 'ADMIN', customRole: null });

        expect(await runSoilFetch({ tenantId: 'tenant-1', initiatedByUserId: 'user-1' } as any)).toEqual({
            scanned: 0,
            populated: 0,
            skipped: 0,
        });
    });

    it('carries the caller’s requestId into the job context when supplied', async () => {
        // Trace continuity: an import that enqueues soil work should keep the
        // originating request id so the two are correlatable in logs.
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({ role: 'ADMIN', customRole: null });

        await runSoilFetch({ ...payload, parcelIds: ['p1'], requestId: 'req-abc' } as any);
        expect(mockFetchAndStoreParcelSoil.mock.calls[0][0].requestId).toBe('req-abc');

        mockFetchAndStoreParcelSoil.mockClear();
        await runSoilFetch({ ...payload, parcelIds: ['p1'] });
        expect(mockFetchAndStoreParcelSoil.mock.calls[0][0].requestId).toBe('soil-fetch-tenant-1');
    });

    it('is sequential and lets a provider error propagate for retry', async () => {
        // Sequential is deliberate: SoilGrids is rate-limited, and one
        // parcel's failure should retry that job rather than race the rest.
        // A rejection on p1 must therefore mean p2 was never attempted.
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({ role: 'ADMIN', customRole: null });
        mockFetchAndStoreParcelSoil.mockRejectedValueOnce(new Error('SoilGrids 503'));

        await expect(runSoilFetch(payload)).rejects.toThrow('SoilGrids 503');
        expect(mockFetchAndStoreParcelSoil).toHaveBeenCalledTimes(1);
    });
});

// ─── sharepoint-delta-sync ───────────────────────────────────────────

describe('runSharePointDeltaSyncJob', () => {
    const payload = { tenantId: 't1', connectionId: 'conn-1', actorUserId: 'u1' } as any;

    it('delegates to the importer under the actor’s context', async () => {
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({ role: 'ADMIN' });
        mockRunSharePointDeltaSync.mockResolvedValue({ imported: 4 });

        expect(await runSharePointDeltaSyncJob(payload)).toEqual({ imported: 4 });

        const [ctx, connectionId] = mockRunSharePointDeltaSync.mock.calls[0];
        expect(connectionId).toBe('conn-1');
        expect(ctx).toMatchObject({ tenantId: 't1', userId: 'u1', role: 'ADMIN' });
    });

    it('throws when the actor is not an active member', async () => {
        mockPrisma.tenantMembership.findFirst.mockResolvedValue(null);

        await expect(runSharePointDeltaSyncJob(payload)).rejects.toThrow(/not an active member/);
        expect(mockRunSharePointDeltaSync).not.toHaveBeenCalled();
    });

    it('refuses an actor who cannot upload evidence', async () => {
        // Membership alone is not enough — a re-import writes evidence, so
        // the specific permission is re-checked inside the job.
        mockPrisma.tenantMembership.findFirst.mockResolvedValue({ role: 'READER' });

        await expect(runSharePointDeltaSyncJob(payload)).rejects.toThrow(/lacks evidence\.upload/);
        expect(mockRunSharePointDeltaSync).not.toHaveBeenCalled();
    });
});

describe('runSharePointDeltaSyncDispatch', () => {
    it('enqueues one sync per enabled connection using the oldest tenant admin', async () => {
        mockPrisma.integrationConnection.findMany.mockResolvedValue([
            { id: 'c1', tenantId: 't1' },
            { id: 'c2', tenantId: 't1' },
            { id: 'c3', tenantId: 't2' },
        ]);
        mockPrisma.tenantMembership.findMany.mockResolvedValue([
            { tenantId: 't1', userId: 'admin-1' },
            { tenantId: 't1', userId: 'admin-1-newer' },
            { tenantId: 't2', userId: 'admin-2' },
        ]);

        expect(await runSharePointDeltaSyncDispatch({} as any)).toEqual({
            connections: 3,
            dispatched: 3,
        });

        expect(mockEnqueue).toHaveBeenCalledTimes(3);
        expect(mockEnqueue).toHaveBeenCalledWith('sharepoint-delta-sync', {
            tenantId: 't1',
            connectionId: 'c1',
            // First row wins — the query orders by createdAt ASC, so the
            // longest-standing admin is the stable actor choice.
            actorUserId: 'admin-1',
            triggeredBy: 'scheduled',
        });
        expect(mockEnqueue).toHaveBeenCalledWith(
            'sharepoint-delta-sync',
            expect.objectContaining({ tenantId: 't2', actorUserId: 'admin-2' }),
        );
    });

    it('looks admins up in ONE query for the whole batch', async () => {
        // The N+1 contract, and the reason the map exists at all: a
        // per-connection lookup would be one query per connection.
        mockPrisma.integrationConnection.findMany.mockResolvedValue(
            Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, tenantId: `t${i % 4}` })),
        );
        mockPrisma.tenantMembership.findMany.mockResolvedValue(
            Array.from({ length: 4 }, (_, i) => ({ tenantId: `t${i}`, userId: `a${i}` })),
        );

        await runSharePointDeltaSyncDispatch({} as any);

        expect(mockPrisma.tenantMembership.findMany).toHaveBeenCalledTimes(1);
        expect(mockPrisma.tenantMembership.findMany.mock.calls[0][0].where.tenantId.in).toEqual([
            't0',
            't1',
            't2',
            't3',
        ]);
        expect(mockEnqueue).toHaveBeenCalledTimes(20);
    });

    it('skips a connection whose tenant has no eligible admin, and logs it', async () => {
        // Skipping silently would make a tenant's SharePoint sync quietly
        // stop after its last admin was deactivated.
        mockPrisma.integrationConnection.findMany.mockResolvedValue([
            { id: 'c1', tenantId: 't1' },
            { id: 'c2', tenantId: 'orphan' },
        ]);
        mockPrisma.tenantMembership.findMany.mockResolvedValue([{ tenantId: 't1', userId: 'a1' }]);

        expect(await runSharePointDeltaSyncDispatch({} as any)).toEqual({
            connections: 2,
            dispatched: 1,
        });
        expect(logger.warn).toHaveBeenCalledWith(
            'sharepoint-delta-sync-dispatch: no eligible admin',
            expect.objectContaining({ tenantId: 'orphan', connectionId: 'c2' }),
        );
    });

    it('is a no-op when no connections are enabled', async () => {
        mockPrisma.integrationConnection.findMany.mockResolvedValue([]);
        mockPrisma.tenantMembership.findMany.mockResolvedValue([]);

        expect(await runSharePointDeltaSyncDispatch({} as any)).toEqual({
            connections: 0,
            dispatched: 0,
        });
        expect(mockEnqueue).not.toHaveBeenCalled();
    });
});

// (sharepoint-policy-jobs was deleted in GRC teardown phase 2 — the
//  POLICY half of the SharePoint integration. Evidence delta-sync stays.)
