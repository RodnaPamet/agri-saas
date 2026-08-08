/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Machinery depreciation — the cost basis behind `Asset.purchaseCost`.
 *
 * The two rules under test are the ones that keep the /costs page
 * honest, and both are the kind that a "simplifying" refactor quietly
 * breaks:
 *
 *   1. A tenant on DepreciationMethod.NONE gets NO rows, not zeroes.
 *      "We do not compute this" and "this costs nothing" must not
 *      render identically.
 *   2. An asset with a purchase cost but no useful life has no
 *      denominator, so it is UNALLOCATED, not a zero charge. Silently
 *      dropping it would understate the total — the same defect class
 *      as `stockCost` being structurally always 0.
 */

const mockDb = {
    tenant: { findUnique: jest.fn() },
    asset: { findMany: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

import { getMachineryDepreciation } from '@/app-layer/usecases/machinery-depreciation';
import { makeRequestContext } from '../helpers/make-context';

const NOW = new Date('2026-08-08T00:00:00.000Z');

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.tenant.findUnique.mockResolvedValue({ depreciationMethod: 'STRAIGHT_LINE' });
    mockDb.asset.findMany.mockResolvedValue([]);
});

const ctx = () => makeRequestContext('READER');

describe('getMachineryDepreciation', () => {
    it('returns NO charges — not zeroes — when the tenant opted out', async () => {
        mockDb.tenant.findUnique.mockResolvedValue({ depreciationMethod: 'NONE' });
        // Assets exist and carry cost; the point is they must not be charged.
        mockDb.asset.findMany.mockResolvedValue([
            { id: 'a1', key: 'AST-1', name: 'Tractor', purchaseCost: 100000, purchaseDate: null, usefulLifeYears: 10 },
        ]);

        const result = await getMachineryDepreciation(ctx(), { now: NOW });

        expect(result.method).toBe('NONE');
        expect(result.charges).toEqual([]);
        expect(result.totalAnnualCharge).toBe(0);
        // It must not even read the register — opting out means not computed.
        expect(mockDb.asset.findMany).not.toHaveBeenCalled();
    });

    it('charges cost ÷ useful life, straight-line', async () => {
        mockDb.asset.findMany.mockResolvedValue([
            {
                id: 'a1', key: 'AST-1', name: 'Combine',
                purchaseCost: 120000, purchaseDate: new Date('2020-08-08T00:00:00.000Z'),
                usefulLifeYears: 10,
            },
        ]);

        const { charges, totalAnnualCharge } = await getMachineryDepreciation(ctx(), { now: NOW });

        expect(charges).toHaveLength(1);
        expect(charges[0].annualCharge).toBe(12000);
        expect(charges[0].yearsElapsed).toBe(6);
        expect(charges[0].remainingValue).toBe(120000 - 12000 * 6);
        expect(charges[0].fullyDepreciated).toBe(false);
        expect(totalAnnualCharge).toBe(12000);
    });

    it('reports an asset with no useful life as UNALLOCATED, never as a zero charge', async () => {
        mockDb.asset.findMany.mockResolvedValue([
            { id: 'a1', key: 'AST-1', name: 'Sprayer', purchaseCost: 45000, purchaseDate: null, usefulLifeYears: null },
        ]);

        const result = await getMachineryDepreciation(ctx(), { now: NOW });

        expect(result.charges).toEqual([]);
        expect(result.unallocated).toEqual([
            { assetId: 'a1', assetKey: 'AST-1', assetName: 'Sprayer', purchaseCost: 45000, reason: 'NO_USEFUL_LIFE' },
        ]);
        // The value is surfaced so the UI can say what is NOT represented.
        expect(result.unallocatedCost).toBe(45000);
        expect(result.totalAnnualCharge).toBe(0);
    });

    it('treats usefulLifeYears: 0 as unallocated rather than dividing by zero', async () => {
        mockDb.asset.findMany.mockResolvedValue([
            { id: 'a1', key: null, name: 'Odd', purchaseCost: 1000, purchaseDate: null, usefulLifeYears: 0 },
        ]);

        const result = await getMachineryDepreciation(ctx(), { now: NOW });

        expect(result.charges).toEqual([]);
        expect(result.unallocated).toHaveLength(1);
        expect(Number.isFinite(result.totalAnnualCharge)).toBe(true);
    });

    it('caps elapsed years at the useful life and flags fully-depreciated', async () => {
        mockDb.asset.findMany.mockResolvedValue([
            {
                id: 'a1', key: 'AST-9', name: 'Old plough',
                purchaseCost: 10000, purchaseDate: new Date('2000-01-01T00:00:00.000Z'),
                usefulLifeYears: 5,
            },
        ]);

        const { charges } = await getMachineryDepreciation(ctx(), { now: NOW });

        expect(charges[0].yearsElapsed).toBe(5);
        // Never negative — a 26-year-old asset is written down, not owed for.
        expect(charges[0].remainingValue).toBe(0);
        expect(charges[0].fullyDepreciated).toBe(true);
    });

    it('leaves remainingValue unknown (null) when the purchase date is missing', async () => {
        mockDb.asset.findMany.mockResolvedValue([
            { id: 'a1', key: null, name: 'Undated', purchaseCost: 60000, purchaseDate: null, usefulLifeYears: 6 },
        ]);

        const { charges } = await getMachineryDepreciation(ctx(), { now: NOW });

        // The annual figure is knowable without a start date; how much
        // life is LEFT is not — and null says so, where 0 would lie.
        expect(charges[0].annualCharge).toBe(10000);
        expect(charges[0].yearsElapsed).toBeNull();
        expect(charges[0].remainingValue).toBeNull();
        expect(charges[0].fullyDepreciated).toBe(false);
    });

    it('mixes charged and unallocated assets in one pass', async () => {
        mockDb.asset.findMany.mockResolvedValue([
            { id: 'a1', key: 'AST-1', name: 'Tractor', purchaseCost: 100000, purchaseDate: null, usefulLifeYears: 10 },
            { id: 'a2', key: 'AST-2', name: 'Trailer', purchaseCost: 20000, purchaseDate: null, usefulLifeYears: null },
        ]);

        const result = await getMachineryDepreciation(ctx(), { now: NOW });

        expect(result.totalAnnualCharge).toBe(10000);
        expect(result.unallocatedCost).toBe(20000);
        expect(result.charges).toHaveLength(1);
        expect(result.unallocated).toHaveLength(1);
    });

    it('flags truncation instead of silently clipping the register', async () => {
        const many = Array.from({ length: 1001 }, (_, i) => ({
            id: `a${i}`, key: null, name: `M${i}`,
            purchaseCost: 1000, purchaseDate: null, usefulLifeYears: 10,
        }));
        mockDb.asset.findMany.mockResolvedValue(many);

        const result = await getMachineryDepreciation(ctx(), { now: NOW });

        expect(result.truncated).toBe(true);
        expect(result.charges).toHaveLength(1000);
    });
});
