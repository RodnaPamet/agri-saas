/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/grain-delivery.ts`.
 *
 * The delivery ledger is what turns `Contract.status = DELIVERED` from a
 * dropdown choice into a fact, so these tests care most about the
 * arithmetic being exact and the guards being real:
 *
 *   - `deriveFulfilment` — delivered / remaining / progress, including
 *     over-delivery and the no-contracted-volume case where a
 *     percentage is undefined rather than zero.
 *   - `aggregateDeliveredTonnes` — ONE groupBy, never a query per row.
 *   - `createGrainDelivery` — authz, positive-tonnes, the DRAFT /
 *     CANCELLED refusal, sanitisation, audit.
 *   - `listContractDeliveries` / `deleteGrainDelivery` — tenant scope,
 *     soft delete, audit.
 *
 * Decimal arithmetic is exercised with real `Prisma.Decimal` values, not
 * floats: `0.1 + 0.2` is the whole reason this module does not use
 * numbers.
 */

const mockDb = {
    grainDelivery: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        groupBy: jest.fn(),
    },
    contract: { findFirst: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => `SAN::${s}`),
}));

import { Prisma } from '@prisma/client';
import { logEvent } from '@/app-layer/events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    deriveFulfilment,
    aggregateDeliveredTonnes,
    listContractDeliveries,
    createGrainDelivery,
    deleteGrainDelivery,
} from '@/app-layer/usecases/grain-delivery';
import { makeRequestContext } from '../helpers/make-context';

const D = (v: string | number) => new Prisma.Decimal(v);

beforeEach(() => {
    jest.clearAllMocks();
    (sanitizePlainText as jest.Mock).mockImplementation((s: string) => `SAN::${s}`);
});

const adminCtx = makeRequestContext('ADMIN', {
    tenantSlug: 'acme',
    tenantId: 'tenant-1',
    userId: 'user-1',
});
const readerCtx = makeRequestContext('READER', {
    tenantSlug: 'acme',
    tenantId: 'tenant-1',
});

describe('deriveFulfilment', () => {
    it('computes delivered / remaining / progress against a contracted volume', () => {
        const f = deriveFulfilment('c-1', D('300'), 2, D('500'));
        expect(f).toEqual({
            contractId: 'c-1',
            deliveredTonnes: '300',
            deliveryCount: 2,
            remainingTonnes: '200',
            progressPct: 60,
            complete: false,
        });
    });

    it('is Decimal-exact — no float drift on thirds', () => {
        // 0.1 + 0.2 in float is 0.30000000000000004. The ledger sums
        // Decimals, so a tonnage like this stays exact.
        const f = deriveFulfilment('c-1', D('0.1').add(D('0.2')), 2, D('1'));
        expect(f.deliveredTonnes).toBe('0.3');
        expect(f.remainingTonnes).toBe('0.7');
    });

    it('marks complete at exactly the contracted volume', () => {
        const f = deriveFulfilment('c-1', D('500'), 1, D('500'));
        expect(f.complete).toBe(true);
        expect(f.remainingTonnes).toBe('0');
        expect(f.progressPct).toBe(100);
    });

    it('floors remaining at zero on over-delivery but keeps the real delivered figure', () => {
        // The weighbridge tickets say what they say — 520 t moved. But
        // "you still owe −20 t" is not a sentence for a dashboard.
        const f = deriveFulfilment('c-1', D('520'), 3, D('500'));
        expect(f.deliveredTonnes).toBe('520');
        expect(f.remainingTonnes).toBe('0');
        expect(f.progressPct).toBe(100); // clamped
        expect(f.complete).toBe(true);
    });

    it('reports NO percentage when there is no contracted volume', () => {
        // A percentage of zero is undefined, not 0% — rendering a 0% bar
        // would claim nothing was delivered when 40 t actually moved.
        const f = deriveFulfilment('c-1', D('40'), 1, null);
        expect(f.progressPct).toBeNull();
        expect(f.remainingTonnes).toBeNull();
        expect(f.deliveredTonnes).toBe('40');
        expect(f.complete).toBe(true); // something moved
    });

    it('treats a zero contracted volume as no denominator', () => {
        const f = deriveFulfilment('c-1', D('10'), 1, D('0'));
        expect(f.progressPct).toBeNull();
        expect(f.remainingTonnes).toBeNull();
    });

    it('reports an untouched contract as 0% and not complete', () => {
        const f = deriveFulfilment('c-1', D('0'), 0, D('500'));
        expect(f.progressPct).toBe(0);
        expect(f.remainingTonnes).toBe('500');
        expect(f.complete).toBe(false);
    });

    it('rounds progress to one decimal place', () => {
        const f = deriveFulfilment('c-1', D('1'), 1, D('3'));
        expect(f.progressPct).toBe(33.3);
    });
});

describe('aggregateDeliveredTonnes', () => {
    it('issues ONE groupBy for the whole page — never a query per contract', async () => {
        mockDb.grainDelivery.groupBy.mockResolvedValue([
            { contractId: 'c-1', _sum: { tonnes: D('300') }, _count: { _all: 2 } },
            { contractId: 'c-2', _sum: { tonnes: D('50') }, _count: { _all: 1 } },
        ]);

        const out = await aggregateDeliveredTonnes(mockDb, 'tenant-1', ['c-1', 'c-2', 'c-3']);

        expect(mockDb.grainDelivery.groupBy).toHaveBeenCalledTimes(1);
        const args = mockDb.grainDelivery.groupBy.mock.calls[0][0];
        expect(args.where).toMatchObject({
            tenantId: 'tenant-1',
            deletedAt: null,
            contractId: { in: ['c-1', 'c-2', 'c-3'] },
        });
        expect(out.get('c-1')!.tonnes.toFixed()).toBe('300');
        expect(out.get('c-1')!.count).toBe(2);
        // A contract with no deliveries is simply absent — the caller
        // defaults it to zero rather than the map inventing a row.
        expect(out.has('c-3')).toBe(false);
    });

    it('short-circuits on an empty id list without touching the DB', async () => {
        const out = await aggregateDeliveredTonnes(mockDb, 'tenant-1', []);
        expect(out.size).toBe(0);
        expect(mockDb.grainDelivery.groupBy).not.toHaveBeenCalled();
    });

    it('treats a null SUM as zero', async () => {
        mockDb.grainDelivery.groupBy.mockResolvedValue([
            { contractId: 'c-1', _sum: { tonnes: null }, _count: { _all: 0 } },
        ]);
        const out = await aggregateDeliveredTonnes(mockDb, 'tenant-1', ['c-1']);
        expect(out.get('c-1')!.tonnes.toFixed()).toBe('0');
    });
});

describe('createGrainDelivery', () => {
    const validInput = {
        contractId: 'c-1',
        deliveredAt: '2026-08-15T00:00:00.000Z',
        tonnes: 24.5,
        reference: 'WB-1234',
    };

    it('records a delivery against an ACTIVE contract + audits', async () => {
        mockDb.contract.findFirst.mockResolvedValue({
            id: 'c-1',
            status: 'ACTIVE',
            volumeTonnes: D('500'),
            counterparty: 'Acme Grain',
        });
        mockDb.grainDelivery.create.mockResolvedValue({ id: 'd-1' });

        await createGrainDelivery(adminCtx, validInput as any);

        const data = mockDb.grainDelivery.create.mock.calls[0][0].data;
        expect(data.tenantId).toBe('tenant-1');
        expect(data.contractId).toBe('c-1');
        expect(data.tonnes.toFixed()).toBe('24.5');
        expect(data.deliveredAt).toBeInstanceOf(Date);
        expect(data.reference).toBe('SAN::WB-1234');

        expect(sanitizePlainText).toHaveBeenCalledWith('WB-1234');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.entityType).toBe('GrainDelivery');
        expect(payload.detailsJson.operation).toBe('created');
    });

    it.each([
        ['DRAFT', /draft contract/i],
        ['CANCELLED', /cancelled contract/i],
    ])('refuses a delivery against a %s contract', async (status, message) => {
        mockDb.contract.findFirst.mockResolvedValue({
            id: 'c-1',
            status,
            volumeTonnes: D('500'),
            counterparty: 'Acme Grain',
        });
        await expect(createGrainDelivery(adminCtx, validInput as any)).rejects.toThrow(message);
        expect(mockDb.grainDelivery.create).not.toHaveBeenCalled();
    });

    it.each(['ACTIVE', 'DELIVERED', 'SETTLED'])(
        'accepts a corrective ticket against a %s contract',
        async (status) => {
            mockDb.contract.findFirst.mockResolvedValue({
                id: 'c-1',
                status,
                volumeTonnes: D('500'),
                counterparty: 'Acme Grain',
            });
            mockDb.grainDelivery.create.mockResolvedValue({ id: 'd-1' });
            await expect(
                createGrainDelivery(adminCtx, validInput as any),
            ).resolves.toBeTruthy();
        },
    );

    it.each([0, -5])('rejects a tonnage of %s', async (tonnes) => {
        await expect(
            createGrainDelivery(adminCtx, { ...validInput, tonnes } as any),
        ).rejects.toThrow(/greater than zero/i);
        expect(mockDb.grainDelivery.create).not.toHaveBeenCalled();
    });

    it('rejects a malformed delivery date', async () => {
        await expect(
            createGrainDelivery(adminCtx, { ...validInput, deliveredAt: 'not-a-date' } as any),
        ).rejects.toThrow(/valid date/i);
    });

    it('throws notFound for a contract in another tenant', async () => {
        // RLS + the tenantId filter mean a foreign id simply is not found.
        mockDb.contract.findFirst.mockResolvedValue(null);
        await expect(createGrainDelivery(adminCtx, validInput as any)).rejects.toThrow(
            /not found/i,
        );
        const where = mockDb.contract.findFirst.mock.calls[0][0].where;
        expect(where).toMatchObject({ tenantId: 'tenant-1', deletedAt: null });
    });

    it('normalises a blank reference to null', async () => {
        mockDb.contract.findFirst.mockResolvedValue({
            id: 'c-1',
            status: 'ACTIVE',
            volumeTonnes: D('500'),
            counterparty: 'Acme',
        });
        mockDb.grainDelivery.create.mockResolvedValue({ id: 'd-1' });
        (sanitizePlainText as jest.Mock).mockImplementationOnce(() => '   ');
        await createGrainDelivery(adminCtx, { ...validInput, reference: '   ' } as any);
        expect(mockDb.grainDelivery.create.mock.calls[0][0].data.reference).toBeNull();
    });

    it('READER cannot record a delivery', async () => {
        await expect(createGrainDelivery(readerCtx, validInput as any)).rejects.toThrow();
        expect(mockDb.grainDelivery.create).not.toHaveBeenCalled();
    });
});

describe('listContractDeliveries', () => {
    it('returns the tenant-scoped ledger plus the fulfilment position', async () => {
        mockDb.contract.findFirst.mockResolvedValue({
            id: 'c-1',
            status: 'ACTIVE',
            volumeTonnes: D('500'),
            counterparty: 'Acme',
        });
        mockDb.grainDelivery.findMany.mockResolvedValue([
            { id: 'd-1', tonnes: D('200') },
            { id: 'd-2', tonnes: D('100.5') },
        ]);

        const out = await listContractDeliveries(adminCtx, 'c-1');

        const args = mockDb.grainDelivery.findMany.mock.calls[0][0];
        expect(args.where).toMatchObject({
            tenantId: 'tenant-1',
            contractId: 'c-1',
            deletedAt: null,
        });
        expect(args.take).toBe(500);
        expect(out.rows).toHaveLength(2);
        expect(out.fulfilment.deliveredTonnes).toBe('300.5');
        expect(out.fulfilment.remainingTonnes).toBe('199.5');
        expect(out.fulfilment.deliveryCount).toBe(2);
    });

    it('throws notFound when the contract is missing', async () => {
        mockDb.contract.findFirst.mockResolvedValue(null);
        await expect(listContractDeliveries(adminCtx, 'nope')).rejects.toThrow(/not found/i);
    });

    it('READER can read the ledger', async () => {
        mockDb.contract.findFirst.mockResolvedValue({
            id: 'c-1',
            status: 'ACTIVE',
            volumeTonnes: null,
            counterparty: 'Acme',
        });
        mockDb.grainDelivery.findMany.mockResolvedValue([]);
        await expect(listContractDeliveries(readerCtx, 'c-1')).resolves.toBeTruthy();
    });
});

describe('deleteGrainDelivery', () => {
    it('soft-deletes + audits', async () => {
        mockDb.grainDelivery.findFirst.mockResolvedValue({
            id: 'd-1',
            contractId: 'c-1',
            tonnes: D('24.5'),
        });
        mockDb.grainDelivery.update.mockResolvedValue({ id: 'd-1' });

        const res = await deleteGrainDelivery(adminCtx, 'd-1');

        expect(res).toEqual({ id: 'd-1', deleted: true });
        const data = mockDb.grainDelivery.update.mock.calls[0][0].data;
        expect(data.deletedAt).toBeInstanceOf(Date);
        expect(data.deletedByUserId).toBe('user-1');
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.detailsJson.operation).toBe('deleted');
    });

    it('throws notFound when missing', async () => {
        mockDb.grainDelivery.findFirst.mockResolvedValue(null);
        await expect(deleteGrainDelivery(adminCtx, 'nope')).rejects.toThrow(/not found/i);
    });

    it('READER cannot delete', async () => {
        await expect(deleteGrainDelivery(readerCtx, 'd-1')).rejects.toThrow();
        expect(mockDb.grainDelivery.update).not.toHaveBeenCalled();
    });
});
