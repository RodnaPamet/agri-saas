/**
 * sample-data usecase — the tenant-context DB is mocked so we assert the
 * tagging + tenant-scoping + idempotency, not Prisma. Mirrors the
 * achievements.test.ts mocking shape (runInTenantContext passes our mock
 * db straight through; logEvent / prisma are stubbed).
 */
import type { RequestContext } from '@/app-layer/types';

const db = {
    location: { findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    parcel: { createMany: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
    inventoryLot: { create: jest.fn(), updateMany: jest.fn() },
    logEntry: { createMany: jest.fn(), updateMany: jest.fn() },
    item: { findFirst: jest.fn(), create: jest.fn() },
    unit: { findFirst: jest.fn() },
    // The grain chain. Without it the calculator reports nothing, which is
    // the one screen where "no data" and "broken" are indistinguishable.
    cropType: { create: jest.fn(), updateMany: jest.fn() },
    season: { create: jest.fn(), updateMany: jest.fn() },
    cropPlan: { create: jest.fn(), updateMany: jest.fn() },
    planting: { create: jest.fn(), updateMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, cb: (d: unknown) => unknown) => cb(db),
}));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
const logEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...args: unknown[]) => logEvent(...args) }));

import {
    hasSampleData,
    loadSampleData,
    clearSampleData,
    SAMPLE_LOT_TONNES,
    SAMPLE_COMMODITY_NAME,
    SAMPLE_COMMODITY_SLUG,
} from '@/app-layer/usecases/sample-data';
import { normalizeCommodity } from '@/lib/market/commodity-vocabulary';
import { canConvert } from '@/lib/units/unit-conversion';

const ctx = {
    tenantId: 't1',
    userId: 'u1',
    requestId: 'r1',
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
} as unknown as RequestContext;

beforeEach(() => {
    for (const model of Object.values(db)) {
        for (const fn of Object.values(model)) (fn as jest.Mock).mockReset();
    }
    logEvent.mockReset();
});

describe('hasSampleData', () => {
    it('true when a non-deleted sample Location exists', async () => {
        db.location.findFirst.mockResolvedValue({ id: 'loc1' });
        await expect(hasSampleData(ctx)).resolves.toBe(true);
        expect(db.location.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: 't1', isSampleData: true, deletedAt: null },
            }),
        );
    });

    it('false when none exists', async () => {
        db.location.findFirst.mockResolvedValue(null);
        await expect(hasSampleData(ctx)).resolves.toBe(false);
    });
});

describe('loadSampleData', () => {
    it('no-ops when sample data already exists', async () => {
        db.location.findFirst.mockResolvedValue({ id: 'loc1' });
        await expect(loadSampleData(ctx)).resolves.toEqual({ created: false });
        expect(db.location.create).not.toHaveBeenCalled();
        expect(db.parcel.createMany).not.toHaveBeenCalled();
    });

    it('creates a tagged, tenant-scoped dataset when empty', async () => {
        db.location.findFirst.mockResolvedValue(null); // both the pre-check and the in-context re-check
        db.location.create.mockResolvedValue({ id: 'loc-new' });
        db.parcel.createMany.mockResolvedValue({ count: 3 });
        db.unit.findFirst.mockResolvedValue({ id: 'unit-kg', key: 'kg' });
        db.item.findFirst.mockResolvedValue(null);
        db.item.create.mockResolvedValue({ id: 'item-1' });
        db.inventoryLot.create.mockResolvedValue({ id: 'lot-1' });
        db.logEntry.createMany.mockResolvedValue({ count: 2 });
        // The grain chain — each create's id feeds the next link, so an
        // unmocked one throws on `.id` rather than returning a bad value.
        db.cropType.create.mockResolvedValue({ id: 'crop-1' });
        db.season.create.mockResolvedValue({ id: 'season-1' });
        db.cropPlan.create.mockResolvedValue({ id: 'plan-1' });
        db.parcel.findFirst.mockResolvedValue({ id: 'parcel-1' });
        db.planting.create.mockResolvedValue({ id: 'planting-1' });

        await expect(loadSampleData(ctx)).resolves.toEqual({ created: true });

        // Location tagged + tenant-scoped.
        expect(db.location.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ tenantId: 't1', isSampleData: true }),
            }),
        );
        // Every parcel tagged + tenant-scoped + linked to the new location.
        const parcelArg = db.parcel.createMany.mock.calls[0][0];
        expect(parcelArg.data.length).toBeGreaterThanOrEqual(2);
        for (const p of parcelArg.data) {
            expect(p).toMatchObject({ tenantId: 't1', locationId: 'loc-new', isSampleData: true });
        }
        // Lot tagged + tenant-scoped, and actually HOLDING something — a
        // zero-quantity lot is read by the calculator and contributes
        // nothing, which is indistinguishable from no sample data.
        expect(db.inventoryLot.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    tenantId: 't1',
                    isSampleData: true,
                    quantityOnHand: SAMPLE_LOT_TONNES * 1_000, // kg unit
                }),
            }),
        );
        // The item it hangs off must be harvested produce named for the
        // crop — the calculator filters on the category and derives the
        // commodity from the NAME.
        expect(db.item.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    category: 'HARVESTED_PRODUCE',
                    name: SAMPLE_COMMODITY_NAME,
                }),
            }),
        );
        // LogEntries tagged + tenant-scoped.
        const logArg = db.logEntry.createMany.mock.calls[0][0];
        for (const e of logArg.data) {
            expect(e).toMatchObject({ tenantId: 't1', isSampleData: true });
        }
        // Audited.
        expect(logEvent).toHaveBeenCalledWith(
            db,
            ctx,
            expect.objectContaining({ action: 'SAMPLE_DATA_LOADED' }),
        );
    });

    it('builds the grain chain, tagged and linked, so the calculator has rows', async () => {
        db.location.findFirst.mockResolvedValue(null);
        db.location.create.mockResolvedValue({ id: 'loc-new' });
        db.parcel.createMany.mockResolvedValue({ count: 3 });
        db.unit.findFirst.mockResolvedValue(null);
        db.logEntry.createMany.mockResolvedValue({ count: 2 });
        db.cropType.create.mockResolvedValue({ id: 'crop-1' });
        db.season.create.mockResolvedValue({ id: 'season-1' });
        db.cropPlan.create.mockResolvedValue({ id: 'plan-1' });
        db.parcel.findFirst.mockResolvedValue({ id: 'parcel-1' });
        db.planting.create.mockResolvedValue({ id: 'planting-1' });

        await expect(loadSampleData(ctx)).resolves.toEqual({ created: true });

        // Every link tagged and tenant-scoped. An UNTAGGED row here is the
        // failure that matters: clearSampleData finds rows by the flag, so an
        // untagged season is sample data the farmer cannot delete, sitting in
        // the tables where "is this real?" is hardest to answer.
        for (const create of [db.cropType.create, db.season.create, db.cropPlan.create, db.planting.create]) {
            expect(create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ tenantId: 't1', isSampleData: true }),
                }),
            );
        }

        // The chain is LINKED — each id feeds the next. A chain that creates
        // four rows pointing nowhere reports nothing, and looks identical to
        // one that works until you open the calculator.
        expect(db.cropPlan.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ seasonId: 'season-1', cropTypeId: 'crop-1' }),
            }),
        );
        expect(db.planting.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ cropPlanId: 'plan-1', parcelId: 'parcel-1' }),
            }),
        );
    });

    it('prices against a commodity the GLOBAL market series actually carries', async () => {
        db.location.findFirst.mockResolvedValue(null);
        db.location.create.mockResolvedValue({ id: 'loc-new' });
        db.parcel.createMany.mockResolvedValue({ count: 3 });
        db.unit.findFirst.mockResolvedValue(null);
        db.logEntry.createMany.mockResolvedValue({ count: 2 });
        db.cropType.create.mockResolvedValue({ id: 'crop-1' });
        db.season.create.mockResolvedValue({ id: 'season-1' });
        db.cropPlan.create.mockResolvedValue({ id: 'plan-1' });
        db.parcel.findFirst.mockResolvedValue(null);
        db.planting.create.mockResolvedValue({ id: 'planting-1' });

        await loadSampleData(ctx);

        // `commodityCanonical` is what the net-worth usecase prices against
        // the global series. A slug those series do not carry produces a row
        // that REFUSES for want of a price — the calculator still looks
        // broken, just for a different reason. These four are the slugs with
        // price history in production.
        const arg = db.cropType.create.mock.calls[0][0] as { data: { commodityCanonical: string } };
        expect(['wheat', 'barley', 'maize', 'sunflower']).toContain(arg.data.commodityCanonical);

        // A planting with no area or no yield estimate is excluded from the
        // calculator entirely — it would create the chain and still report
        // nothing.
        const planting = db.planting.create.mock.calls[0][0] as {
            data: { areaM2: number; plannedYieldKgPerHa: number };
        };
        expect(planting.data.areaM2).toBeGreaterThan(0);
        expect(planting.data.plannedYieldKgPerHa).toBeGreaterThan(0);
    });

    it('skips the lot when no unit catalog exists (still creates the rest)', async () => {
        db.location.findFirst.mockResolvedValue(null);
        db.location.create.mockResolvedValue({ id: 'loc-new' });
        db.parcel.createMany.mockResolvedValue({ count: 3 });
        db.unit.findFirst.mockResolvedValue(null);
        db.logEntry.createMany.mockResolvedValue({ count: 2 });
        // The grain chain — each create's id feeds the next link, so an
        // unmocked one throws on `.id` rather than returning a bad value.
        db.cropType.create.mockResolvedValue({ id: 'crop-1' });
        db.season.create.mockResolvedValue({ id: 'season-1' });
        db.cropPlan.create.mockResolvedValue({ id: 'plan-1' });
        db.parcel.findFirst.mockResolvedValue({ id: 'parcel-1' });
        db.planting.create.mockResolvedValue({ id: 'planting-1' });

        await expect(loadSampleData(ctx)).resolves.toEqual({ created: true });
        expect(db.inventoryLot.create).not.toHaveBeenCalled();
        expect(db.item.create).not.toHaveBeenCalled();
    });
});

describe('clearSampleData', () => {
    it('soft-deletes ONLY isSampleData rows across all eight models, tenant-scoped', async () => {
        db.logEntry.updateMany.mockResolvedValue({ count: 2 });
        db.inventoryLot.updateMany.mockResolvedValue({ count: 1 });
        db.parcel.updateMany.mockResolvedValue({ count: 3 });
        db.location.updateMany.mockResolvedValue({ count: 1 });
        db.planting.updateMany.mockResolvedValue({ count: 1 });
        db.cropPlan.updateMany.mockResolvedValue({ count: 1 });
        db.season.updateMany.mockResolvedValue({ count: 1 });
        db.cropType.updateMany.mockResolvedValue({ count: 1 });

        // 7 as before, plus one of each grain-chain row.
        await expect(clearSampleData(ctx)).resolves.toEqual({ cleared: 11 });

        const expectedWhere = { tenantId: 't1', isSampleData: true, deletedAt: null };
        for (const model of [db.logEntry, db.inventoryLot, db.parcel, db.location,
                             db.planting, db.cropPlan, db.season, db.cropType]) {
            expect(model.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expectedWhere,
                    data: expect.objectContaining({ deletedAt: expect.any(Date), deletedByUserId: 'u1' }),
                }),
            );
        }
        expect(logEvent).toHaveBeenCalledWith(
            db,
            ctx,
            expect.objectContaining({ action: 'SAMPLE_DATA_CLEARED' }),
        );
    });

    it('idempotent — clears nothing and skips the audit when there is no sample data', async () => {
        for (const model of [db.logEntry, db.inventoryLot, db.parcel, db.location,
                             db.planting, db.cropPlan, db.season, db.cropType]) {
            model.updateMany.mockResolvedValue({ count: 0 });
        }
        await expect(clearSampleData(ctx)).resolves.toEqual({ cleared: 0 });
        expect(logEvent).not.toHaveBeenCalled();
    });
});

describe('sample lot — the three silent conditions the calculator imposes', () => {
    // `grain-net-worth` excludes a lot that fails any of these, and an
    // excluded lot looks exactly like no sample data at all. Each is pinned
    // here so a rename or a catalog change cannot quietly empty the
    // calculator's "grain on hand" arm.

    it('the item name resolves to the SAME commodity the CropType declares', () => {
        // The lot goes through normalizeCommodity(item.name); the CropType
        // carries commodityCanonical explicitly. If these diverge, the
        // standing crop and the grain on hand land in two different rows
        // and the farm appears to grow one crop and store another.
        expect(normalizeCommodity(SAMPLE_COMMODITY_NAME)).toBe(SAMPLE_COMMODITY_SLUG);
    });

    it('both candidate lot units convert to tonnes', () => {
        // A unit that cannot reach tonnes is dropped as lotsUnresolvedUnit.
        expect(canConvert('kg', 't')).toBe(true);
        expect(canConvert('t', 't')).toBe(true);
    });

    it('a tonne-keyed unit stores TONNES, not the kilogram figure', async () => {
        // The trap: quantityOnHand is denominated in the lot's own unit, so
        // writing the kg magnitude against a tonne unit stores 18 000 t and
        // reads back as a merely large number.
        db.location.findFirst.mockResolvedValue(null);
        db.location.create.mockResolvedValue({ id: 'loc-new' });
        db.parcel.createMany.mockResolvedValue({ count: 3 });
        db.unit.findFirst.mockResolvedValue({ id: 'unit-t', key: 't' });
        db.item.findFirst.mockResolvedValue(null);
        db.item.create.mockResolvedValue({ id: 'item-1' });
        db.inventoryLot.create.mockResolvedValue({ id: 'lot-1' });
        db.logEntry.createMany.mockResolvedValue({ count: 2 });
        db.cropType.create.mockResolvedValue({ id: 'crop-1' });
        db.season.create.mockResolvedValue({ id: 'season-1' });
        db.cropPlan.create.mockResolvedValue({ id: 'plan-1' });
        db.parcel.findFirst.mockResolvedValue({ id: 'parcel-1' });
        db.planting.create.mockResolvedValue({ id: 'planting-1' });

        await loadSampleData(ctx);

        expect(db.inventoryLot.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ quantityOnHand: SAMPLE_LOT_TONNES }),
            }),
        );
    });
});
