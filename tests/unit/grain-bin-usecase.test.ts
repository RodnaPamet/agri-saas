/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/grain-bin.ts`.
 *
 * Covers:
 *   - listBins — read gate, BIN/STORAGE-only filter, ONE batched grouped
 *     aggregate (no N+1, no row cap), per-unit conversion to tonnes, and the
 *     honest mixed-units state when stock has no tonnage.
 *   - createBin / updateBin — sanitises name/description/key, audits as a
 *     Location, non-negative capacity guard.
 */

const mockDb = {
    location: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    inventoryLot: { groupBy: jest.fn() },
    unit: { findMany: jest.fn() },
} as any;

/** Global `Unit` rows the grouped sums resolve against. */
const TONNE = { id: 'unit-t', key: 't', symbol: 't' };
const KILO = { id: 'unit-kg', key: 'kg', symbol: 'kg' };
const EACH = { id: 'unit-each', key: 'each', symbol: 'ea' };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => `SAN::${s}`),
}));

import { logEvent } from '@/app-layer/events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { listBins, createBin, updateBin } from '@/app-layer/usecases/grain-bin';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const adminCtx = makeRequestContext('ADMIN', { tenantSlug: 'acme', tenantId: 'tenant-1', userId: 'user-1' });
const readerCtx = makeRequestContext('READER', { tenantSlug: 'acme', tenantId: 'tenant-1' });

describe('listBins', () => {
    it('filters to BIN/STORAGE kinds and computes fill in ONE grouped query (no N+1)', async () => {
        mockDb.location.findMany.mockResolvedValue([
            { id: 'bin-1', name: 'Bin A', key: null, kind: 'BIN', description: null, capacityTonnes: 100 },
            { id: 'bin-2', name: 'Bin B', key: null, kind: 'STORAGE', description: null, capacityTonnes: null },
        ]);
        // ONE groupBy returns (bin, unit) sums across BOTH bins.
        mockDb.inventoryLot.groupBy.mockResolvedValue([
            { locationId: 'bin-1', unitId: TONNE.id, _sum: { quantityOnHand: 45 }, _count: { _all: 2 } },
            { locationId: 'bin-2', unitId: TONNE.id, _sum: { quantityOnHand: 8 }, _count: { _all: 1 } },
        ]);
        mockDb.unit.findMany.mockResolvedValue([TONNE]);

        const bins = await listBins(adminCtx);

        // Bin filter applied.
        const locArgs = mockDb.location.findMany.mock.calls[0][0];
        expect(locArgs.where.kind).toEqual({ in: ['BIN', 'STORAGE'] });
        expect(locArgs.where).toMatchObject({ tenantId: 'tenant-1', deletedAt: null });

        // Exactly ONE aggregate for the whole list (the N+1 guard), grouped by
        // unit so each quantity can be converted before summing.
        expect(mockDb.inventoryLot.groupBy).toHaveBeenCalledTimes(1);
        const lotArgs = mockDb.inventoryLot.groupBy.mock.calls[0][0];
        expect(lotArgs.by).toEqual(['locationId', 'unitId']);
        expect(lotArgs.where.locationId).toEqual({ in: ['bin-1', 'bin-2'] });
        expect(lotArgs.where.item).toEqual({ is: { category: 'HARVESTED_PRODUCE' } });
        // No row cap: a `take` here is what silently truncated bins farm-wide.
        expect(lotArgs.take).toBeUndefined();

        // Bin A: 45 t / capacity 100 ⇒ fill 0.45 ; 2 lots.
        expect(bins[0]).toMatchObject({
            id: 'bin-1', storedTonnes: 45, capacityTonnes: 100, fillPct: 0.45,
            lotCount: 2, mixedUnits: false, unconvertible: [],
        });
        // Bin B: no capacity ⇒ fillPct null ; stored 8 t.
        expect(bins[1]).toMatchObject({
            id: 'bin-2', storedTonnes: 8, capacityTonnes: null, fillPct: null, lotCount: 1,
        });
    });

    it('converts a kg lot in a tonne bin instead of reporting 1000x the fill', async () => {
        // The shipped demo data: 320 kg in a 500 t bin. The old code summed raw
        // quantities and rendered 64% for a bin 0.064% full.
        mockDb.location.findMany.mockResolvedValue([
            { id: 'bin-kg', name: 'Bin A', key: null, kind: 'BIN', description: null, capacityTonnes: 500 },
        ]);
        mockDb.inventoryLot.groupBy.mockResolvedValue([
            { locationId: 'bin-kg', unitId: KILO.id, _sum: { quantityOnHand: 320 }, _count: { _all: 2 } },
        ]);
        mockDb.unit.findMany.mockResolvedValue([KILO]);

        const [bin] = await listBins(adminCtx);

        expect(bin.storedTonnes).toBe(0.32);
        expect(bin.fillPct).toBe(0.0006); // 0.32 / 500, 4dp — NOT 0.64
        expect(bin.mixedUnits).toBe(false); // kg IS convertible; nothing is hidden
        expect(bin.lotCount).toBe(2);
    });

    it('sums mixed WEIGHT units into one correct tonnage', async () => {
        mockDb.location.findMany.mockResolvedValue([
            { id: 'bin-1', name: 'Bin A', key: null, kind: 'BIN', description: null, capacityTonnes: 10 },
        ]);
        mockDb.inventoryLot.groupBy.mockResolvedValue([
            { locationId: 'bin-1', unitId: TONNE.id, _sum: { quantityOnHand: 2 }, _count: { _all: 1 } },
            { locationId: 'bin-1', unitId: KILO.id, _sum: { quantityOnHand: 500 }, _count: { _all: 3 } },
        ]);
        mockDb.unit.findMany.mockResolvedValue([TONNE, KILO]);

        const [bin] = await listBins(adminCtx);

        expect(bin.storedTonnes).toBe(2.5); // 2 t + 500 kg
        expect(bin.fillPct).toBe(0.25);
        expect(bin.lotCount).toBe(4);
        expect(bin.mixedUnits).toBe(false);
    });

    it('suppresses fillPct and reports the stock when a unit has no tonnage', async () => {
        mockDb.location.findMany.mockResolvedValue([
            { id: 'bin-1', name: 'Bin A', key: null, kind: 'BIN', description: null, capacityTonnes: 100 },
        ]);
        mockDb.inventoryLot.groupBy.mockResolvedValue([
            { locationId: 'bin-1', unitId: TONNE.id, _sum: { quantityOnHand: 40 }, _count: { _all: 1 } },
            { locationId: 'bin-1', unitId: EACH.id, _sum: { quantityOnHand: 12 }, _count: { _all: 1 } },
        ]);
        mockDb.unit.findMany.mockResolvedValue([TONNE, EACH]);

        const [bin] = await listBins(adminCtx);

        // The convertible part is still reported honestly...
        expect(bin.storedTonnes).toBe(40);
        expect(bin.lotCount).toBe(2);
        // ...but a percentage would be a partial truth, so there isn't one.
        expect(bin.mixedUnits).toBe(true);
        expect(bin.fillPct).toBeNull();
        expect(bin.unconvertible).toEqual([
            { unitKey: 'each', symbol: 'ea', quantity: 12, lotCount: 1 },
        ]);
    });

    it('short-circuits with no lot query when there are no bins', async () => {
        mockDb.location.findMany.mockResolvedValue([]);
        const bins = await listBins(adminCtx);
        expect(bins).toEqual([]);
        expect(mockDb.inventoryLot.groupBy).not.toHaveBeenCalled();
    });
});

describe('createBin', () => {
    it('sanitises name/description/key, defaults kind BIN, audits as Location', async () => {
        mockDb.location.create.mockResolvedValue({ id: 'bin-1', name: 'SAN::Bin A', kind: 'BIN', capacityTonnes: 100 });
        await createBin(adminCtx, { name: 'Bin A', description: 'main store', key: 'BIN-A', capacityTonnes: 100 });
        expect(sanitizePlainText).toHaveBeenCalledWith('Bin A');
        expect(sanitizePlainText).toHaveBeenCalledWith('main store');
        expect(sanitizePlainText).toHaveBeenCalledWith('BIN-A');
        const data = mockDb.location.create.mock.calls[0][0].data;
        expect(data).toMatchObject({ tenantId: 'tenant-1', name: 'SAN::Bin A', kind: 'BIN', capacityTonnes: 100 });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.entityType).toBe('Location');
        expect(payload.detailsJson.summary).toMatch(/grain/i);
    });

    it('rejects a negative capacity', async () => {
        await expect(createBin(adminCtx, { name: 'Bin A', capacityTonnes: -1 })).rejects.toThrow(/zero or positive/i);
    });

    it('READER cannot create', async () => {
        await expect(createBin(readerCtx, { name: 'Bin A' })).rejects.toThrow();
        expect(mockDb.location.create).not.toHaveBeenCalled();
    });
});

describe('updateBin', () => {
    it('throws notFound when the bin is missing (or is a FIELD)', async () => {
        mockDb.location.findFirst.mockResolvedValue(null);
        await expect(updateBin(adminCtx, 'missing', { name: 'X' })).rejects.toThrow(/not found/i);
    });

    it('updates + audits', async () => {
        mockDb.location.findFirst.mockResolvedValue({ id: 'bin-1' });
        mockDb.location.update.mockResolvedValue({ id: 'bin-1', name: 'SAN::Bin A2', kind: 'BIN', capacityTonnes: 120 });
        await updateBin(adminCtx, 'bin-1', { name: 'Bin A2', capacityTonnes: 120 });
        expect(sanitizePlainText).toHaveBeenCalledWith('Bin A2');
        expect(logEvent).toHaveBeenCalledTimes(1);
    });
});
