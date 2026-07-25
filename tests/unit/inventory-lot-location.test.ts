/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `updateLotLocation` (`src/app-layer/usecases/inventory.ts`).
 *
 * This is the write path that was missing entirely: `InventoryLot.locationId`
 * is what ties stock to a grain bin, and before this nothing but the demo
 * seeder ever set it, so bins could only ever read as empty.
 *
 * The load-bearing property is what it must NOT do. The inventory module is
 * single-writer — `quantityOnHand` is a denormalised ledger sum refreshed only
 * by the ledger writer — so a position change must write `locationId` and
 * nothing else, and must not append ledger rows. These tests drive the real
 * repositories against a mock `db` precisely so the UPDATE payload is
 * observable.
 */
const mockDb = {
    inventoryLot: { findFirst: jest.fn(), updateMany: jest.fn() },
    location: { findFirst: jest.fn() },
    stockTransaction: { create: jest.fn(), findFirst: jest.fn(), aggregate: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
    withTenantDb: jest.fn(async (_t: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import { logEvent } from '@/app-layer/events/audit';
import { updateLotLocation } from '@/app-layer/usecases/inventory';
import { makeRequestContext } from '../helpers/make-context';

const adminCtx = makeRequestContext('ADMIN', {
    tenantSlug: 'acme',
    tenantId: 'tenant-1',
    userId: 'user-1',
});
const readerCtx = makeRequestContext('READER', { tenantSlug: 'acme', tenantId: 'tenant-1' });

const LOT = { id: 'lot-1', lotCode: 'WHEAT-A1', locationId: null, quantityOnHand: 180 };
const BIN = { id: 'bin-1', name: 'Bin A', kind: 'BIN' };
const FIELD = { id: 'field-1', name: 'North Field', kind: 'FIELD' };

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.inventoryLot.updateMany.mockResolvedValue({ count: 1 });
});

describe('updateLotLocation', () => {
    it('assigns a lot to a bin and audits the move', async () => {
        mockDb.inventoryLot.findFirst.mockResolvedValue(LOT);
        mockDb.location.findFirst.mockResolvedValue(BIN);

        const res = await updateLotLocation(adminCtx, 'lot-1', 'bin-1');

        expect(res).toEqual({ id: 'lot-1', locationId: 'bin-1', moved: true });

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.entityType).toBe('InventoryLot');
        expect(payload.detailsJson.changedFields).toEqual(['locationId']);
        expect(payload.detailsJson.before).toEqual({ locationId: null });
        expect(payload.detailsJson.after).toEqual({ locationId: 'bin-1' });
    });

    it('writes locationId and NOTHING else (single-writer invariant)', async () => {
        mockDb.inventoryLot.findFirst.mockResolvedValue(LOT);
        mockDb.location.findFirst.mockResolvedValue(BIN);

        await updateLotLocation(adminCtx, 'lot-1', 'bin-1');

        const args = mockDb.inventoryLot.updateMany.mock.calls[0][0];
        // The exact payload matters: quantityOnHand is a ledger sum, and a
        // position change that touched it would silently corrupt stock.
        expect(Object.keys(args.data)).toEqual(['locationId']);
        expect(args.data).toEqual({ locationId: 'bin-1' });
        // Tenant-scoped + soft-delete-aware.
        expect(args.where).toMatchObject({ id: 'lot-1', tenantId: 'tenant-1', deletedAt: null });
        // No ledger activity — this is not a stock movement.
        expect(mockDb.stockTransaction.create).not.toHaveBeenCalled();
    });

    it('unassigns a lot when locationId is null', async () => {
        mockDb.inventoryLot.findFirst.mockResolvedValue({ ...LOT, locationId: 'bin-1' });

        const res = await updateLotLocation(adminCtx, 'lot-1', null);

        expect(res).toEqual({ id: 'lot-1', locationId: null, moved: true });
        expect(mockDb.inventoryLot.updateMany.mock.calls[0][0].data).toEqual({ locationId: null });
        // No location lookup is needed to unassign.
        expect(mockDb.location.findFirst).not.toHaveBeenCalled();
    });

    it('refuses a FIELD target — produce there would be invisible stock', async () => {
        mockDb.inventoryLot.findFirst.mockResolvedValue(LOT);
        mockDb.location.findFirst.mockResolvedValue(FIELD);

        await expect(updateLotLocation(adminCtx, 'lot-1', 'field-1')).rejects.toThrow(
            /bin or storage location/i,
        );
        expect(mockDb.inventoryLot.updateMany).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('rejects a location from another tenant (repository scoping returns null)', async () => {
        mockDb.inventoryLot.findFirst.mockResolvedValue(LOT);
        mockDb.location.findFirst.mockResolvedValue(null);

        await expect(updateLotLocation(adminCtx, 'lot-1', 'other-tenant-bin')).rejects.toThrow(
            /not found/i,
        );
        expect(mockDb.inventoryLot.updateMany).not.toHaveBeenCalled();
    });

    it('throws notFound for a missing lot', async () => {
        mockDb.inventoryLot.findFirst.mockResolvedValue(null);
        await expect(updateLotLocation(adminCtx, 'ghost', 'bin-1')).rejects.toThrow(/not found/i);
        expect(mockDb.inventoryLot.updateMany).not.toHaveBeenCalled();
    });

    it('treats a same-location PATCH as a no-op without auditing a move', async () => {
        // An edit form resubmitting an unchanged value must not manufacture
        // audit noise claiming the lot moved.
        mockDb.inventoryLot.findFirst.mockResolvedValue({ ...LOT, locationId: 'bin-1' });
        mockDb.location.findFirst.mockResolvedValue(BIN);

        const res = await updateLotLocation(adminCtx, 'lot-1', 'bin-1');

        expect(res).toEqual({ id: 'lot-1', locationId: 'bin-1', moved: false });
        expect(mockDb.inventoryLot.updateMany).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('READER cannot move a lot', async () => {
        await expect(updateLotLocation(readerCtx, 'lot-1', 'bin-1')).rejects.toThrow();
        expect(mockDb.inventoryLot.findFirst).not.toHaveBeenCalled();
        expect(mockDb.inventoryLot.updateMany).not.toHaveBeenCalled();
    });
});
