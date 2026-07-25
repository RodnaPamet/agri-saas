/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/jobs/contract-delivery-window-sweep.ts`.
 *
 * The sweep is the half of the delivery-window signal a farmer sees when
 * they are NOT looking at the app. What it must get right:
 *
 *   - scope: ACTIVE contracts only (a cancelled deal has nobody waiting
 *     on it; a delivered one is done);
 *   - dedupe: one alert per (contract, recipient, deliveryEnd, phase),
 *     so a lapsed window nags twice, not every morning for a month;
 *   - silence when there is nothing to chase: a fully-delivered contract
 *     still flagged ACTIVE is a status-hygiene problem, not a late
 *     delivery, and this alert must not impersonate one;
 *   - the outstanding tonnage in the message, because "your window
 *     closes in 3 days" is far less useful than "300 t still to go".
 */

const mockPrisma = {
    contract: { findMany: jest.fn() },
    grainDelivery: { groupBy: jest.fn() },
    tenantMembership: { findMany: jest.fn() },
    notification: { findMany: jest.fn(), createMany: jest.fn() },
} as any;

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: () => any) => fn()),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const publishNotificationEvent = jest.fn();
jest.mock('@/lib/notifications/notification-bus', () => ({
    publishNotificationEvent: (...a: unknown[]) => publishNotificationEvent(...a),
}));

import { Prisma } from '@prisma/client';
import { runContractDeliveryWindowSweep } from '@/app-layer/jobs/contract-delivery-window-sweep';

const D = (v: string) => new Prisma.Decimal(v);
const NOW = new Date('2026-08-01T07:30:00Z');

function contract(over: Record<string, unknown> = {}) {
    return {
        id: 'c-1',
        tenantId: 'tenant-1',
        counterparty: 'Acme Grain',
        commodity: 'Wheat',
        volumeTonnes: D('500'),
        deliveryEnd: new Date('2026-08-10T00:00:00Z'),
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.contract.findMany.mockResolvedValue([]);
    mockPrisma.grainDelivery.groupBy.mockResolvedValue([]);
    mockPrisma.tenantMembership.findMany.mockResolvedValue([
        { tenantId: 'tenant-1', userId: 'owner-1', tenant: { slug: 'acme' } },
    ]);
    mockPrisma.notification.findMany.mockResolvedValue([]);
    mockPrisma.notification.createMany.mockResolvedValue({ count: 1 });
});

describe('runContractDeliveryWindowSweep', () => {
    it('scans ACTIVE contracts only, over a bounded deliveryEnd range', async () => {
        await runContractDeliveryWindowSweep({ now: NOW });

        const where = mockPrisma.contract.findMany.mock.calls[0][0].where;
        expect(where.status).toBe('ACTIVE');
        expect(where.deletedAt).toBeNull();
        expect(where.deliveryEnd.lte).toBeInstanceOf(Date);
        expect(where.deliveryEnd.gte).toBeInstanceOf(Date);
        expect(mockPrisma.contract.findMany.mock.calls[0][0].take).toBe(10000);
    });

    it('notifies OWNER/ADMIN about an approaching window, naming the outstanding tonnage', async () => {
        mockPrisma.contract.findMany.mockResolvedValue([contract()]);
        mockPrisma.grainDelivery.groupBy.mockResolvedValue([
            { contractId: 'c-1', _sum: { tonnes: D('200') } },
        ]);

        const res = await runContractDeliveryWindowSweep({ now: NOW });

        expect(res.flagged).toBe(1);
        expect(res.notified).toBe(1);
        const rows = mockPrisma.notification.createMany.mock.calls[0][0].data;
        expect(rows).toHaveLength(1);
        expect(rows[0].type).toBe('CONTRACT_DELIVERY_DUE');
        expect(rows[0].userId).toBe('owner-1');
        // 500 contracted − 200 delivered = 300 outstanding.
        expect(rows[0].message).toContain('300');
        expect(rows[0].message).toContain('Wheat');
        expect(rows[0].linkUrl).toBe('/t/acme/grain/contracts');
        expect(rows[0].dedupeKey).toContain(':closing');
        expect(publishNotificationEvent).toHaveBeenCalledTimes(1);
    });

    it('uses the overdue phase (and wording) once the window has lapsed', async () => {
        mockPrisma.contract.findMany.mockResolvedValue([
            contract({ deliveryEnd: new Date('2026-07-25T00:00:00Z') }),
        ]);

        await runContractDeliveryWindowSweep({ now: NOW });

        const row = mockPrisma.notification.createMany.mock.calls[0][0].data[0];
        expect(row.dedupeKey).toContain(':overdue');
        expect(row.title).toMatch(/Просрочен/);
        // 7 days late.
        expect(row.message).toContain('7');
    });

    it('stays silent for a fully-delivered contract still flagged ACTIVE', async () => {
        // The grain moved; the status is just stale. Chasing it here
        // would train operators to ignore the alert.
        mockPrisma.contract.findMany.mockResolvedValue([contract()]);
        mockPrisma.grainDelivery.groupBy.mockResolvedValue([
            { contractId: 'c-1', _sum: { tonnes: D('500') } },
        ]);

        const res = await runContractDeliveryWindowSweep({ now: NOW });

        expect(res.notified).toBe(0);
        expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
    });

    it('still alerts on an over-delivered-but-not-quite contract', async () => {
        mockPrisma.contract.findMany.mockResolvedValue([contract()]);
        mockPrisma.grainDelivery.groupBy.mockResolvedValue([
            { contractId: 'c-1', _sum: { tonnes: D('499.9') } },
        ]);
        const res = await runContractDeliveryWindowSweep({ now: NOW });
        expect(res.notified).toBe(1);
    });

    it('alerts on a contract with no contracted volume, without an outstanding figure', async () => {
        mockPrisma.contract.findMany.mockResolvedValue([
            contract({ volumeTonnes: null }),
        ]);
        const res = await runContractDeliveryWindowSweep({ now: NOW });
        expect(res.notified).toBe(1);
        const row = mockPrisma.notification.createMany.mock.calls[0][0].data[0];
        expect(row.message).not.toMatch(/Остават/);
    });

    it('dedupes an alert already sent for this contract + phase', async () => {
        mockPrisma.contract.findMany.mockResolvedValue([contract()]);
        // Echo back whatever key the sweep computed.
        mockPrisma.notification.findMany.mockImplementation(async ({ where }: any) => [
            { dedupeKey: where.dedupeKey.in[0] },
        ]);

        const res = await runContractDeliveryWindowSweep({ now: NOW });

        expect(res.notified).toBe(0);
        expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
    });

    it('buckets the dedupe key on deliveryEnd, so a renegotiated window alerts again', async () => {
        mockPrisma.contract.findMany.mockResolvedValue([contract()]);
        await runContractDeliveryWindowSweep({ now: NOW });
        const first = mockPrisma.notification.createMany.mock.calls[0][0].data[0].dedupeKey;

        jest.clearAllMocks();
        mockPrisma.tenantMembership.findMany.mockResolvedValue([
            { tenantId: 'tenant-1', userId: 'owner-1', tenant: { slug: 'acme' } },
        ]);
        mockPrisma.notification.findMany.mockResolvedValue([]);
        mockPrisma.notification.createMany.mockResolvedValue({ count: 1 });
        mockPrisma.grainDelivery.groupBy.mockResolvedValue([]);
        mockPrisma.contract.findMany.mockResolvedValue([
            contract({ deliveryEnd: new Date('2026-08-12T00:00:00Z') }),
        ]);
        await runContractDeliveryWindowSweep({ now: NOW });
        const second = mockPrisma.notification.createMany.mock.calls[0][0].data[0].dedupeKey;

        expect(second).not.toBe(first);
    });

    it('fans out to every OWNER/ADMIN in the tenant', async () => {
        mockPrisma.contract.findMany.mockResolvedValue([contract()]);
        mockPrisma.tenantMembership.findMany.mockResolvedValue([
            { tenantId: 'tenant-1', userId: 'owner-1', tenant: { slug: 'acme' } },
            { tenantId: 'tenant-1', userId: 'admin-2', tenant: { slug: 'acme' } },
        ]);
        mockPrisma.notification.createMany.mockResolvedValue({ count: 2 });

        await runContractDeliveryWindowSweep({ now: NOW });

        const rows = mockPrisma.notification.createMany.mock.calls[0][0].data;
        expect(rows.map((r: any) => r.userId).sort()).toEqual(['admin-2', 'owner-1']);
        // Distinct dedupe keys per recipient.
        expect(new Set(rows.map((r: any) => r.dedupeKey)).size).toBe(2);
        const memberWhere = mockPrisma.tenantMembership.findMany.mock.calls[0][0].where;
        expect(memberWhere.status).toBe('ACTIVE');
        expect(memberWhere.role).toEqual({ in: ['OWNER', 'ADMIN'] });
    });

    it('produces nothing when a tenant has no OWNER/ADMIN to tell', async () => {
        mockPrisma.contract.findMany.mockResolvedValue([contract()]);
        mockPrisma.tenantMembership.findMany.mockResolvedValue([]);
        const res = await runContractDeliveryWindowSweep({ now: NOW });
        expect(res.notified).toBe(0);
    });

    it('scopes to one tenant when asked', async () => {
        await runContractDeliveryWindowSweep({ now: NOW, tenantId: 'tenant-9' });
        expect(mockPrisma.contract.findMany.mock.calls[0][0].where.tenantId).toBe('tenant-9');
    });

    it('honours a custom withinDays window', async () => {
        await runContractDeliveryWindowSweep({ now: NOW, withinDays: 60 });
        const lte = mockPrisma.contract.findMany.mock.calls[0][0].where.deliveryEnd.lte;
        const days = Math.round((lte.getTime() - NOW.getTime()) / 86_400_000);
        expect(days).toBe(60);
    });

    it('reads delivered tonnage in ONE groupBy for the whole batch', async () => {
        mockPrisma.contract.findMany.mockResolvedValue([
            contract({ id: 'c-1' }),
            contract({ id: 'c-2' }),
            contract({ id: 'c-3' }),
        ]);
        mockPrisma.notification.createMany.mockResolvedValue({ count: 3 });

        await runContractDeliveryWindowSweep({ now: NOW });

        expect(mockPrisma.grainDelivery.groupBy).toHaveBeenCalledTimes(1);
        expect(
            mockPrisma.grainDelivery.groupBy.mock.calls[0][0].where.contractId.in,
        ).toEqual(['c-1', 'c-2', 'c-3']);
    });

    it('returns a well-formed JobRunResult', async () => {
        mockPrisma.contract.findMany.mockResolvedValue([contract()]);
        const { result } = await runContractDeliveryWindowSweep({ now: NOW });
        expect(result.jobName).toBe('contract-delivery-window-sweep');
        expect(result.success).toBe(true);
        expect(result.itemsScanned).toBe(1);
        expect(result.itemsActioned).toBe(1);
    });

    it('does nothing at all when no contract is in the window', async () => {
        const res = await runContractDeliveryWindowSweep({ now: NOW });
        expect(res.flagged).toBe(0);
        expect(res.notified).toBe(0);
        expect(mockPrisma.tenantMembership.findMany).not.toHaveBeenCalled();
        expect(mockPrisma.grainDelivery.groupBy).not.toHaveBeenCalled();
    });
});
