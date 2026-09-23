/**
 * `buildCalculatorPayload` — the ONE mapper behind both the calculator page
 * and `GET /api/t/:slug/grain/calculator`.
 *
 * It was extracted from `grain/calculator/page.tsx` when the native client
 * needed the same answer over HTTP. The point of the extraction is that the
 * two consumers cannot describe the calculator differently, so the property
 * worth pinning is not "the numbers are right" — the usecase owns those — but
 * that what crosses the wire is EXACTLY what crosses the RSC boundary.
 *
 * Hence the round-trip test: a Date or a Decimal reaching this payload would
 * serialise for the page (React handles it) and mutate or throw for the route.
 * That is a divergence no type checks, because both sides share the type.
 */
import { buildCalculatorPayload, toCalculatorRow } from '@/lib/grain/calculator-payload';
import { UNKNOWN_RENT_CURRENCY } from '@/lib/grain/cost-metrics';
import type {
    CommodityNetWorthRow,
    GrainNetWorthResult,
} from '@/app-layer/usecases/grain-net-worth';

function row(over: Partial<CommodityNetWorthRow> = {}): CommodityNetWorthRow {
    return {
        commodity: 'WHEAT',
        pricePerTonne: 420,
        priceCurrency: 'BGN',
        priceObservedAt: '2026-09-01T00:00:00.000Z',
        priceSource: 'market',
        standingCropAreaHa: 12,
        standingCropExpectedKg: 60_000,
        standingCropPlantingIds: ['p1'],
        standingCropValue: 25_200,
        perArea: {
            areaDca: 120,
            standingValuePerDca: 210,
            attributableCostPerDca: 90,
            marginPerDca: 120,
            uncertainty: 'EXACT',
            refusalCode: null,
        },
        breakEven: {
            breakEvenPricePerTonne: 180,
            marketPricePerTonne: 420,
            currency: 'BGN',
            coverPercent: 233,
            covered: true,
            uncertainty: 'EXACT',
            refusalCode: null,
        },
        grainOnHandTonnes: 4,
        grainOnHandLotIds: ['l1'],
        grainOnHandValue: 1_680,
        attributedCropCost: 800,
        attributedCropCostCurrencies: ['BGN'],
        attributedCropCostCurrencyMixed: false,
        rentCostMoneyAmount: 300,
        rentCostProduceKg: 0,
        rentCostProduceValue: null,
        payrollCost: 150,
        payrollCostCurrencies: ['BGN'],
        payrollCostCurrencyMixed: false,
        payrollAllocated: true,
        cashCostTotal: 1_250,
        cashCostCurrencies: ['BGN'],
        cashCostCurrencyMixed: false,
        imputedLandCharge: null,
        imputedLandChargeAreaHa: 0,
        imputedLandChargePerHa: null,
        imputedLandChargeRefusalCode: null,
        ...over,
    } as CommodityNetWorthRow;
}

function result(rows: CommodityNetWorthRow[]): GrainNetWorthResult {
    return {
        generatedAt: '2026-09-21T10:00:00.000Z',
        seasonId: 's1',
        rows,
        farm: { totals: [], refusedWithoutCurrency: [] },
        exclusions: {
            plantingsMissingYieldEstimate: [],
            plantingsUnknownCommodity: [],
            lotsUnresolvedUnit: [],
            lotsUnknownCommodity: [],
            commoditiesWithNoPrice: [],
            leasesUnresolvedRent: [],
            leasesUnattributed: [],
            leasesProduceRentUnpriced: [],
            payrollUnattributable: [],
        },
        unvalued: { noUnitCost: 0, unitMismatch: 0 },
        cashOut: [],
        unallocatedToCrop: { amount: 0, areaHa: 0, parcelIds: [], currencies: [] },
        imputedLandCharge: { perHa: null, areaHa: 0, totalAmount: null, refusalCode: null },
        truncated: false,
    } as unknown as GrainNetWorthResult;
}

/**
 * Every leaf, so a non-primitive cannot hide inside a nested object.
 *
 * Only PLAIN objects and arrays are walked into. Anything else — a Date, a
 * Decimal, any class instance — is a leaf, and therefore visible as an
 * offender below.
 *
 * That distinction is the whole test. The first version recursed on anything
 * `typeof 'object'`, and `Object.entries(new Date())` is `[]` — so a Date
 * produced ZERO leaves and the check written to catch a Date could not see
 * one. A mutation that planted a Date in the payload left this test GREEN;
 * only the round-trip test caught it. A walker that skips what it is hunting
 * certifies nothing.
 */
function leaves(value: unknown, path = '$'): Array<[string, unknown]> {
    if (value === null || typeof value !== 'object') return [[path, value]];
    if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, `${path}[${i}]`));
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return [[path, value]];
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
        leaves(v, `${path}.${k}`),
    );
}

describe('buildCalculatorPayload', () => {
    it('survives a JSON round-trip unchanged — the page and the route serve one payload', () => {
        const payload = buildCalculatorPayload(result([row()]));
        expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    });

    it('carries no Date, Decimal or other non-primitive leaf', () => {
        const payload = buildCalculatorPayload(result([row()]));
        const offenders = leaves(payload).filter(
            ([, v]) => v !== null && typeof v === 'object',
        );
        // Named, not counted — a failure should say WHICH field broke the
        // guarantee rather than that some field did.
        expect(offenders.map(([p]) => p)).toEqual([]);
    });

    it('filters the internal rent sentinel out of the currency list, and says so separately', () => {
        const withSentinel = toCalculatorRow(
            row({ cashCostCurrencies: ['BGN', UNKNOWN_RENT_CURRENCY] }),
        );
        expect(withSentinel.costCurrencyCodes).toEqual(['BGN']);
        expect(withSentinel.rentCurrencyUnknown).toBe(true);

        const clean = toCalculatorRow(row({ cashCostCurrencies: ['BGN'] }));
        expect(clean.costCurrencyCodes).toEqual(['BGN']);
        expect(clean.rentCurrencyUnknown).toBe(false);
    });

    it('states the rent-in-grain term only when the farm has one', () => {
        // A rent line reading "− 0 kg" states a term the farm does not have.
        expect(toCalculatorRow(row({ rentCostProduceKg: 0 })).showProduceRent).toBe(false);
        expect(toCalculatorRow(row({ rentCostProduceKg: 500 })).showProduceRent).toBe(true);
    });

    it('decides the cost composition server-side — three slices, in order', () => {
        const slices = toCalculatorRow(row()).costBreakdown;
        expect(slices.map((s) => s.id)).toEqual(['field', 'rent', 'payroll']);
        expect(slices.map((s) => s.value)).toEqual([800, 300, 150]);
    });

    it('keeps every top-level key the consumers read', () => {
        const payload = buildCalculatorPayload(result([row()]));
        expect(Object.keys(payload).sort()).toEqual(
            [
                'cashOut',
                'exclusions',
                'farm',
                'generatedAt',
                'imputedLandCharge',
                'rows',
                'seasonId',
                'truncated',
                'unallocatedToCrop',
                'unvalued',
            ].sort(),
        );
    });
});
