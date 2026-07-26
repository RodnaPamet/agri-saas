/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/grain-blend.ts`.
 *
 * Covers:
 *   - blendQuality (pure) — quantity-weighted average + override precedence.
 *   - blendLots — validates each source lot (exists, same unit, sufficient
 *     on-hand), CONSUMES each via the ledger seam, RECEIPTS the output,
 *     emits one MERGE genealogy edge per source, audits LOTS_BLENDED.
 *   - rejects insufficient quantity + mixed units + duplicate source lot.
 */

const mockDb = {
    location: { findFirst: jest.fn() },
    inventoryLot: { findMany: jest.fn(), groupBy: jest.fn() },
    unit: { findFirst: jest.fn(), findMany: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => s),
}));

const appendStockTransaction: jest.Mock = jest.fn();
const appendLotLink: jest.Mock = jest.fn();
jest.mock('@/lib/inventory/stock-ledger', () => ({
    appendStockTransaction: (...a: any[]) => appendStockTransaction(...a),
    appendLotLink: (...a: any[]) => appendLotLink(...a),
}));

const createLot: jest.Mock = jest.fn();
const getItem: jest.Mock = jest.fn();
jest.mock('@/app-layer/repositories/InventoryRepository', () => ({
    InventoryRepository: {
        createLot: (...a: any[]) => createLot(...a),
        getItem: (...a: any[]) => getItem(...a),
    },
}));

import { logEvent } from '@/app-layer/events/audit';
import { blendLots, blendQuality } from '@/app-layer/usecases/grain-blend';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
    appendStockTransaction.mockResolvedValue({ id: 'tx', entryHash: 'h', previousHash: null, quantityOnHand: '0' });
    appendLotLink.mockResolvedValue({ created: true });
    getItem.mockResolvedValue({ id: 'item-out', name: 'Blended Wheat', defaultUnitId: 'unit-t' });
    createLot.mockResolvedValue({ id: 'out-lot', lotCode: 'BLEND-1', unitId: 'unit-t' });
    // Destination reads default to "no capacity configured" so the existing
    // cases are unaffected by the capacity guard.
    mockDb.unit.findFirst.mockResolvedValue({ key: 't' });
    mockDb.unit.findMany.mockResolvedValue([{ id: 'unit-t', key: 't' }]);
    mockDb.inventoryLot.groupBy.mockResolvedValue([]);
});

const adminCtx = makeRequestContext('ADMIN', { tenantSlug: 'acme', tenantId: 'tenant-1', userId: 'user-1' });
const readerCtx = makeRequestContext('READER', { tenantSlug: 'acme', tenantId: 'tenant-1' });

describe('blendQuality (pure)', () => {
    it('computes the quantity-weighted average across numeric quality keys', () => {
        const out = blendQuality([
            { quantity: 30, attributes: { moisture: 12, testWeight: 78 } },
            { quantity: 10, attributes: { moisture: 16, testWeight: 74 } },
        ]);
        // moisture: (12*30 + 16*10)/40 = 13 ; testWeight: (78*30 + 74*10)/40 = 77
        expect(out.moisture).toBe(13);
        expect(out.testWeight).toBe(77);
    });

    it('lets explicit overrides win', () => {
        const out = blendQuality(
            [{ quantity: 10, attributes: { moisture: 12 } }],
            { moisture: 9.5, protein: 11 },
        );
        expect(out.moisture).toBe(9.5);
        expect(out.protein).toBe(11);
    });

    it('coerces numeric strings + ignores non-numeric attributes', () => {
        const out = blendQuality([
            { quantity: 10, attributes: { moisture: '12', organic: 'yes' } },
            { quantity: 10, attributes: { moisture: '14' } },
        ]);
        expect(out.moisture).toBe(13);
        expect(out.organic).toBeUndefined();
    });
});

describe('blendLots — happy path', () => {
    beforeEach(() => {
        mockDb.inventoryLot.findMany.mockResolvedValue([
            { id: 'lot-1', unitId: 'unit-t', quantityOnHand: 30, attributesJson: { moisture: 12 }, lotCode: 'L1' },
            { id: 'lot-2', unitId: 'unit-t', quantityOnHand: 20, attributesJson: { moisture: 16 }, lotCode: 'L2' },
        ]);
    });

    it('consumes each source, receipts the output, emits MERGE links, audits', async () => {
        const res = await blendLots(adminCtx, {
            sourceLots: [
                { lotId: 'lot-1', quantity: 30 },
                { lotId: 'lot-2', quantity: 10 },
            ],
            outputItemId: 'item-out',
            outputLocationId: null,
        });

        // 2 CONSUMPTION (sources) + 1 RECEIPT (output) = 3 ledger appends.
        expect(appendStockTransaction).toHaveBeenCalledTimes(3);
        const types = appendStockTransaction.mock.calls.map((c: any[]) => c[2].type);
        expect(types.filter((t) => t === 'CONSUMPTION')).toHaveLength(2);
        expect(types.filter((t) => t === 'RECEIPT')).toHaveLength(1);
        // CONSUMPTION deltas are negative.
        const consumes = appendStockTransaction.mock.calls
            .map((c: any[]) => c[2])
            .filter((i: any) => i.type === 'CONSUMPTION');
        expect(consumes.every((i: any) => i.quantityDelta < 0)).toBe(true);
        // RECEIPT delta = total blended quantity (30 + 10).
        const receipt = appendStockTransaction.mock.calls
            .map((c: any[]) => c[2])
            .find((i: any) => i.type === 'RECEIPT');
        expect(receipt.quantityDelta).toBe(40);

        // One MERGE edge per source lot.
        expect(appendLotLink).toHaveBeenCalledTimes(2);
        expect(appendLotLink.mock.calls.every((c: any[]) => c[2].type === 'MERGE')).toBe(true);
        expect(appendLotLink.mock.calls.every((c: any[]) => c[2].childLotId === 'out-lot')).toBe(true);

        // Output lot created with weighted-avg quality: (12*30 + 16*10)/40 = 13.
        const lotData = createLot.mock.calls[0][2];
        expect(lotData.attributesJson.moisture).toBe(13);

        // Audit row.
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('LOTS_BLENDED');
        expect(payload.entityType).toBe('InventoryLot');
        expect(payload.entityId).toBe('out-lot');

        expect(res).toMatchObject({ outputLotId: 'out-lot', blendedQuantity: 40, sourceCount: 2, mergeLinks: 2 });
    });
});

describe('blendLots — validation', () => {
    it('rejects when a source lot has insufficient quantity (no ledger writes)', async () => {
        mockDb.inventoryLot.findMany.mockResolvedValue([
            { id: 'lot-1', unitId: 'unit-t', quantityOnHand: 5, attributesJson: null, lotCode: 'L1' },
        ]);
        await expect(
            blendLots(adminCtx, {
                sourceLots: [{ lotId: 'lot-1', quantity: 30 }],
                outputItemId: 'item-out',
            }),
        ).rejects.toThrow(/Insufficient quantity/i);
        expect(appendStockTransaction).not.toHaveBeenCalled();
        expect(appendLotLink).not.toHaveBeenCalled();
        expect(createLot).not.toHaveBeenCalled();
    });

    it('rejects a missing source lot', async () => {
        mockDb.inventoryLot.findMany.mockResolvedValue([]); // none found
        await expect(
            blendLots(adminCtx, {
                sourceLots: [{ lotId: 'ghost', quantity: 1 }],
                outputItemId: 'item-out',
            }),
        ).rejects.toThrow(/Source lot not found/i);
    });

    it('rejects mixed units', async () => {
        mockDb.inventoryLot.findMany.mockResolvedValue([
            { id: 'lot-1', unitId: 'unit-t', quantityOnHand: 30, attributesJson: null, lotCode: 'L1' },
            { id: 'lot-2', unitId: 'unit-kg', quantityOnHand: 30, attributesJson: null, lotCode: 'L2' },
        ]);
        await expect(
            blendLots(adminCtx, {
                sourceLots: [
                    { lotId: 'lot-1', quantity: 10 },
                    { lotId: 'lot-2', quantity: 10 },
                ],
                outputItemId: 'item-out',
            }),
        ).rejects.toThrow(/same unit/i);
    });

    it('rejects a duplicate source lot', async () => {
        await expect(
            blendLots(adminCtx, {
                sourceLots: [
                    { lotId: 'lot-1', quantity: 10 },
                    { lotId: 'lot-1', quantity: 5 },
                ],
                outputItemId: 'item-out',
            }),
        ).rejects.toThrow(/more than once/i);
    });

    it('rejects an unknown output item', async () => {
        getItem.mockResolvedValueOnce(null);
        await expect(
            blendLots(adminCtx, {
                sourceLots: [{ lotId: 'lot-1', quantity: 10 }],
                outputItemId: 'ghost',
            }),
        ).rejects.toThrow(/Output item not found/i);
    });

    it('READER cannot blend', async () => {
        await expect(
            blendLots(readerCtx, { sourceLots: [{ lotId: 'lot-1', quantity: 1 }], outputItemId: 'item-out' }),
        ).rejects.toThrow();
        expect(appendStockTransaction).not.toHaveBeenCalled();
    });
});

describe('blendLots — latent defects that became live once reachable', () => {
    const SOURCES = [
        { id: 'lot-1', unitId: 'unit-t', quantityOnHand: 10, attributesJson: null, lotCode: 'A' },
    ];

    it('consumes with disallowNegative so a concurrent blend cannot drive stock negative', async () => {
        // The sufficiency check reads quantityOnHand BEFORE the ledger takes
        // its per-tenant advisory lock, under READ COMMITTED — so two
        // concurrent blends of the same lot both pass it. The ledger's guard
        // re-reads the balance INSIDE the lock, which is the only place the
        // read and the insert are one atomic step.
        mockDb.inventoryLot.findMany.mockResolvedValue(SOURCES);

        await blendLots(adminCtx, {
            sourceLots: [{ lotId: 'lot-1', quantity: 4 }],
            outputItemId: 'item-out',
        });

        const consumption = appendStockTransaction.mock.calls
            .map((c) => c[2])
            .filter((a) => a.type === 'CONSUMPTION');
        expect(consumption).toHaveLength(1);
        expect(consumption[0].disallowNegative).toBe(true);
    });

    it('refuses to receipt blended grain into a FIELD', async () => {
        // Stock "stored" in a growing area is on-hand but invisible to every
        // bin view.
        mockDb.inventoryLot.findMany.mockResolvedValue(SOURCES);
        mockDb.location.findFirst.mockResolvedValue({
            id: 'field-1', name: 'North Field', kind: 'FIELD', capacityTonnes: null,
        });

        await expect(
            blendLots(adminCtx, {
                sourceLots: [{ lotId: 'lot-1', quantity: 4 }],
                outputItemId: 'item-out',
                outputLocationId: 'field-1',
            }),
        ).rejects.toThrow(/bin or storage location/i);
        // Rejected before any ledger write.
        expect(appendStockTransaction).not.toHaveBeenCalled();
    });

    it('refuses a blend that would overflow the destination capacity', async () => {
        mockDb.inventoryLot.findMany.mockResolvedValue(SOURCES);
        mockDb.location.findFirst.mockResolvedValue({
            id: 'bin-1', name: 'Bin A', kind: 'BIN', capacityTonnes: 5,
        });
        // Bin already holds 3 t; blending 4 t more would exceed 5 t.
        mockDb.inventoryLot.groupBy.mockResolvedValue([
            { unitId: 'unit-t', _sum: { quantityOnHand: 3 } },
        ]);

        await expect(
            blendLots(adminCtx, {
                sourceLots: [{ lotId: 'lot-1', quantity: 4 }],
                outputItemId: 'item-out',
                outputLocationId: 'bin-1',
            }),
        ).rejects.toThrow(/does not fit/i);
        expect(appendStockTransaction).not.toHaveBeenCalled();
    });

    it('allows a blend that fits', async () => {
        mockDb.inventoryLot.findMany.mockResolvedValue(SOURCES);
        mockDb.location.findFirst.mockResolvedValue({
            id: 'bin-1', name: 'Bin A', kind: 'BIN', capacityTonnes: 10,
        });
        mockDb.inventoryLot.groupBy.mockResolvedValue([
            { unitId: 'unit-t', _sum: { quantityOnHand: 3 } },
        ]);

        const res = await blendLots(adminCtx, {
            sourceLots: [{ lotId: 'lot-1', quantity: 4 }],
            outputItemId: 'item-out',
            outputLocationId: 'bin-1',
        });
        expect(res.outputLotId).toBe('out-lot');
    });
});
