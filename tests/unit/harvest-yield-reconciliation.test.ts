/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `recordYieldFromHarvest` — the harvest-reconciliation seam.
 *
 * A harvest used to be recordable in three places that never reconciled: the
 * journal minted stock with no production figure, /grain/yield recorded a
 * tonnage with no stock, and the crop plan read neither. This function is the
 * chosen fix (one entry, two effects, journal → yield), so what matters here
 * is that it is exact where it acts and silent-free where it declines:
 *
 *   - the tonnage is a real unit conversion, not a reinterpretation. kg → t
 *     divides by 1000; a non-mass unit is REFUSED rather than assumed, which
 *     is the difference between a production total and a fabricated one.
 *   - it never writes stock. The inventory ledger keeps its single writer;
 *     this function only ever inserts a YieldRecord.
 *   - it is idempotent per journal entry, because an offline journal create
 *     can be replayed and production must not double-count.
 *   - it is GRAIN-module gated, since production is a grain concept.
 *
 * The function is transaction-bound (it takes `db`), so these tests hand it a
 * fake tx directly — no runInTenantContext mocking needed, which is also the
 * point of that signature.
 */

const mockDb = {
    yieldRecord: {
        findFirst: jest.fn(),
        create: jest.fn(),
    },
    item: { findFirst: jest.fn() },
    planting: { findFirst: jest.fn() },
    parcel: { findFirst: jest.fn() },
} as any;

const mockLogEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: any[]) => mockLogEvent(...a) }));

const mockModuleGet = jest.fn();
jest.mock('@/app-layer/repositories/ModuleSettingsRepository', () => ({
    ModuleSettingsRepository: { get: (...a: any[]) => mockModuleGet(...a) },
}));

jest.mock('@/lib/observability', () => ({
    traceAgUsecase: jest.fn(async (_n: string, _c: any, fn: () => any) => fn()),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@/app-layer/automation', () => ({ emitAutomationEvent: jest.fn() }));

import { recordYieldFromHarvest } from '@/app-layer/usecases/yield-record';
import { makeRequestContext } from '../helpers/make-context';

// Defaults already give tenantId 'tenant-1' / userId 'user-1'.
const ctx = makeRequestContext('ADMIN');

/** GRAIN on unless a test says otherwise. */
function grainEnabled(on = true) {
    mockModuleGet.mockResolvedValue(on ? { enabledModules: ['GRAIN', 'JOURNAL', 'INVENTORY'] } : { enabledModules: ['JOURNAL'] });
}

function itemWithUnit(key: string | null, name = 'Winter Wheat') {
    mockDb.item.findFirst.mockResolvedValue(
        key === null ? { name, defaultUnit: null } : { name, defaultUnit: { key } },
    );
}

const baseInput = {
    logEntryId: 'entry-1',
    itemId: 'item-1',
    quantity: 1000,
    occurredAt: new Date('2026-07-20T08:00:00.000Z'),
};

beforeEach(() => {
    jest.clearAllMocks();
    grainEnabled();
    mockDb.yieldRecord.findFirst.mockResolvedValue(null);
    mockDb.yieldRecord.create.mockResolvedValue({ id: 'yield-1' });
    mockDb.planting.findFirst.mockResolvedValue(null);
    mockDb.parcel.findFirst.mockResolvedValue(null);
    itemWithUnit('kg');
});

describe('recordYieldFromHarvest — tonnage derivation', () => {
    it('converts the harvest quantity into tonnes exactly (1000 kg → 1 t)', async () => {
        const result = await recordYieldFromHarvest(mockDb, ctx, baseInput);

        expect(result.note).toBeUndefined();
        expect(result.grossTonnes).toBe(1);
        expect(mockDb.yieldRecord.create).toHaveBeenCalledTimes(1);
        expect(mockDb.yieldRecord.create.mock.calls[0][0].data).toMatchObject({
            tenantId: 'tenant-1',
            logEntryId: 'entry-1',
            grossTonnes: 1,
            commodity: 'Winter Wheat',
            harvestedAt: baseInput.occurredAt,
        });
    });

    it('records tonnes as tonnes without rescaling', async () => {
        itemWithUnit('t');
        const result = await recordYieldFromHarvest(mockDb, ctx, { ...baseInput, quantity: 42.5 });
        expect(result.grossTonnes).toBe(42.5);
    });

    it('rounds at the column precision (Decimal(14,3))', async () => {
        // 1234.5678 kg → 1.2345678 t, stored as 1.235.
        const result = await recordYieldFromHarvest(mockDb, ctx, { ...baseInput, quantity: 1234.5678 });
        expect(result.grossTonnes).toBe(1.235);
        expect(mockDb.yieldRecord.create.mock.calls[0][0].data.grossTonnes).toBe(1.235);
    });

    it('leaves areaHa and moisturePct NULL — a journal harvest states neither', async () => {
        // The alternative (defaulting areaHa to the parcel's total area) would
        // silently assume a whole-field harvest and understate t/ha whenever
        // only part of the field was cut.
        await recordYieldFromHarvest(mockDb, ctx, baseInput);
        const data = mockDb.yieldRecord.create.mock.calls[0][0].data;
        expect(data.areaHa).toBeNull();
        expect(data.moisturePct).toBeNull();
    });
});

describe('recordYieldFromHarvest — refuses rather than guesses', () => {
    it('refuses a counted product: crates are not tonnes', async () => {
        itemWithUnit('each', 'Tomato crates');
        const result = await recordYieldFromHarvest(mockDb, ctx, baseInput);

        expect(result.note).toBe('unit_not_mass');
        expect(result.yieldRecordId).toBeNull();
        expect(mockDb.yieldRecord.create).not.toHaveBeenCalled();
    });

    it('refuses a volume: litres are not tonnes', async () => {
        itemWithUnit('l', 'Pressed juice');
        const result = await recordYieldFromHarvest(mockDb, ctx, baseInput);
        expect(result.note).toBe('unit_not_mass');
        expect(mockDb.yieldRecord.create).not.toHaveBeenCalled();
    });

    it('refuses an item with no default unit at all', async () => {
        itemWithUnit(null);
        const result = await recordYieldFromHarvest(mockDb, ctx, baseInput);
        expect(result.note).toBe('unit_not_mass');
    });

    it('refuses a zero / negative quantity', async () => {
        const zero = await recordYieldFromHarvest(mockDb, ctx, { ...baseInput, quantity: 0 });
        expect(zero.note).toBe('zero_quantity');
        const negative = await recordYieldFromHarvest(mockDb, ctx, { ...baseInput, quantity: -5 });
        expect(negative.note).toBe('zero_quantity');
        expect(mockDb.yieldRecord.create).not.toHaveBeenCalled();
    });

    it('refuses when the item is not in this tenant', async () => {
        mockDb.item.findFirst.mockResolvedValue(null);
        const result = await recordYieldFromHarvest(mockDb, ctx, baseInput);
        expect(result.note).toBe('item_not_found');
        expect(mockDb.yieldRecord.create).not.toHaveBeenCalled();
    });

    it('is GRAIN-module gated — production is a grain concept', async () => {
        grainEnabled(false);
        const result = await recordYieldFromHarvest(mockDb, ctx, baseInput);
        expect(result.note).toBe('grain_disabled');
        expect(mockDb.yieldRecord.create).not.toHaveBeenCalled();
        // Gated BEFORE any other read — a tenant without the module should
        // not even be queried for the item.
        expect(mockDb.item.findFirst).not.toHaveBeenCalled();
    });
});

describe('recordYieldFromHarvest — idempotency and linkage', () => {
    it('does not double-count a replayed journal create', async () => {
        mockDb.yieldRecord.findFirst.mockResolvedValue({ id: 'yield-existing', grossTonnes: '1.5' });
        const result = await recordYieldFromHarvest(mockDb, ctx, baseInput);

        expect(result.note).toBe('already_recorded');
        expect(result.yieldRecordId).toBe('yield-existing');
        expect(result.grossTonnes).toBe(1.5);
        expect(mockDb.yieldRecord.create).not.toHaveBeenCalled();
    });

    it('looks the existing record up by (logEntryId, tenantId)', async () => {
        await recordYieldFromHarvest(mockDb, ctx, baseInput);
        expect(mockDb.yieldRecord.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { logEntryId: 'entry-1', tenantId: 'tenant-1' },
            }),
        );
    });

    it('resolves the season through the planting crop plan', async () => {
        mockDb.planting.findFirst.mockResolvedValue({
            parcelId: 'parcel-9',
            cropPlan: { seasonId: 'season-2026' },
        });
        mockDb.parcel.findFirst.mockResolvedValue({ locationId: 'field-3' });

        const result = await recordYieldFromHarvest(mockDb, ctx, {
            ...baseInput,
            plantingIds: ['planting-7'],
        });

        expect(result.seasonId).toBe('season-2026');
        expect(result.plantingId).toBe('planting-7');
        expect(mockDb.yieldRecord.create.mock.calls[0][0].data).toMatchObject({
            plantingId: 'planting-7',
            seasonId: 'season-2026',
            // The FIELD (a Location), resolved from the harvested Parcel.
            locationId: 'field-3',
        });
    });

    it('maps the harvested parcel onto the field even with no planting link', async () => {
        mockDb.parcel.findFirst.mockResolvedValue({ locationId: 'field-1' });
        await recordYieldFromHarvest(mockDb, ctx, { ...baseInput, parcelId: 'parcel-1' });
        expect(mockDb.yieldRecord.create.mock.calls[0][0].data.locationId).toBe('field-1');
    });

    it('writes an audit row naming the journal as the source', async () => {
        await recordYieldFromHarvest(mockDb, ctx, baseInput);
        expect(mockLogEvent).toHaveBeenCalledTimes(1);
        const entry = mockLogEvent.mock.calls[0][2];
        expect(entry.action).toBe('HARVEST_YIELD_RECORDED');
        expect(entry.entityType).toBe('YieldRecord');
        expect(entry.detailsJson.source).toBe('journal_harvest');
    });
});
