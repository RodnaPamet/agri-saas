/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Dependent-stock guard on `deleteLocation` / `bulkDeleteLocation`
 * (`src/app-layer/usecases/location.ts`).
 *
 * `InventoryLot.locationId` has no FK cascade and lots are not deleted with
 * their location, so soft-deleting an occupied row leaves every lot pointing at
 * a deleted Location: stock stays on hand and keeps counting in inventory, but
 * disappears from every bin view.
 *
 * Both delete paths hit the SAME table as `grain-bin.ts::deleteBin`, which
 * already refuses. A guard on only one path is arguably worse than none — the
 * protected path teaches you to trust a protection the other lacks.
 */
const mockDb = {
    inventoryLot: { groupBy: jest.fn() },
    location: { findMany: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

const softDelete: jest.Mock = jest.fn();
jest.mock('@/app-layer/repositories/LocationRepository', () => ({
    LocationRepository: {
        softDelete: (...a: any[]) => softDelete(...a),
    },
}));

import { logEvent } from '@/app-layer/events/audit';
import { deleteLocation, bulkDeleteLocation } from '@/app-layer/usecases/location';
import { makeRequestContext } from '../helpers/make-context';

const adminCtx = makeRequestContext('ADMIN', {
    tenantSlug: 'acme',
    tenantId: 'tenant-1',
    userId: 'user-1',
});

beforeEach(() => {
    jest.clearAllMocks();
    softDelete.mockResolvedValue(true);
    mockDb.inventoryLot.groupBy.mockResolvedValue([]);
    mockDb.location.findMany.mockResolvedValue([]);
});

describe('deleteLocation — dependent stock', () => {
    it('refuses when the location still holds lots, and names it', async () => {
        mockDb.inventoryLot.groupBy.mockResolvedValue([
            { locationId: 'bin-1', _count: { _all: 3 } },
        ]);
        mockDb.location.findMany.mockResolvedValue([{ id: 'bin-1', name: 'Bin A' }]);

        await expect(deleteLocation(adminCtx, 'bin-1')).rejects.toThrow(/Bin A \(3 lot/);
        expect(softDelete).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('deletes an empty location', async () => {
        const res = await deleteLocation(adminCtx, 'field-1');
        expect(res).toEqual({ success: true });
        expect(softDelete).toHaveBeenCalled();
    });

    it('counts stock of ANY category and ignores soft-deleted lots', async () => {
        await deleteLocation(adminCtx, 'field-1');
        const where = mockDb.inventoryLot.groupBy.mock.calls[0][0].where;
        expect(where).toMatchObject({ tenantId: 'tenant-1', deletedAt: null });
        expect(where.item).toBeUndefined();
    });
});

describe('bulkDeleteLocation — dependent stock', () => {
    it('refuses the WHOLE batch when any location holds stock', async () => {
        // One transaction: a partial delete followed by a throw would roll back
        // anyway, and "deleted 3 of 5, silently" is worse than a clear no.
        mockDb.inventoryLot.groupBy.mockResolvedValue([
            { locationId: 'bin-2', _count: { _all: 1 } },
        ]);
        mockDb.location.findMany.mockResolvedValue([{ id: 'bin-2', name: 'Store 2' }]);

        await expect(
            bulkDeleteLocation(adminCtx, ['field-1', 'bin-2', 'field-3']),
        ).rejects.toThrow(/still holds stock/i);
        expect(softDelete).not.toHaveBeenCalled();
    });

    it('deletes a batch where nothing holds stock', async () => {
        const res = await bulkDeleteLocation(adminCtx, ['field-1', 'field-2']);
        expect(res).toEqual({ deleted: 2 });
        expect(softDelete).toHaveBeenCalledTimes(2);
    });

    it('no-ops on an empty id list without querying', async () => {
        const res = await bulkDeleteLocation(adminCtx, []);
        expect(res).toEqual({ deleted: 0 });
        expect(mockDb.inventoryLot.groupBy).not.toHaveBeenCalled();
    });
});
