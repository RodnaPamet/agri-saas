/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock
 * pattern; per-line typing has poor cost/benefit ratio (mirrors
 * cost-rollup-usecase.test.ts). */

/**
 * Unit tests for `src/app-layer/usecases/grain-net-worth.ts` —
 * COST_METRICS.GRAIN_NET_WORTH.
 *
 * `db` reads are mocked (mirrors cost-rollup-usecase.test.ts); the two
 * sibling usecases this module composes (`getCostRollupByPlanting`,
 * `getMarketReferences`) are mocked as boundaries so each test can drive
 * exactly the scenario it means to assert, without re-deriving either
 * usecase's own logic.
 */

const mockDb = {
    planting: { findMany: jest.fn() },
    inventoryLot: { findMany: jest.fn() },
    unit: { findMany: jest.fn() },
    parcelLease: { findMany: jest.fn() },
    parcel: { findMany: jest.fn() },
    costEntry: { findMany: jest.fn() },
    costEntryAllocationParcel: { findMany: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

const mockGetCostRollupByPlanting = jest.fn();
jest.mock('@/app-layer/usecases/cost-rollup', () => ({
    getCostRollupByPlanting: (...args: any[]) => mockGetCostRollupByPlanting(...args),
}));

const mockGetMarketReferences = jest.fn();
jest.mock('@/app-layer/usecases/trends', () => ({
    getMarketReferences: (...args: any[]) => mockGetMarketReferences(...args),
}));

import { getGrainNetWorth } from '@/app-layer/usecases/grain-net-worth';
import { makeRequestContext } from '../helpers/make-context';
import { assertNetWorthInvariants } from '../helpers/grain-net-worth-invariants';
import { costUncertainty } from '@/lib/grain/uncertainty';

const ctx = makeRequestContext('ADMIN', { tenantSlug: 'acme', tenantId: 'tenant-1' });

/** A single-planting, single-crop fixture — reused by several tests. */
function planting(overrides: Partial<Record<string, any>> = {}) {
    return {
        id: 'p-1',
        areaM2: 10_000, // 1 ha
        plannedYieldKgPerHa: 4000,
        parcelId: null,
        cropPlan: { seasonId: 's-1', cropType: { commodityCanonical: 'wheat' } },
        ...overrides,
    };
}

/**
 * EVERY scenario in this file goes through here, which is the point.
 *
 * The identity `netWorth === netAssetPosition − cashCostTotal` used to be
 * asserted nowhere: each test hardcoded its own outputs, and the original
 * bug — `netWorth = netAssetPosition`, no cost subtracted — produced
 * numbers that were internally consistent and passed. Wrapping the call
 * means a scenario written about lease rent, payroll or exclusions now
 * checks the arithmetic too, without its author having thought about it.
 */
async function netWorthResult(...args: Parameters<typeof getGrainNetWorth>) {
    const result = await getGrainNetWorth(...args);
    assertNetWorthInvariants(result.rows);
    return result;
}

function resetMocks() {
    jest.clearAllMocks();
    mockDb.planting.findMany.mockResolvedValue([]);
    mockDb.inventoryLot.findMany.mockResolvedValue([]);
    mockDb.unit.findMany.mockResolvedValue([]);
    mockDb.parcelLease.findMany.mockResolvedValue([]);
    mockDb.parcel.findMany.mockResolvedValue([]);
    mockDb.costEntry.findMany.mockResolvedValue([]);
    mockDb.costEntryAllocationParcel.findMany.mockResolvedValue([]);
    mockGetCostRollupByPlanting.mockResolvedValue({ rows: [], truncated: false, unvalued: { noUnitCost: 0, unitMismatch: 0 } });
    mockGetMarketReferences.mockResolvedValue(new Map());
}

beforeEach(resetMocks);

describe('getGrainNetWorth — standing crop', () => {
    it('computes expected kg end to end from plannedYieldKgPerHa × area, and excludes a planting with no estimate', async () => {
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-1', areaM2: 10_000, plannedYieldKgPerHa: 4000 }), // 1 ha × 4000 kg/ha = 4000 kg
            planting({ id: 'p-2', areaM2: 20_000, plannedYieldKgPerHa: null }), // excluded — no estimate
        ]);
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 300, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);

        expect(result.rows).toHaveLength(1);
        const wheat = result.rows[0];
        expect(wheat.commodity).toBe('wheat');
        expect(wheat.standingCropExpectedKg).toBe(4000);
        expect(wheat.standingCropAreaHa).toBe(1);
        expect(wheat.standingCropPlantingIds).toEqual(['p-1']);
        // 4000 kg = 4 t × 300 BGN/t = 1200
        expect(wheat.standingCropValue).toBe(1200);
        expect(result.exclusions.plantingsMissingYieldEstimate.map((e) => e.id)).toEqual(['p-2']);
    });

    it('excludes a planting whose crop has no canonical commodity, naming it', async () => {
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-3', cropPlan: { seasonId: 's-1', cropType: { commodityCanonical: null } } }),
        ]);

        const result = await netWorthResult(ctx);

        expect(result.rows).toEqual([]);
        expect(result.exclusions.plantingsUnknownCommodity.map((e) => e.id)).toEqual(['p-3']);
    });
});

describe('getGrainNetWorth — per-decare figures', () => {
    it('divides by the INCLUDED-planting area, not everything planted', async () => {
        // THE DENOMINATOR. Two plantings, one with no yield estimate. Only
        // the estimated one contributes tonnage and value, so only its area
        // may sit under the line — otherwise the margin silently understates
        // by however many plantings lacked an estimate.
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-in', areaM2: 100_000, plannedYieldKgPerHa: 4000 }), // 10 ha
            planting({ id: 'p-out', areaM2: 300_000, plannedYieldKgPerHa: null }), // 30 ha, excluded
        ]);
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 300, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);
        const wheat = result.rows[0];

        // 10 ha included ⇒ 100 dca, NOT 400.
        expect(wheat.standingCropAreaHa).toBe(10);
        expect(wheat.perArea.areaDca).toBe(100);
        // 10 ha × 4000 kg/ha = 40 t × 300 = 12,000 over 100 dca.
        expect(wheat.perArea.standingValuePerDca).toBe(120);
    });

    it('says the margin is PARTIAL when cost covers land the revenue does not', async () => {
        // The excluded planting keeps its cost in cashCostTotal while
        // contributing no area and no value, so the two sides describe
        // different amounts of land.
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-in', areaM2: 100_000, plannedYieldKgPerHa: 4000 }),
            planting({ id: 'p-out', areaM2: 100_000, plannedYieldKgPerHa: null }),
        ]);
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 300, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);
        expect(result.rows[0].perArea.uncertainty).toBe('partial');
    });

    it('refuses per-dca for a commodity that is only in store', async () => {
        // No standing crop ⇒ no area ⇒ nothing to divide by. A stated
        // refusal, never Infinity.
        mockDb.planting.findMany.mockResolvedValue([]);
        mockDb.inventoryLot.findMany.mockResolvedValue([
            { id: 'lot-1', quantityOnHand: 7000, unitId: 'u-kg', item: { name: 'Wheat' } },
        ]);
        mockDb.unit.findMany.mockResolvedValue([{ id: 'u-kg', key: 'kg' }]);
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 300, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);
        const wheat = result.rows[0];

        expect(wheat.grainOnHandValue).toBe(2100);
        expect(wheat.perArea.marginPerDca).toBeNull();
        expect(wheat.perArea.uncertainty).toBe('refused');
        expect(wheat.perArea.refusalCode).toBe('NO_STANDING_CROP_AREA');
    });
});

describe('getGrainNetWorth — grain on hand', () => {
    it('converts quantityOnHand to tonnes via the lot\'s own unit, never assuming it is already tonnes', async () => {
        mockDb.inventoryLot.findMany.mockResolvedValue([
            { id: 'lot-1', quantityOnHand: 5000, unitId: 'u-kg', item: { name: 'Wheat' } }, // 5000 kg = 5 t
            { id: 'lot-2', quantityOnHand: 2, unitId: 'u-t', item: { name: 'Wheat' } }, // already tonnes
        ]);
        mockDb.unit.findMany.mockResolvedValue([
            { id: 'u-kg', key: 'kg' },
            { id: 'u-t', key: 't' },
        ]);
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 300, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        expect(wheat.grainOnHandTonnes).toBe(7);
        expect(wheat.grainOnHandLotIds.sort()).toEqual(['lot-1', 'lot-2']);
        expect(wheat.grainOnHandValue).toBe(2100); // 7 t × 300
    });

    it('excludes a lot whose unit cannot be resolved to a mass, naming the lot and unit key', async () => {
        mockDb.inventoryLot.findMany.mockResolvedValue([
            { id: 'lot-3', quantityOnHand: 10, unitId: 'u-each', item: { name: 'Wheat' } },
            { id: 'lot-4', quantityOnHand: 1, unitId: 'u-missing', item: { name: 'Wheat' } },
        ]);
        mockDb.unit.findMany.mockResolvedValue([{ id: 'u-each', key: 'each' }]);

        const result = await netWorthResult(ctx);

        expect(result.rows).toEqual([]);
        // The LABEL names both, which is what this test always meant:
        // the lot by its item name and the unit that failed to resolve.
        // It used to assert {lotId, unitKey} — the raw shape a farmer was
        // then shown as a cuid.
        expect(result.exclusions.lotsUnresolvedUnit).toEqual([
            { id: 'lot-3', label: 'Wheat (each)' },
            { id: 'lot-4', label: 'Wheat' },
        ]);
    });

    it('excludes a HARVESTED_PRODUCE lot whose item name names no canonical commodity', async () => {
        mockDb.inventoryLot.findMany.mockResolvedValue([
            { id: 'lot-5', quantityOnHand: 100, unitId: 'u-kg', item: { name: 'Some Unrecognised Grain' } },
        ]);
        mockDb.unit.findMany.mockResolvedValue([{ id: 'u-kg', key: 'kg' }]);

        const result = await netWorthResult(ctx);

        expect(result.rows).toEqual([]);
        expect(result.exclusions.lotsUnknownCommodity.map((e) => e.id)).toEqual(['lot-5']);
    });
});

describe('getGrainNetWorth — attributed crop cost (reused from cost-rollup)', () => {
    it('sums getCostRollupByPlanting rows per commodity and passes its currency/mixed flags through as-is', async () => {
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-1' }),
            planting({ id: 'p-2' }),
        ]);
        mockGetCostRollupByPlanting.mockResolvedValue({
            rows: [
                { plantingId: 'p-1', totalCost: 1000, currencies: ['BGN'], currencyMixed: false, unvaluedNoUnitCost: 0, unvaluedUnitMismatch: 0 },
                { plantingId: 'p-2', totalCost: 500, currencies: ['EUR'], currencyMixed: false, unvaluedNoUnitCost: 0, unvaluedUnitMismatch: 0 },
            ],
            truncated: false,
            unvalued: { noUnitCost: 0, unitMismatch: 0 },
        });

        const result = await netWorthResult(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        expect(wheat.attributedCropCost).toBe(1500);
        expect(wheat.attributedCropCostCurrencies).toEqual(['BGN', 'EUR']);
        // Neither individual row was mixed, but the UNION has two currencies —
        // the module states this plainly rather than re-deriving a stricter
        // guarantee cost-rollup's own composition does not provide.
        expect(mockGetCostRollupByPlanting).toHaveBeenCalledWith(ctx, { seasonId: undefined, take: 2000 });
    });

    it('names a cost-rollup row whose planting has no resolvable commodity', async () => {
        mockGetCostRollupByPlanting.mockResolvedValue({
            rows: [{ plantingId: 'p-orphan', totalCost: 50, currencies: ['BGN'], currencyMixed: false, unvaluedNoUnitCost: 0, unvaluedUnitMismatch: 0 }],
            truncated: false,
            unvalued: { noUnitCost: 0, unitMismatch: 0 },
        });

        const result = await netWorthResult(ctx);

        expect(result.rows).toEqual([]);
        expect(result.exclusions.plantingsUnknownCommodity.map((e) => e.id)).toEqual(['p-orphan']);
    });
});

describe('getGrainNetWorth — rent attribution', () => {
    it('splits money rent pro-rata by area across a parcel\'s plantings', async () => {
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-1', areaM2: 10_000, parcelId: 'parcel-1' }), // 1 ha
            planting({ id: 'p-2', areaM2: 20_000, parcelId: 'parcel-1' }), // 2 ha
        ]);
        mockDb.parcelLease.findMany.mockResolvedValue([
            {
                id: 'lease-1',
                parcelId: 'parcel-1',
                rentAmount: 50, // лв/дка
                rentUnit: 'лв/дка',
                rentUnitRaw: 'лв/дка',
                parcel: { areaHa: 3 },
            },
        ]);

        const result = await netWorthResult(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        // perHa = 50 × 10 = 500 leva/ha; total for the 3 ha parcel = 1500;
        // split 1 ha / 2 ha ⇒ entirely attributed to the SAME commodity
        // here, so the row total is the full 1500.
        expect(wheat.rentCostMoneyAmount).toBe(1500);
    });

    it('values produce rent (кг/дка) via the commodity price rather than adding kg to money', async () => {
        mockDb.planting.findMany.mockResolvedValue([planting({ id: 'p-1', areaM2: 5000, parcelId: 'parcel-2' })]); // 0.5 ha
        mockDb.parcelLease.findMany.mockResolvedValue([
            {
                id: 'lease-2',
                parcelId: 'parcel-2',
                rentAmount: 100, // кг/дка
                rentUnit: 'кг/дка',
                rentUnitRaw: 'кг/дка',
                parcel: { areaHa: 0.5 },
            },
        ]);
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 300, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        // kgPerHa = 100 × 10 = 1000 kg/ha; total for 0.5 ha = 500 kg.
        expect(wheat.rentCostProduceKg).toBe(500);
        // 500 kg = 0.5 t × 300 = 150.
        expect(wheat.rentCostProduceValue).toBe(150);
        expect(result.exclusions.leasesProduceRentUnpriced).toEqual([]);
    });

    it('excludes produce rent from cost — never blended with money — when its commodity has no price', async () => {
        mockDb.planting.findMany.mockResolvedValue([planting({ id: 'p-1', areaM2: 5000, parcelId: 'parcel-2' })]);
        mockDb.parcelLease.findMany.mockResolvedValue([
            {
                id: 'lease-2',
                parcelId: 'parcel-2',
                rentAmount: 100,
                rentUnit: 'кг/дка',
                rentUnitRaw: 'кг/дка',
                parcel: { areaHa: 0.5 },
            },
        ]);
        // No market reference for wheat.

        const result = await netWorthResult(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        expect(wheat.rentCostProduceKg).toBe(500);
        expect(wheat.rentCostProduceValue).toBeNull();
        expect(result.exclusions.leasesProduceRentUnpriced.map((e) => e.id)).toEqual(['lease-2']);
    });

    it('names a lease whose rent unit does not resolve', async () => {
        mockDb.parcelLease.findMany.mockResolvedValue([
            {
                id: 'lease-3',
                parcelId: 'parcel-9',
                rentAmount: 150,
                rentUnit: null,
                rentUnitRaw: '150 лв/ха', // not a canonical per-decare rate
                parcel: { areaHa: 2 },
            },
        ]);

        const result = await netWorthResult(ctx);

        expect(result.exclusions.leasesUnresolvedRent).toHaveLength(1);
        // `.id`, not `.leaseId` — every exclusion class is one shape now,
        // and each entry carries a human label beside the id.
        expect(result.exclusions.leasesUnresolvedRent[0].id).toBe('lease-3');
    });

    it('names a resolved lease with no in-scope planting to attribute its rent to', async () => {
        mockDb.parcelLease.findMany.mockResolvedValue([
            {
                id: 'lease-4',
                parcelId: 'parcel-empty',
                rentAmount: 20,
                rentUnit: 'лв/дка',
                rentUnitRaw: 'лв/дка',
                parcel: { areaHa: 1 },
            },
        ]);

        const result = await netWorthResult(ctx);

        expect(result.exclusions.leasesUnattributed.map((e) => e.id)).toEqual(['lease-4']);
    });
});

describe('getGrainNetWorth — payroll allocation', () => {
    it('attributes a directly-linked row without setting payrollAllocated', async () => {
        mockDb.planting.findMany.mockResolvedValue([planting({ id: 'p-1' })]);
        mockDb.costEntry.findMany.mockResolvedValue([
            { id: 'pay-1', category: 'PAYROLL', amount: 200, currency: 'BGN', plantingId: 'p-1', seasonId: null },
        ]);

        const result = await netWorthResult(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        expect(wheat.payrollCost).toBe(200);
        expect(wheat.payrollCostCurrencies).toEqual(['BGN']);
        expect(wheat.payrollAllocated).toBe(false);
    });

    it('allocates an unattributed row pro-rata by area share and sets payrollAllocated + per-currency grouping', async () => {
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-1', areaM2: 10_000, cropPlan: { seasonId: 's-1', cropType: { commodityCanonical: 'wheat' } } }), // 1 ha
            planting({ id: 'p-3', areaM2: 5_000, cropPlan: { seasonId: 's-1', cropType: { commodityCanonical: 'maize' } } }), // 0.5 ha
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([
            { id: 'pay-2', category: 'PAYROLL', amount: 300, currency: 'BGN', plantingId: null, seasonId: 's-1' },
            { id: 'pay-3', category: 'PAYROLL', amount: 60, currency: 'EUR', plantingId: null, seasonId: 's-1' },
        ]);

        const result = await netWorthResult(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        const maize = result.rows.find((r) => r.commodity === 'maize')!;
        // Weight: wheat 1/1.5 = 2/3, maize 0.5/1.5 = 1/3.
        expect(wheat.payrollCost).toBeCloseTo(240, 2); // 2/3 × (300+60)
        expect(maize.payrollCost).toBeCloseTo(120, 2); // 1/3 × 360
        expect(wheat.payrollAllocated).toBe(true);
        expect(maize.payrollAllocated).toBe(true);
        expect(wheat.payrollCostCurrencies).toEqual(['BGN', 'EUR']);
        expect(wheat.payrollCostCurrencyMixed).toBe(true);
    });

    it('names a payroll row with nothing to allocate against', async () => {
        mockDb.costEntry.findMany.mockResolvedValue([
            { id: 'pay-4', category: 'PAYROLL', amount: 15, currency: 'BGN', plantingId: null, seasonId: 'season-with-no-plantings' },
        ]);

        const result = await netWorthResult(ctx);

        expect(result.exclusions.payrollUnattributable.map((e) => e.id)).toEqual(['pay-4']);
    });

    it('names a directly-linked row whose planting has no resolvable commodity', async () => {
        mockDb.costEntry.findMany.mockResolvedValue([
            { id: 'pay-5', category: 'PAYROLL', amount: 10, currency: 'BGN', plantingId: 'p-missing', seasonId: null },
        ]);

        const result = await netWorthResult(ctx);

        expect(result.exclusions.payrollUnattributable.map((e) => e.id)).toEqual(['pay-5']);
        expect(result.exclusions.plantingsUnknownCommodity.map((e) => e.id)).toEqual(['p-missing']);
    });
});

describe('getGrainNetWorth — currency handling and net worth', () => {
    it('computes a real net worth figure when cash costs share a single currency matching the price currency', async () => {
        mockDb.planting.findMany.mockResolvedValue([planting({ id: 'p-1', areaM2: 10_000, plannedYieldKgPerHa: 3000 })]);
        mockGetCostRollupByPlanting.mockResolvedValue({ rows: [], truncated: false, unvalued: { noUnitCost: 0, unitMismatch: 0 } });
        mockDb.costEntry.findMany.mockResolvedValue([
            { id: 'pay-1', category: 'PAYROLL', amount: 100, currency: 'BGN', plantingId: 'p-1', seasonId: null },
        ]);
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 250, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        // standing crop = 3 t × 250 = 750; cash cost = 100 (BGN, matches price currency).
        expect(wheat.netAssetPosition).toBe(750);
        expect(wheat.cashCostCurrencies).toEqual(['BGN']);
        expect(wheat.netWorth).toBe(650);
        expect(wheat.netWorthUnavailableReason).toBeNull();
    });

    it('refuses to blend currencies into net worth — null with a stated reason on mismatch', async () => {
        mockDb.planting.findMany.mockResolvedValue([planting({ id: 'p-1', plannedYieldKgPerHa: 3000 })]);
        mockGetCostRollupByPlanting.mockResolvedValue({
            rows: [{ plantingId: 'p-1', totalCost: 100, currencies: ['EUR'], currencyMixed: false, unvaluedNoUnitCost: 0, unvaluedUnitMismatch: 0 }],
            truncated: false,
            unvalued: { noUnitCost: 0, unitMismatch: 0 },
        });
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 250, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        expect(wheat.netWorth).toBeNull();
        expect(wheat.netWorthUnavailableReason).toMatch(/EUR/);
        expect(wheat.netWorthUnavailableReason).toMatch(/BGN/);
    });

    it('subtracts cost that arrived with NO currency at all — the journal-entered case', async () => {
        // The regression this pins: cost-rollup's `addCurrency` skips nulls,
        // and `LogEntry.costCurrency` is null for every entry the journal UI
        // creates. So a real magnitude arrives with an EMPTY currency set —
        // the ordinary case for a farm that records spend in the journal and
        // has no lease or payroll rows.
        //
        // finalizeRow used to answer that shape with `netWorth =
        // netAssetPosition`, dropping the cost entirely. Nothing in here
        // could see it: the figure is internally consistent, and it only
        // became visible once /grain/calculator rendered cashCostTotal
        // beside it.
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-1', areaM2: 10_000, plannedYieldKgPerHa: 3000 }),
        ]);
        mockGetCostRollupByPlanting.mockResolvedValue({
            rows: [{ plantingId: 'p-1', totalCost: 100, currencies: [], currencyMixed: false, unvaluedNoUnitCost: 0, unvaluedUnitMismatch: 0 }],
            truncated: false,
            unvalued: { noUnitCost: 0, unitMismatch: 0 },
        });
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 250, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        expect(wheat.cashCostCurrencies).toEqual([]);
        expect(wheat.cashCostTotal).toBe(100);
        expect(wheat.netAssetPosition).toBe(750);
        // 750 − 100. The bug returned 750 here.
        expect(wheat.netWorth).toBe(650);
        expect(wheat.netWorthUnavailableReason).toBeNull();
    });

    it('still returns the asset position when there is genuinely no cost', async () => {
        // Same empty-currency shape, zero magnitude — the case the old
        // branch was written for. Subtracting 0 keeps it correct, so the
        // fix above must not have turned this into a refusal.
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-1', areaM2: 10_000, plannedYieldKgPerHa: 3000 }),
        ]);
        mockGetCostRollupByPlanting.mockResolvedValue({ rows: [], truncated: false, unvalued: { noUnitCost: 0, unitMismatch: 0 } });
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 250, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        expect(wheat.cashCostTotal).toBe(0);
        expect(wheat.netWorth).toBe(750);
        expect(wheat.netWorthUnavailableReason).toBeNull();
    });

    it('names a commodity touched by the calculation with no market price at all', async () => {
        mockDb.planting.findMany.mockResolvedValue([planting({ id: 'p-1', plannedYieldKgPerHa: 3000 })]);
        // No market reference registered for wheat.

        const result = await netWorthResult(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        expect(wheat.standingCropValue).toBeNull();
        expect(wheat.netWorth).toBeNull();
        expect(wheat.netWorthUnavailableReason).toContain('wheat');
        expect(result.exclusions.commoditiesWithNoPrice.map((e) => e.id)).toEqual(['wheat']);
    });
});

describe('getGrainNetWorth — divergence from ATTRIBUTED_CROP_COST (the fourth-metric pin)', () => {
    it('differs from getCostRollupByPlanting\'s total for the same season when payroll AND rent are present', async () => {
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-1', areaM2: 10_000, parcelId: 'parcel-1', cropPlan: { seasonId: 's-1', cropType: { commodityCanonical: 'wheat' } } }),
        ]);
        mockDb.parcelLease.findMany.mockResolvedValue([
            {
                id: 'lease-1',
                parcelId: 'parcel-1',
                rentAmount: 50,
                rentUnit: 'лв/дка',
                rentUnitRaw: 'лв/дка',
                parcel: { areaHa: 1 },
            },
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([
            { id: 'pay-1', category: 'PAYROLL', amount: 40, currency: 'BGN', plantingId: 'p-1', seasonId: null },
        ]);
        const rollupRows = [{ plantingId: 'p-1', totalCost: 100, currencies: ['BGN'], currencyMixed: false, unvaluedNoUnitCost: 0, unvaluedUnitMismatch: 0 }];
        mockGetCostRollupByPlanting.mockResolvedValue({ rows: rollupRows, truncated: false });

        const result = await netWorthResult(ctx, { seasonId: 's-1' });

        const rollupTotal = rollupRows.reduce((sum, r) => sum + r.totalCost, 0);
        const netWorthTotal = result.rows.reduce((sum, r) => sum + r.cashCostTotal, 0);

        expect(rollupTotal).toBe(100);
        // rent (500) + payroll (40) on top of the reused attributed cost (100).
        expect(netWorthTotal).toBe(640);
        expect(netWorthTotal).not.toBe(rollupTotal);
        expect(mockGetCostRollupByPlanting).toHaveBeenCalledWith(ctx, { seasonId: 's-1', take: 2000 });
    });

    it('matches getCostRollupByPlanting\'s total when no payroll or rent is present', async () => {
        mockDb.planting.findMany.mockResolvedValue([planting({ id: 'p-1' })]);
        const rollupRows = [{ plantingId: 'p-1', totalCost: 100, currencies: ['BGN'], currencyMixed: false, unvaluedNoUnitCost: 0, unvaluedUnitMismatch: 0 }];
        mockGetCostRollupByPlanting.mockResolvedValue({ rows: rollupRows, truncated: false });

        const result = await netWorthResult(ctx);

        const rollupTotal = rollupRows.reduce((sum, r) => sum + r.totalCost, 0);
        const netWorthTotal = result.rows.reduce((sum, r) => sum + r.cashCostTotal, 0);
        expect(netWorthTotal).toBe(rollupTotal);
    });
});

describe('getGrainNetWorth — access control + truncation', () => {
    it('rejects a context without read permission', async () => {
        const noRead = makeRequestContext('READER', {
            tenantId: 'tenant-1',
            permissions: { canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        });
        await expect(getGrainNetWorth(noRead)).rejects.toThrow();
    });

    it('propagates truncation from either the tenant reads or the cost rollup', async () => {
        mockGetCostRollupByPlanting.mockResolvedValue({ rows: [], truncated: true });
        const result = await netWorthResult(ctx);
        expect(result.truncated).toBe(true);
    });

    it('every batched findMany is bounded with take', async () => {
        await netWorthResult(ctx);
        for (const call of mockDb.planting.findMany.mock.calls) expect(call[0].take).toBeGreaterThan(0);
        for (const call of mockDb.inventoryLot.findMany.mock.calls) expect(call[0].take).toBeGreaterThan(0);
        for (const call of mockDb.parcelLease.findMany.mock.calls) expect(call[0].take).toBeGreaterThan(0);
        for (const call of mockDb.costEntry.findMany.mock.calls) expect(call[0].take).toBeGreaterThan(0);
    });
});

describe('getGrainNetWorth — unvalued consumptions', () => {
    it('sums the per-commodity counts and passes the farm-wide total through UNSUMMED', async () => {
        // The rollup counts TRANSACTIONS for its farm-wide figure and
        // increments a whole 1 per planting for its rows, so a transaction
        // shared by two plantings is 1 farm-wide and 1 on each row. This
        // module must carry that distinction, not re-derive it: summing
        // rows here would multiply a shared transaction by the commodities
        // it touched and report more unvalued movements than exist.
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-1', plannedYieldKgPerHa: 3000 }),
            planting({ id: 'p-2', plannedYieldKgPerHa: 3000 }),
        ]);
        mockGetCostRollupByPlanting.mockResolvedValue({
            rows: [
                { plantingId: 'p-1', totalCost: 100, currencies: ['BGN'], currencyMixed: false, unvaluedNoUnitCost: 1, unvaluedUnitMismatch: 0 },
                { plantingId: 'p-2', totalCost: 100, currencies: ['BGN'], currencyMixed: false, unvaluedNoUnitCost: 1, unvaluedUnitMismatch: 2 },
            ],
            truncated: false,
            // ONE transaction, attributed to both plantings.
            unvalued: { noUnitCost: 1, unitMismatch: 2 },
        });
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 250, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);

        // Both plantings are wheat, so the row counts add up.
        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        expect(wheat.unvaluedNoUnitCost).toBe(2);
        expect(wheat.unvaluedUnitMismatch).toBe(2);

        // …but the farm-wide figure is the rollup's DISTINCT count, which
        // is 1, not the rows' 2. Re-deriving from rows would break this.
        expect(result.unvalued).toEqual({ noUnitCost: 1, unitMismatch: 2 });
    });

    it('reports zeroes when every consumption was valued', async () => {
        const result = await netWorthResult(ctx);
        expect(result.unvalued).toEqual({ noUnitCost: 0, unitMismatch: 0 });
    });

    it('does NOT change cashCostTotal or netWorth — a disclosure, not a recalculation', async () => {
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-1', areaM2: 10_000, plannedYieldKgPerHa: 3000 }),
        ]);
        mockGetCostRollupByPlanting.mockResolvedValue({
            rows: [{ plantingId: 'p-1', totalCost: 100, currencies: ['BGN'], currencyMixed: false, unvaluedNoUnitCost: 5, unvaluedUnitMismatch: 3 }],
            truncated: false,
            unvalued: { noUnitCost: 5, unitMismatch: 3 },
        });
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 250, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);
        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;

        // Eight unvalued movements, and the money is untouched: 750 − 100.
        expect(wheat.cashCostTotal).toBe(100);
        expect(wheat.netWorth).toBe(650);
        expect(wheat.netWorthUnavailableReason).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────
// The double-count rule.
//
// `src/lib/grain/cost-metrics.ts` exists because three incompatible
// definitions of "cost" once shipped under one word. Wiring CostEntry
// into this module can recreate that in a single line, so the rule is
// pinned by EXECUTING tests rather than a comment:
//
//   • crop cost stays CONSUMPTION-based (cost-rollup counts only
//     CONSUMPTION movements; RECEIPT is excluded as working capital);
//   • an INPUT-category CostEntry is a PURCHASE and reaches CASH-OUT
//     only — counting it as cost too bills the same sack of fertiliser
//     once when bought and again when applied;
//   • PAYROLL has no consumption path, so it DOES reach cost.
// ─────────────────────────────────────────────────────────────────────

function costEntry(over: Record<string, unknown> = {}) {
    return {
        id: 'ce-1',
        category: 'FERTILIZER',
        amount: 500,
        currency: 'BGN',
        plantingId: null,
        seasonId: null,
        ...over,
    };
}

describe('getGrainNetWorth — purchases never enter crop cost', () => {
    it('a FERTILIZER entry AND a CONSUMPTION of the same fertiliser counts ONCE', async () => {
        // THE regression this rule exists for. The farm bought 500 of
        // fertiliser and applied 400 of it. Crop cost is the APPLICATION
        // (via cost-rollup); the purchase is cash out. Summing both would
        // report 900 for one sack.
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-1', areaM2: 10_000, plannedYieldKgPerHa: 3000 }),
        ]);
        mockGetCostRollupByPlanting.mockResolvedValue({
            rows: [
                {
                    plantingId: 'p-1',
                    totalCost: 400, // the CONSUMPTION, from the stock ledger
                    currencies: ['BGN'],
                    currencyMixed: false,
                    unvaluedNoUnitCost: 0,
                    unvaluedUnitMismatch: 0,
                },
            ],
            truncated: false,
            unvalued: { noUnitCost: 0, unitMismatch: 0 },
        });
        mockDb.costEntry.findMany.mockResolvedValue([
            costEntry({ category: 'FERTILIZER', amount: 500, plantingId: 'p-1' }),
        ]);
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 250, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);
        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;

        // 400, not 900: the purchase is NOT in crop cost.
        expect(wheat.attributedCropCost).toBe(400);
        expect(wheat.payrollCost).toBe(0);
        expect(wheat.cashCostTotal).toBe(400);
        // …and it IS in cash-out.
        expect(result.cashOut).toEqual([
            { currency: 'BGN', amount: 500, categories: ['FERTILIZER'] },
        ]);
    });

    it.each(['FERTILIZER', 'FUEL', 'SEED', 'PESTICIDE', 'SERVICE', 'OTHER', 'RENT'])(
        'a %s entry moves cash-out but NOT the cost side',
        async (category) => {
            mockDb.planting.findMany.mockResolvedValue([
                planting({ id: 'p-1', areaM2: 10_000, plannedYieldKgPerHa: 3000 }),
            ]);
            mockDb.costEntry.findMany.mockResolvedValue([
                costEntry({ category, amount: 750, plantingId: 'p-1' }),
            ]);
            mockGetMarketReferences.mockResolvedValue(
                new Map([['wheat', { commodity: 'wheat', pricePerTonne: 250, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
            );

            const result = await netWorthResult(ctx);
            const wheat = result.rows.find((r) => r.commodity === 'wheat')!;

            expect(wheat.payrollCost).toBe(0);
            expect(wheat.cashCostTotal).toBe(0);
            expect(result.cashOut[0]).toMatchObject({ amount: 750, categories: [category] });
        },
    );

    it('a PAYROLL entry DOES move the cost side — nothing else records labour', async () => {
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-1', areaM2: 10_000, plannedYieldKgPerHa: 3000 }),
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([
            costEntry({ category: 'PAYROLL', amount: 300, plantingId: 'p-1' }),
        ]);
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 250, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await netWorthResult(ctx);
        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;

        expect(wheat.payrollCost).toBe(300);
        expect(wheat.cashCostTotal).toBe(300);
        // Payroll is BOTH: it is a real crop cost and it is money that
        // left the bank.
        expect(result.cashOut[0]).toMatchObject({ amount: 300, categories: ['PAYROLL'] });
    });
});

describe('getGrainNetWorth — cash-out never blends currencies', () => {
    it('groups per currency and sorts deterministically', async () => {
        // No FX table exists in this repo. One blended figure would be a
        // number that reconciles against nothing.
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-1', plannedYieldKgPerHa: 3000 }),
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([
            costEntry({ id: 'a', category: 'FUEL', amount: 100, currency: 'EUR' }),
            costEntry({ id: 'b', category: 'SEED', amount: 200, currency: 'BGN' }),
            costEntry({ id: 'c', category: 'FUEL', amount: 50, currency: 'BGN' }),
        ]);

        const result = await netWorthResult(ctx);

        expect(result.cashOut).toEqual([
            { currency: 'BGN', amount: 250, categories: ['FUEL', 'SEED'] },
            { currency: 'EUR', amount: 100, categories: ['FUEL'] },
        ]);
    });

    it('is an empty list when the farm entered nothing', async () => {
        const result = await netWorthResult(ctx);
        expect(result.cashOut).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════
//  Selectable cost allocation — CostEntry.allocationBasis
// ═══════════════════════════════════════════════════════════════════════

/**
 * A PAYROLL entry, since payroll is the only category that reaches the
 * cost side. `allocationBasis` defaults to the column's own default.
 */
function payroll(over: Record<string, unknown> = {}) {
    return costEntry({ id: 'pay-1', category: 'PAYROLL', amount: 100, allocationBasis: 'TARGET', ...over });
}

function parcel(id: string, areaHa: number | null) {
    return { id, areaHa };
}

/** Money the farm entered, wherever the allocator put it, to the cent. */
function allocatedCents(result: Awaited<ReturnType<typeof getGrainNetWorth>>) {
    const rows = result.rows.reduce((sum, r) => sum + r.payrollCost, 0);
    return Math.round((rows + result.unallocatedToCrop.amount) * 100);
}

const priced = (commodities: string[]) =>
    new Map(
        commodities.map((c) => [
            c,
            { commodity: c, pricePerTonne: 300, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' },
        ]),
    );

describe('allocation basis — conservation is the contract', () => {
    it('splits 100.00 over three parcels without losing the odd cent', async () => {
        // Naive per-share rounding reaches the farm total as 99.99. Every
        // downstream figure — cash cost, net worth, margin per decare —
        // inherits that error and none of them can say where it came from.
        mockDb.parcel.findMany.mockResolvedValue([
            parcel('parcel-a', 1),
            parcel('parcel-b', 1),
            parcel('parcel-c', 1),
        ]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-a', parcelId: 'parcel-a', areaM2: 10_000 }),
            planting({ id: 'plant-b', parcelId: 'parcel-b', areaM2: 10_000 }),
            planting({
                id: 'plant-c',
                parcelId: 'parcel-c',
                areaM2: 10_000,
                cropPlan: { seasonId: 's-1', cropType: { commodityCanonical: 'maize' } },
            }),
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([payroll({ allocationBasis: 'HOLDING' })]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat', 'maize']));

        const result = await netWorthResult(ctx);

        expect(allocatedCents(result)).toBe(10_000);
        // Deterministic, not merely conserved: the odd cent goes to the
        // lexicographically first parcel id, never to whichever row the
        // query happened to return first.
        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        const maize = result.rows.find((r) => r.commodity === 'maize')!;
        expect(wheat.payrollCost).toBe(66.67);
        expect(maize.payrollCost).toBe(33.33);
    });

    it('conserves under every basis, over awkward amounts', async () => {
        for (const basis of ['TARGET', 'HOLDING', 'PARCEL_SUBSET'] as const) {
            for (const amount of [100, 0.01, 999.99, 1_234.56, 7]) {
                resetMocks();
                mockDb.parcel.findMany.mockResolvedValue([
                    parcel('parcel-a', 1.7),
                    parcel('parcel-b', 2.3),
                    parcel('parcel-c', 0.9),
                ]);
                mockDb.planting.findMany.mockResolvedValue([
                    planting({ id: 'plant-a', parcelId: 'parcel-a', areaM2: 17_000 }),
                    planting({ id: 'plant-b', parcelId: 'parcel-b', areaM2: 23_000 }),
                ]);
                mockDb.costEntryAllocationParcel.findMany.mockResolvedValue([
                    { costEntryId: 'pay-1', parcelId: 'parcel-a' },
                    { costEntryId: 'pay-1', parcelId: 'parcel-c' },
                ]);
                mockDb.costEntry.findMany.mockResolvedValue([payroll({ amount, allocationBasis: basis })]);
                mockGetMarketReferences.mockResolvedValue(priced(['wheat']));

                const result = await netWorthResult(ctx);
                expect({ basis, amount, cents: allocatedCents(result) }).toEqual({
                    basis,
                    amount,
                    cents: Math.round(amount * 100),
                });
            }
        }
    });

    it('REDISTRIBUTES when the basis changes and never changes the total', async () => {
        // The same 100.00 read two ways. Under TARGET the denominator is
        // the plantings (2 ha of crop); under HOLDING it is the LAND
        // (3 ha, one of it fallow). Different homes, identical total.
        const fixture = () => {
            mockDb.parcel.findMany.mockResolvedValue([
                parcel('parcel-maize', 1),
                parcel('parcel-wheat', 1),
                parcel('parcel-fallow', 1),
            ]);
            mockDb.planting.findMany.mockResolvedValue([
                planting({
                    id: 'plant-maize',
                    parcelId: 'parcel-maize',
                    areaM2: 10_000,
                    cropPlan: { seasonId: 's-1', cropType: { commodityCanonical: 'maize' } },
                }),
                planting({ id: 'plant-w1', parcelId: 'parcel-wheat', areaM2: 5_000 }),
                planting({ id: 'plant-w2', parcelId: 'parcel-wheat', areaM2: 5_000 }),
            ]);
            mockGetMarketReferences.mockResolvedValue(priced(['wheat', 'maize']));
        };

        resetMocks();
        fixture();
        mockDb.costEntry.findMany.mockResolvedValue([payroll({ allocationBasis: 'TARGET' })]);
        const target = await netWorthResult(ctx);

        resetMocks();
        fixture();
        mockDb.costEntry.findMany.mockResolvedValue([payroll({ allocationBasis: 'HOLDING' })]);
        const holding = await netWorthResult(ctx);

        // TARGET weights PLANTINGS: 1 ha of maize against 1 ha of wheat
        // in two halves ⇒ 50/50, and the fallow parcel does not exist to it.
        expect(target.rows.find((r) => r.commodity === 'maize')!.payrollCost).toBe(50);
        expect(target.rows.find((r) => r.commodity === 'wheat')!.payrollCost).toBe(50);
        expect(target.unallocatedToCrop.amount).toBe(0);

        // HOLDING weights LAND: three parcels, so the fallow one takes a
        // third and the wheat parcel takes one third however many
        // plantings share it — splitting a field must not double what it
        // attracts.
        expect(holding.rows.find((r) => r.commodity === 'maize')!.payrollCost).toBe(33.33);
        expect(holding.rows.find((r) => r.commodity === 'wheat')!.payrollCost).toBe(33.33);
        // The odd cent goes to `parcel-fallow` — first by id, which is the
        // tie-break, and NOT the order the query returned the rows in.
        expect(holding.unallocatedToCrop.amount).toBe(33.34);

        expect(allocatedCents(target)).toBe(allocatedCents(holding));
        expect(allocatedCents(holding)).toBe(10_000);
    });
});

describe('allocation basis — land with no crop', () => {
    it('gives a fallow parcel its share and reports it instead of dropping it', async () => {
        // 5000 over 500 dca of which 300 dca is wheat. The instinct of
        // every allocator already in this file is to `continue` past land
        // with no commodity to charge; that money would leave the report
        // and every per-dca figure would rise with nothing saying why.
        mockDb.parcel.findMany.mockResolvedValue([
            parcel('parcel-cropped', 30),
            parcel('parcel-fallow', 20),
        ]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-wheat', parcelId: 'parcel-cropped', areaM2: 300_000 }),
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([
            payroll({ amount: 5000, allocationBasis: 'HOLDING' }),
        ]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat']));

        const result = await netWorthResult(ctx);
        const wheat = result.rows[0];

        expect(wheat.payrollCost).toBe(3000);
        expect(result.unallocatedToCrop).toEqual({
            amount: 2000,
            areaHa: 20,
            parcelIds: ['parcel-fallow'],
            currencies: ['BGN'],
        });
        // THE ARITHMETIC PROOF the spread was pure: the same rate either
        // side of the fallow line. Concentrating the fallow share onto the
        // crop would make wheat 16.67 лв/dca against a fallow zero.
        expect(3000 / 30).toBe(result.unallocatedToCrop.amount / result.unallocatedToCrop.areaHa);
        expect(allocatedCents(result)).toBe(500_000);
    });

    it('counts a fallow parcel\'s hectares ONCE across several spread costs', async () => {
        // Area is the denominator of the rate check above. Adding the same
        // parcel's hectares once per entry would inflate it silently.
        mockDb.parcel.findMany.mockResolvedValue([
            parcel('parcel-cropped', 30),
            parcel('parcel-fallow', 20),
        ]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-wheat', parcelId: 'parcel-cropped', areaM2: 300_000 }),
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([
            payroll({ id: 'pay-1', amount: 5000, allocationBasis: 'HOLDING' }),
            payroll({ id: 'pay-2', amount: 2500, allocationBasis: 'HOLDING' }),
        ]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat']));

        const result = await netWorthResult(ctx);

        expect(result.unallocatedToCrop.areaHa).toBe(20);
        expect(result.unallocatedToCrop.amount).toBe(3000);
        expect(allocatedCents(result)).toBe(750_000);
    });

    it('treats a parcel whose only crop has no canonical commodity as fallow', async () => {
        mockDb.parcel.findMany.mockResolvedValue([parcel('parcel-a', 1), parcel('parcel-b', 1)]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-known', parcelId: 'parcel-a', areaM2: 10_000 }),
            planting({
                id: 'plant-unknown',
                parcelId: 'parcel-b',
                areaM2: 10_000,
                cropPlan: { seasonId: 's-1', cropType: { commodityCanonical: null } },
            }),
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([payroll({ allocationBasis: 'HOLDING' })]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat']));

        const result = await netWorthResult(ctx);

        expect(result.rows[0].payrollCost).toBe(50);
        expect(result.unallocatedToCrop.parcelIds).toEqual(['parcel-b']);
        expect(allocatedCents(result)).toBe(10_000);
    });

    it('splits evenly across a holding whose parcels all have no recorded area', async () => {
        // Dropping the cost is the silent failure mode; an even split is a
        // stated one. `computeAreaWeights` is the ONE weighting rule, so
        // its zero-area fallback has to survive the parcel path too.
        mockDb.parcel.findMany.mockResolvedValue([
            parcel('parcel-a', null),
            parcel('parcel-b', null),
            parcel('parcel-c', null),
        ]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-a', parcelId: 'parcel-a', areaM2: null }),
            planting({ id: 'plant-b', parcelId: 'parcel-b', areaM2: null }),
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([payroll({ allocationBasis: 'HOLDING' })]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat']));

        const result = await netWorthResult(ctx);

        expect(result.rows[0].payrollCost).toBe(66.67);
        expect(result.unallocatedToCrop.amount).toBe(33.33);
        expect(allocatedCents(result)).toBe(10_000);
    });

    it('reports money rent on an unplanted parcel instead of dropping it', async () => {
        // This one is not new behaviour bolted on: it is the same idea
        // arriving where money already went missing. The lease was named
        // in an exclusion list, which said THAT rent was unattributed and
        // never HOW MUCH.
        mockDb.parcel.findMany.mockResolvedValue([parcel('parcel-idle', 10)]);
        mockDb.parcelLease.findMany.mockResolvedValue([
            {
                id: 'lease-1',
                parcelId: 'parcel-idle',
                rentAmount: 5,
                rentUnit: 'лв/дка',
                rentUnitRaw: null,
                parcel: { areaHa: 10 },
            },
        ]);

        const result = await netWorthResult(ctx);

        // 5 лв/дка × 10 дка/ха × 10 ха = 500.
        expect(result.unallocatedToCrop.amount).toBe(500);
        expect(result.unallocatedToCrop.currencies).toEqual(['UNKNOWN']);
        expect(result.exclusions.leasesUnattributed.map((e) => e.id)).toEqual(['lease-1']);
    });
});

describe('allocation basis — a chosen subset of parcels', () => {
    it('spreads over exactly the chosen parcels, and no others', async () => {
        mockDb.parcel.findMany.mockResolvedValue([
            parcel('parcel-a', 1),
            parcel('parcel-b', 1),
            parcel('parcel-untouched', 1),
        ]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-a', parcelId: 'parcel-a', areaM2: 10_000 }),
            planting({
                id: 'plant-b',
                parcelId: 'parcel-b',
                areaM2: 10_000,
                cropPlan: { seasonId: 's-1', cropType: { commodityCanonical: 'maize' } },
            }),
            planting({
                id: 'plant-untouched',
                parcelId: 'parcel-untouched',
                areaM2: 10_000,
                cropPlan: { seasonId: 's-1', cropType: { commodityCanonical: 'barley' } },
            }),
        ]);
        mockDb.costEntryAllocationParcel.findMany.mockResolvedValue([
            { costEntryId: 'pay-1', parcelId: 'parcel-a' },
            { costEntryId: 'pay-1', parcelId: 'parcel-b' },
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([payroll({ allocationBasis: 'PARCEL_SUBSET' })]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat', 'maize', 'barley']));

        const result = await netWorthResult(ctx);

        expect(result.rows.find((r) => r.commodity === 'wheat')!.payrollCost).toBe(50);
        expect(result.rows.find((r) => r.commodity === 'maize')!.payrollCost).toBe(50);
        expect(result.rows.find((r) => r.commodity === 'barley')!.payrollCost).toBe(0);
        expect(allocatedCents(result)).toBe(10_000);
    });

    it('reports an entry whose chosen parcels have all gone rather than allocating to nothing', async () => {
        // A subset whose parcels were deleted resolves to no land. Reading
        // that as an allocation would silently drop the cost; it is named
        // in the same list an unattributable payroll row has always used.
        mockDb.parcel.findMany.mockResolvedValue([parcel('parcel-live', 1)]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-live', parcelId: 'parcel-live', areaM2: 10_000 }),
        ]);
        mockDb.costEntryAllocationParcel.findMany.mockResolvedValue([
            { costEntryId: 'pay-1', parcelId: 'parcel-deleted' },
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([payroll({ allocationBasis: 'PARCEL_SUBSET' })]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat']));

        const result = await netWorthResult(ctx);

        expect(result.rows[0].payrollCost).toBe(0);
        expect(result.exclusions.payrollUnattributable.map((e) => e.id)).toEqual(['pay-1']);
    });
});

describe('allocation basis — existing rows keep their meaning', () => {
    it('allocates a TARGET row exactly as it did before the column existed', async () => {
        // The migration test. A row written before `allocationBasis`
        // reads as TARGET (the column default), and a row whose basis the
        // projection never saw must behave identically — otherwise every
        // historical figure moves on deploy. Parcels are present and
        // deliberately weighted so that a HOLDING reading would differ.
        const fixture = () => {
            mockDb.parcel.findMany.mockResolvedValue([
                parcel('parcel-big', 9),
                parcel('parcel-small', 1),
            ]);
            mockDb.planting.findMany.mockResolvedValue([
                planting({ id: 'plant-a', parcelId: 'parcel-small', areaM2: 10_000 }),
                planting({
                    id: 'plant-b',
                    parcelId: 'parcel-big',
                    areaM2: 10_000,
                    cropPlan: { seasonId: 's-1', cropType: { commodityCanonical: 'maize' } },
                }),
            ]);
            mockGetMarketReferences.mockResolvedValue(priced(['wheat', 'maize']));
        };

        resetMocks();
        fixture();
        mockDb.costEntry.findMany.mockResolvedValue([payroll({ allocationBasis: 'TARGET' })]);
        const explicit = await netWorthResult(ctx);

        resetMocks();
        fixture();
        // A projection with no basis column at all — the pre-migration shape.
        mockDb.costEntry.findMany.mockResolvedValue([payroll({ allocationBasis: undefined })]);
        const legacy = await netWorthResult(ctx);

        // Pro-rata by PLANTING area, both equal ⇒ 50/50, and the 9-ha
        // parcel's weight is nowhere in it.
        for (const result of [explicit, legacy]) {
            expect(result.rows.find((r) => r.commodity === 'wheat')!.payrollCost).toBe(50);
            expect(result.rows.find((r) => r.commodity === 'maize')!.payrollCost).toBe(50);
            expect(result.unallocatedToCrop.amount).toBe(0);
        }
    });

    it('keeps honouring a direct plantingId link under TARGET', async () => {
        mockDb.parcel.findMany.mockResolvedValue([parcel('parcel-a', 1), parcel('parcel-b', 1)]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-a', parcelId: 'parcel-a', areaM2: 10_000 }),
            planting({
                id: 'plant-b',
                parcelId: 'parcel-b',
                areaM2: 10_000,
                cropPlan: { seasonId: 's-1', cropType: { commodityCanonical: 'maize' } },
            }),
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([payroll({ plantingId: 'plant-a' })]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat', 'maize']));

        const result = await netWorthResult(ctx);

        expect(result.rows.find((r) => r.commodity === 'wheat')!.payrollCost).toBe(100);
        expect(result.rows.find((r) => r.commodity === 'maize')!.payrollCost).toBe(0);
        // A direct link is a MEASUREMENT, not an apportionment.
        expect(result.rows.find((r) => r.commodity === 'wheat')!.payrollAllocated).toBe(false);
    });
});

describe('allocation basis — a spread share says it is allocated', () => {
    it('marks a HOLDING spread ALLOCATED in the shared uncertainty vocabulary', async () => {
        mockDb.parcel.findMany.mockResolvedValue([parcel('parcel-a', 1)]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-a', parcelId: 'parcel-a', areaM2: 10_000 }),
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([payroll({ allocationBasis: 'HOLDING' })]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat']));

        const result = await netWorthResult(ctx);
        const wheat = result.rows[0];

        expect(wheat.payrollAllocated).toBe(true);
        // The SAME word payroll's own pro-rata share already carries — a
        // spread cost must never read as a measurement.
        expect(costUncertainty(wheat)).toBe('allocated');
    });
});

describe('imputed land charge — beside the cash cost, never inside it', () => {
    function ownedAndLeased() {
        mockDb.parcel.findMany.mockResolvedValue([parcel('parcel-owned', 10), parcel('parcel-leased', 10)]);
        mockDb.parcelLease.findMany.mockResolvedValue([
            {
                id: 'lease-1',
                parcelId: 'parcel-leased',
                rentAmount: 5, // 5 лв/дка ⇒ 50 лв/ха
                rentUnit: 'лв/дка',
                rentUnitRaw: null,
                parcel: { areaHa: 10 },
            },
        ]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-owned', parcelId: 'parcel-owned', areaM2: 100_000 }),
            planting({ id: 'plant-leased', parcelId: 'parcel-leased', areaM2: 100_000 }),
        ]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat']));
    }

    it('prices owned land at the rate the farm\'s own leases establish', async () => {
        ownedAndLeased();

        const result = await netWorthResult(ctx);
        const wheat = result.rows[0];

        expect(result.imputedLandCharge).toEqual({
            perHa: 50,
            areaHa: 10,
            totalAmount: 500,
            refusalCode: null,
        });
        expect(wheat.imputedLandCharge).toBe(500);
        expect(wheat.imputedLandChargeAreaHa).toBe(10);
        expect(wheat.imputedLandChargePerHa).toBe(50);
    });

    it('does NOT enter cashCostTotal, and does not move net worth', async () => {
        // No new named metric was registered INSIDE the cost side, so the
        // three printed slices must still be the whole of the printed
        // total. `assertNetWorthInvariants` asserts the composition for
        // every row already; this states the consequence in one place.
        ownedAndLeased();

        const result = await netWorthResult(ctx);
        const wheat = result.rows[0];

        // Only the real lease is cash: 50 лв/ха × 10 ха = 500. The farm
        // also owns 10 ha worth another 500 in opportunity cost, and the
        // total stays 500 — not 1000.
        expect(wheat.rentCostMoneyAmount).toBe(500);
        expect(wheat.cashCostTotal).toBe(500);
        expect(wheat.imputedLandCharge).toBe(500);
        expect(wheat.cashCostTotal).toBe(
            Math.round((wheat.attributedCropCost + wheat.rentCostMoneyAmount + wheat.payrollCost) * 100) / 100,
        );
    });

    it('does not enter netWorth either', async () => {
        // Same rate, but the leased parcel carries no crop, so no rent
        // lands on the row and net worth is computable. The imputed charge
        // is 500 and the net is the asset position minus a cash cost of
        // zero — the charge is beside the arithmetic, not in it.
        mockDb.parcel.findMany.mockResolvedValue([parcel('parcel-owned', 10), parcel('parcel-idle', 10)]);
        mockDb.parcelLease.findMany.mockResolvedValue([
            {
                id: 'lease-1',
                parcelId: 'parcel-idle',
                rentAmount: 5,
                rentUnit: 'лв/дка',
                rentUnitRaw: null,
                parcel: { areaHa: 10 },
            },
        ]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-owned', parcelId: 'parcel-owned', areaM2: 100_000 }),
        ]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat']));

        const result = await netWorthResult(ctx);
        const wheat = result.rows[0];

        expect(wheat.imputedLandCharge).toBe(500);
        expect(wheat.cashCostTotal).toBe(0);
        expect(wheat.netWorth).toBe(wheat.netAssetPosition);
    });

    it('refuses, rather than zeroing, when the farm has no money lease to observe', async () => {
        // A zero would say owned land is free, which is the whole defect.
        mockDb.parcel.findMany.mockResolvedValue([parcel('parcel-owned', 10)]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-owned', parcelId: 'parcel-owned', areaM2: 100_000 }),
        ]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat']));

        const result = await netWorthResult(ctx);

        expect(result.rows[0].imputedLandCharge).toBeNull();
        expect(result.rows[0].imputedLandChargeRefusalCode).toBe('NO_OBSERVED_RENT_RATE');
        expect(result.imputedLandCharge.refusalCode).toBe('NO_OBSERVED_RENT_RATE');
        expect(result.imputedLandCharge.totalAmount).toBeNull();
    });

    it('ignores produce rent when observing a rate', async () => {
        // кг/дка priced into money needs a grain price, which would make
        // the opportunity cost of a field move with this week's market.
        mockDb.parcel.findMany.mockResolvedValue([parcel('parcel-owned', 10), parcel('parcel-leased', 10)]);
        mockDb.parcelLease.findMany.mockResolvedValue([
            {
                id: 'lease-produce',
                parcelId: 'parcel-leased',
                rentAmount: 60,
                rentUnit: 'кг/дка',
                rentUnitRaw: null,
                parcel: { areaHa: 10 },
            },
        ]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-owned', parcelId: 'parcel-owned', areaM2: 100_000 }),
        ]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat']));

        const result = await netWorthResult(ctx);

        expect(result.imputedLandCharge.perHa).toBeNull();
        expect(result.rows[0].imputedLandChargeRefusalCode).toBe('NO_OBSERVED_RENT_RATE');
    });

    it('charges nothing for a crop grown entirely on leased land', async () => {
        // Leased land already carries real rent; imputing on top would
        // bill the same hectare twice.
        mockDb.parcel.findMany.mockResolvedValue([parcel('parcel-leased', 10)]);
        mockDb.parcelLease.findMany.mockResolvedValue([
            {
                id: 'lease-1',
                parcelId: 'parcel-leased',
                rentAmount: 5,
                rentUnit: 'лв/дка',
                rentUnitRaw: null,
                parcel: { areaHa: 10 },
            },
        ]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-leased', parcelId: 'parcel-leased', areaM2: 100_000 }),
        ]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat']));

        const result = await netWorthResult(ctx);

        expect(result.rows[0].imputedLandChargeAreaHa).toBe(0);
        expect(result.rows[0].imputedLandCharge).toBe(0);
        expect(result.rows[0].imputedLandChargeRefusalCode).toBeNull();
    });
});

describe('allocation basis — query shape', () => {
    it('reads the land once, and the chosen parcels in ONE batched call', async () => {
        // D1 bans a read inside a loop. Two entries with different subsets
        // must still be one `costEntryId IN (…)` read, not one per entry.
        mockDb.parcel.findMany.mockResolvedValue([parcel('parcel-a', 1), parcel('parcel-b', 1)]);
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'plant-a', parcelId: 'parcel-a', areaM2: 10_000 }),
            planting({ id: 'plant-b', parcelId: 'parcel-b', areaM2: 10_000 }),
        ]);
        mockDb.costEntryAllocationParcel.findMany.mockResolvedValue([
            { costEntryId: 'pay-1', parcelId: 'parcel-a' },
            { costEntryId: 'pay-2', parcelId: 'parcel-b' },
        ]);
        mockDb.costEntry.findMany.mockResolvedValue([
            payroll({ id: 'pay-1', allocationBasis: 'PARCEL_SUBSET' }),
            payroll({ id: 'pay-2', allocationBasis: 'PARCEL_SUBSET' }),
        ]);
        mockGetMarketReferences.mockResolvedValue(priced(['wheat']));

        await netWorthResult(ctx);

        expect(mockDb.parcel.findMany).toHaveBeenCalledTimes(1);
        expect(mockDb.costEntryAllocationParcel.findMany).toHaveBeenCalledTimes(1);
        expect(mockDb.costEntryAllocationParcel.findMany.mock.calls[0][0].where.costEntryId).toEqual({
            in: ['pay-1', 'pay-2'],
        });
    });

    it('does not read allocation parcels at all when no entry chose a subset', async () => {
        mockDb.costEntry.findMany.mockResolvedValue([payroll({ allocationBasis: 'HOLDING' })]);
        await netWorthResult(ctx);
        expect(mockDb.costEntryAllocationParcel.findMany).not.toHaveBeenCalled();
    });

    it('bounds both new reads and discloses truncation', async () => {
        // A truncated parcel page silently shrinks an allocation's
        // denominator. It has to reach the same disclosure every other
        // capped read does.
        mockDb.parcel.findMany.mockResolvedValue(
            Array.from({ length: 5001 }, (_, i) => parcel(`parcel-${i}`, 1)),
        );

        const result = await netWorthResult(ctx);

        expect(mockDb.parcel.findMany.mock.calls[0][0].take).toBe(5001);
        expect(result.truncated).toBe(true);
    });
});
