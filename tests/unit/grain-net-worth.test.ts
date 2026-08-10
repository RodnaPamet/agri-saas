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
    payrollExpense: { findMany: jest.fn() },
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

function resetMocks() {
    jest.clearAllMocks();
    mockDb.planting.findMany.mockResolvedValue([]);
    mockDb.inventoryLot.findMany.mockResolvedValue([]);
    mockDb.unit.findMany.mockResolvedValue([]);
    mockDb.parcelLease.findMany.mockResolvedValue([]);
    mockDb.payrollExpense.findMany.mockResolvedValue([]);
    mockGetCostRollupByPlanting.mockResolvedValue({ rows: [], truncated: false });
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

        const result = await getGrainNetWorth(ctx);

        expect(result.rows).toHaveLength(1);
        const wheat = result.rows[0];
        expect(wheat.commodity).toBe('wheat');
        expect(wheat.standingCropExpectedKg).toBe(4000);
        expect(wheat.standingCropAreaHa).toBe(1);
        expect(wheat.standingCropPlantingIds).toEqual(['p-1']);
        // 4000 kg = 4 t × 300 BGN/t = 1200
        expect(wheat.standingCropValue).toBe(1200);
        expect(result.exclusions.plantingsMissingYieldEstimate).toEqual(['p-2']);
    });

    it('excludes a planting whose crop has no canonical commodity, naming it', async () => {
        mockDb.planting.findMany.mockResolvedValue([
            planting({ id: 'p-3', cropPlan: { seasonId: 's-1', cropType: { commodityCanonical: null } } }),
        ]);

        const result = await getGrainNetWorth(ctx);

        expect(result.rows).toEqual([]);
        expect(result.exclusions.plantingsUnknownCommodity).toEqual(['p-3']);
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

        const result = await getGrainNetWorth(ctx);

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

        const result = await getGrainNetWorth(ctx);

        expect(result.rows).toEqual([]);
        expect(result.exclusions.lotsUnresolvedUnit).toEqual(
            expect.arrayContaining([
                { lotId: 'lot-3', unitKey: 'each' },
                { lotId: 'lot-4', unitKey: null },
            ]),
        );
    });

    it('excludes a HARVESTED_PRODUCE lot whose item name names no canonical commodity', async () => {
        mockDb.inventoryLot.findMany.mockResolvedValue([
            { id: 'lot-5', quantityOnHand: 100, unitId: 'u-kg', item: { name: 'Some Unrecognised Grain' } },
        ]);
        mockDb.unit.findMany.mockResolvedValue([{ id: 'u-kg', key: 'kg' }]);

        const result = await getGrainNetWorth(ctx);

        expect(result.rows).toEqual([]);
        expect(result.exclusions.lotsUnknownCommodity).toEqual(['lot-5']);
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
                { plantingId: 'p-1', totalCost: 1000, currencies: ['BGN'], currencyMixed: false },
                { plantingId: 'p-2', totalCost: 500, currencies: ['EUR'], currencyMixed: false },
            ],
            truncated: false,
        });

        const result = await getGrainNetWorth(ctx);

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
            rows: [{ plantingId: 'p-orphan', totalCost: 50, currencies: ['BGN'], currencyMixed: false }],
            truncated: false,
        });

        const result = await getGrainNetWorth(ctx);

        expect(result.rows).toEqual([]);
        expect(result.exclusions.plantingsUnknownCommodity).toEqual(['p-orphan']);
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

        const result = await getGrainNetWorth(ctx);

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

        const result = await getGrainNetWorth(ctx);

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

        const result = await getGrainNetWorth(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        expect(wheat.rentCostProduceKg).toBe(500);
        expect(wheat.rentCostProduceValue).toBeNull();
        expect(result.exclusions.leasesProduceRentUnpriced).toEqual(['lease-2']);
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

        const result = await getGrainNetWorth(ctx);

        expect(result.exclusions.leasesUnresolvedRent).toHaveLength(1);
        expect(result.exclusions.leasesUnresolvedRent[0].leaseId).toBe('lease-3');
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

        const result = await getGrainNetWorth(ctx);

        expect(result.exclusions.leasesUnattributed).toEqual(['lease-4']);
    });
});

describe('getGrainNetWorth — payroll allocation', () => {
    it('attributes a directly-linked row without setting payrollAllocated', async () => {
        mockDb.planting.findMany.mockResolvedValue([planting({ id: 'p-1' })]);
        mockDb.payrollExpense.findMany.mockResolvedValue([
            { id: 'pay-1', amount: 200, currency: 'BGN', plantingId: 'p-1', seasonId: null },
        ]);

        const result = await getGrainNetWorth(ctx);

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
        mockDb.payrollExpense.findMany.mockResolvedValue([
            { id: 'pay-2', amount: 300, currency: 'BGN', plantingId: null, seasonId: 's-1' },
            { id: 'pay-3', amount: 60, currency: 'EUR', plantingId: null, seasonId: 's-1' },
        ]);

        const result = await getGrainNetWorth(ctx);

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
        mockDb.payrollExpense.findMany.mockResolvedValue([
            { id: 'pay-4', amount: 15, currency: 'BGN', plantingId: null, seasonId: 'season-with-no-plantings' },
        ]);

        const result = await getGrainNetWorth(ctx);

        expect(result.exclusions.payrollUnattributable).toEqual(['pay-4']);
    });

    it('names a directly-linked row whose planting has no resolvable commodity', async () => {
        mockDb.payrollExpense.findMany.mockResolvedValue([
            { id: 'pay-5', amount: 10, currency: 'BGN', plantingId: 'p-missing', seasonId: null },
        ]);

        const result = await getGrainNetWorth(ctx);

        expect(result.exclusions.payrollUnattributable).toEqual(['pay-5']);
        expect(result.exclusions.plantingsUnknownCommodity).toEqual(['p-missing']);
    });
});

describe('getGrainNetWorth — currency handling and net worth', () => {
    it('computes a real net worth figure when cash costs share a single currency matching the price currency', async () => {
        mockDb.planting.findMany.mockResolvedValue([planting({ id: 'p-1', areaM2: 10_000, plannedYieldKgPerHa: 3000 })]);
        mockGetCostRollupByPlanting.mockResolvedValue({ rows: [], truncated: false });
        mockDb.payrollExpense.findMany.mockResolvedValue([
            { id: 'pay-1', amount: 100, currency: 'BGN', plantingId: 'p-1', seasonId: null },
        ]);
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 250, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await getGrainNetWorth(ctx);

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
            rows: [{ plantingId: 'p-1', totalCost: 100, currencies: ['EUR'], currencyMixed: false }],
            truncated: false,
        });
        mockGetMarketReferences.mockResolvedValue(
            new Map([['wheat', { commodity: 'wheat', pricePerTonne: 250, currency: 'BGN', observedAt: '2026-01-01', source: 'ec-agrifood' }]]),
        );

        const result = await getGrainNetWorth(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        expect(wheat.netWorth).toBeNull();
        expect(wheat.netWorthUnavailableReason).toMatch(/EUR/);
        expect(wheat.netWorthUnavailableReason).toMatch(/BGN/);
    });

    it('names a commodity touched by the calculation with no market price at all', async () => {
        mockDb.planting.findMany.mockResolvedValue([planting({ id: 'p-1', plannedYieldKgPerHa: 3000 })]);
        // No market reference registered for wheat.

        const result = await getGrainNetWorth(ctx);

        const wheat = result.rows.find((r) => r.commodity === 'wheat')!;
        expect(wheat.standingCropValue).toBeNull();
        expect(wheat.netWorth).toBeNull();
        expect(wheat.netWorthUnavailableReason).toContain('wheat');
        expect(result.exclusions.commoditiesWithNoPrice).toEqual(['wheat']);
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
        mockDb.payrollExpense.findMany.mockResolvedValue([
            { id: 'pay-1', amount: 40, currency: 'BGN', plantingId: 'p-1', seasonId: null },
        ]);
        const rollupRows = [{ plantingId: 'p-1', totalCost: 100, currencies: ['BGN'], currencyMixed: false }];
        mockGetCostRollupByPlanting.mockResolvedValue({ rows: rollupRows, truncated: false });

        const result = await getGrainNetWorth(ctx, { seasonId: 's-1' });

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
        const rollupRows = [{ plantingId: 'p-1', totalCost: 100, currencies: ['BGN'], currencyMixed: false }];
        mockGetCostRollupByPlanting.mockResolvedValue({ rows: rollupRows, truncated: false });

        const result = await getGrainNetWorth(ctx);

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
        const result = await getGrainNetWorth(ctx);
        expect(result.truncated).toBe(true);
    });

    it('every batched findMany is bounded with take', async () => {
        await getGrainNetWorth(ctx);
        for (const call of mockDb.planting.findMany.mock.calls) expect(call[0].take).toBeGreaterThan(0);
        for (const call of mockDb.inventoryLot.findMany.mock.calls) expect(call[0].take).toBeGreaterThan(0);
        for (const call of mockDb.parcelLease.findMany.mock.calls) expect(call[0].take).toBeGreaterThan(0);
        for (const call of mockDb.payrollExpense.findMany.mock.calls) expect(call[0].take).toBeGreaterThan(0);
    });
});
