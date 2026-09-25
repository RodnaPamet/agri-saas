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
import { CalculatorDataSchema } from '@/lib/dto/grain-calculator.dto';
import { UNKNOWN_RENT_CURRENCY } from '@/lib/grain/cost-metrics';
import type {
    CommodityNetWorthRow,
    GrainNetWorthResult,
} from '@/app-layer/usecases/grain-net-worth';

/**
 * The base row is annotated BEFORE the override spread, and that is load-bearing.
 *
 * `return { ...literals, ...over }` with `over: Partial<T>` types every shared
 * key from the PARTIAL, so a wrong literal default is masked — the property is
 * already `T[K]` by the time the return is checked. Measured here: this fixture
 * carried `uncertainty: 'EXACT'` for its whole life. The real vocabulary is
 * `UNCERTAINTY.EXACT === 'exact'`, the type is a union of the six lowercase
 * values, and `'EXACT'` is in none of them. tsc never said a word.
 *
 * There was a SECOND suppression stacked on it — the return carried
 * `as CommodityNetWorthRow`, which silences the same class of error on its own.
 * Either one alone would have hidden the wrong value; both together meant no
 * amount of typechecking could ever have found it.
 *
 * Naming the base with its type restores the check: the literals are validated
 * on their own, then overridden.
 */
function row(over: Partial<CommodityNetWorthRow> = {}): CommodityNetWorthRow {
    const base: CommodityNetWorthRow = {
        commodity: 'wheat',
        pricePerTonne: 420,
        priceCurrency: 'BGN',
        // A bare DAY, which is what `trends.ts` emits
        // (`latest.date.toISOString().slice(0, 10)`). The fixture carried a
        // full instant here until the schema declared the format — the third
        // value in this builder that had drifted from the real producer and
        // could not be seen, because a `string` field accepts any string.
        priceObservedAt: '2026-09-01',
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
            uncertainty: 'exact',
            refusalCode: null,
        },
        breakEven: {
            breakEvenPricePerTonne: 180,
            marketPricePerTonne: 420,
            currency: 'BGN',
            coverPercent: 233,
            covered: true,
            uncertainty: 'exact',
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

        // The whole net-worth block was ABSENT until the cast came off, so
        // every test here ran against a row whose `netWorth` was undefined —
        // which the vocabulary reads as null and reports as REFUSED. The
        // fixture was exercising the refusal path while reading as the happy
        // one. Values follow the row's own terms:
        //   netAssetPosition = standingCropValue + grainOnHandValue - rentCostProduceValue
        //   netWorth         = netAssetPosition - cashCostTotal
        unvaluedNoUnitCost: 0,
        unvaluedUnitMismatch: 0,
        netAssetPosition: 26_880,
        netWorth: 25_630,
        netWorthUnavailableReason: null,
        netWorthUnavailableCode: null,
        netWorthUnavailableParams: null,
    };
    return { ...base, ...over };
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
    } satisfies GrainNetWorthResult;
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

/**
 * The payload against its PUBLISHED schema.
 *
 * The docblock at the top of this file names the gap precisely: a divergence
 * between the two consumers is one "no type checks, because both sides share
 * the type". That is now also true of the schema — `CalculatorData` is
 * `z.infer` of `CalculatorDataSchema`, so the compiler already forbids the
 * mapper returning a different SHAPE.
 *
 * What the compiler still cannot see is VALUES, and that is what this covers: a
 * Date or a Decimal satisfies `z.infer`'s `string`/`number` at compile time
 * only because the mapper claims it does. Parsing the real output is what would
 * catch one arriving, and parsing it AFTER a JSON round-trip is what the route
 * actually hands a client.
 */
describe('the payload conforms to the schema the API publishes', () => {
    const overTheWire = (v: unknown) => JSON.parse(JSON.stringify(v));

    it('parses a real payload, strictly, after a JSON round trip', () => {
        const payload = buildCalculatorPayload(result([row()]));
        const parsed = CalculatorDataSchema.strict().safeParse(overTheWire(payload));
        if (!parsed.success) {
            throw new Error(`payload rejected:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
        }
    });

    it('parses a payload with NOTHING to report — the empty farm', () => {
        // The shape a brand-new tenant receives. Every array empty is a valid
        // answer, not a missing one, and a schema that only ever saw a
        // populated fixture would not say so.
        const parsed = CalculatorDataSchema.strict().safeParse(overTheWire(buildCalculatorPayload(result([]))));
        if (!parsed.success) {
            throw new Error(`empty payload rejected:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
        }
    });

    it('parses a refused row — the state the calculator exists to express', () => {
        // A row whose net worth cannot be computed still has to serialise:
        // the refusal, its code and its params are the payload's substance,
        // not an error path.
        const refused = row({ pricePerTonne: null, priceCurrency: null });
        const parsed = CalculatorDataSchema.strict().safeParse(
            overTheWire(buildCalculatorPayload(result([refused]))),
        );
        if (!parsed.success) {
            throw new Error(`refused row rejected:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
        }
    });

    it('rejects a Date or a Decimal reaching the payload', () => {
        // The failure this whole module exists to prevent, asserted from the
        // schema's side. A Date survives the page (React renders it) and
        // becomes a string for the route — two consumers, one type, different
        // answers. Here it fails loudly.
        const payload = buildCalculatorPayload(result([row()]));
        const poisoned = { ...payload, generatedAt: new Date() as unknown as string };
        expect(CalculatorDataSchema.safeParse(poisoned).success).toBe(false);
    });
});
