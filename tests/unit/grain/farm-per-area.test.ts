/**
 * `foldFarmPerArea` — the farm's per-decare rates (#2249).
 *
 * The arithmetic is the contract here, so these tests state numbers rather
 * than shapes. Three properties are worth the file on their own:
 *
 *   · the rates are AREA-WEIGHTED, not means of rates;
 *   · each entry's denominators are the ones it actually divided by, so
 *     multiplying back up lands on the numerator (#1512's rule, one level up);
 *   · currencies are never blended (#1614), including the case where one row's
 *     value and cost are in two different ones.
 */
import { foldFarmPerArea, type FarmPerAreaInput } from '@/lib/grain/farm-per-area';
import { computePerArea } from '@/lib/grain/per-area';
import { UNCERTAINTY } from '@/lib/grain/uncertainty';

function row(over: {
    commodity: string;
    priceCurrency?: string | null;
    areaDca?: number;
    costAreaDca?: number;
    standingValuePerDca?: number | null;
    attributableCostPerDca?: number | null;
    marginPerDca?: number | null;
    costCurrency?: string | null;
    unvaluedNoUnitCost?: number;
    unattributedCostEntries?: number;
    payrollAllocated?: boolean;
}): FarmPerAreaInput {
    const areaDca = over.areaDca ?? 100;
    // `=== undefined`, NOT `??`, for every nullable field. `null ?? 50` is 50,
    // so a `??` default silently rewrites the explicit nulls these tests use to
    // mean "this figure was refused" — three of them passed for that reason on
    // the first run, measuring a fixture rather than the fold.
    const or = <T,>(given: T | undefined, fallback: T): T =>
        given === undefined ? fallback : given;
    return {
        commodity: over.commodity,
        priceCurrency: or(over.priceCurrency, 'BGN'),
        perArea: {
            areaDca,
            costAreaDca: or(over.costAreaDca, areaDca),
            standingValuePerDca: or(over.standingValuePerDca, 50),
            attributableCostPerDca: or(over.attributableCostPerDca, 20),
            marginPerDca: or(over.marginPerDca, 30),
            costCurrency: or(over.costCurrency, 'BGN'),
        },
        unvaluedNoUnitCost: over.unvaluedNoUnitCost ?? 0,
        unvaluedUnitMismatch: 0,
        unattributedCostEntries: over.unattributedCostEntries ?? 0,
        payrollAllocated: over.payrollAllocated ?? false,
        netWorth: 1,
    };
}

describe('the rates are area-weighted', () => {
    it('weights by area rather than averaging the rates', () => {
        // The case the weighting exists for: a big block and a trial plot are
        // not two equal opinions about lv/dca. A plain mean would say 60.
        const out = foldFarmPerArea([
            row({ commodity: 'WHEAT', areaDca: 200, standingValuePerDca: 50 }),
            row({ commodity: 'BARLEY', areaDca: 3, standingValuePerDca: 700 }),
        ]);

        const bgn = out.byCurrency.find((c) => c.currency === 'BGN')!;
        // (50×200 + 700×3) / 203 = 12100/203 = 59.61, not (50+700)/2 = 375.
        expect(bgn.standingValuePerDca).toBe(59.61);
        expect(bgn.areaDca).toBe(203);
    });

    it('multiplying a rate back up by its OWN denominator lands on the numerator', () => {
        // #1512's rule one level up. This is the assertion that makes the two
        // denominators worth carrying: a client doing this must not be wrong.
        const out = foldFarmPerArea([
            row({ commodity: 'WHEAT', areaDca: 120, costAreaDca: 150, standingValuePerDca: 40, attributableCostPerDca: 10 }),
            row({ commodity: 'MAIZE', areaDca: 80, costAreaDca: 90, standingValuePerDca: 60, attributableCostPerDca: 30 }),
        ]);
        const bgn = out.byCurrency[0];

        // Value divides by the YIELD-covered area: 40×120 + 60×80 = 9600 over 200.
        expect(bgn.areaDca).toBe(200);
        expect(bgn.standingValuePerDca).toBe(48);
        expect(bgn.standingValuePerDca! * bgn.areaDca).toBe(9600);

        // Cost divides by OCCUPIED land: 10×150 + 30×90 = 4200 over 240.
        expect(bgn.costAreaDca).toBe(240);
        expect(bgn.attributableCostPerDca).toBe(17.5);
        expect(bgn.attributableCostPerDca! * bgn.costAreaDca).toBe(4200);
    });

    it("the farm's areaDca is every row's LAND, including rows with no rates at all", () => {
        // Deliberately not either rate's denominator. A farmer reads this as
        // the size of their farm, so a crop whose value was refused still
        // occupies its land.
        const out = foldFarmPerArea([
            row({ commodity: 'WHEAT', areaDca: 100, costAreaDca: 110 }),
            row({
                commodity: 'SUNFLOWER',
                areaDca: 0,
                costAreaDca: 40,
                standingValuePerDca: null,
                marginPerDca: null,
                attributableCostPerDca: null,
            }),
        ]);

        expect(out.areaDca).toBe(150);
        // …and that is NOT what the value rate divided by.
        expect(out.byCurrency[0].areaDca).toBe(100);
    });
});

describe('currencies are never blended (#1614)', () => {
    it('keeps two price currencies in separate entries', () => {
        const out = foldFarmPerArea([
            row({ commodity: 'WHEAT', priceCurrency: 'BGN', costCurrency: 'BGN', standingValuePerDca: 50 }),
            row({ commodity: 'MAIZE', priceCurrency: 'EUR', costCurrency: 'EUR', standingValuePerDca: 25 }),
        ]);

        expect(out.byCurrency).toHaveLength(2);
        expect(out.byCurrency.find((c) => c.currency === 'BGN')!.standingValuePerDca).toBe(50);
        expect(out.byCurrency.find((c) => c.currency === 'EUR')!.standingValuePerDca).toBe(25);
    });

    it('splits ONE row whose value and cost are in different currencies', () => {
        // The case that makes the two populations necessary rather than tidy:
        // the row's value belongs to BGN and its cost to EUR, and neither
        // entry may show the other's figure.
        const out = foldFarmPerArea([
            row({ commodity: 'WHEAT', priceCurrency: 'BGN', costCurrency: 'EUR' }),
        ]);

        const bgn = out.byCurrency.find((c) => c.currency === 'BGN')!;
        const eur = out.byCurrency.find((c) => c.currency === 'EUR')!;

        expect(bgn.standingValuePerDca).toBe(50);
        expect(bgn.attributableCostPerDca).toBeNull();
        expect(eur.attributableCostPerDca).toBe(20);
        expect(eur.standingValuePerDca).toBeNull();
        // And no margin anywhere: the two cannot be subtracted.
        expect(bgn.marginPerDca).toBeNull();
        expect(eur.marginPerDca).toBeNull();
    });

    it('a null COST currency is its own entry, meaning the display currency', () => {
        // Not a sentinel and not a refusal: PerAreaFigures documents null as
        // "use your tenant symbol", and net worth assumes the same.
        const out = foldFarmPerArea([
            row({ commodity: 'WHEAT', priceCurrency: null, costCurrency: null }),
        ]);

        expect(out.byCurrency).toHaveLength(1);
        expect(out.byCurrency[0].currency).toBeNull();
        expect(out.byCurrency[0].attributableCostPerDca).toBe(20);
    });

    it('a null PRICE currency contributes to no value entry and is named in no omission list', () => {
        // foldFarmTotals' rule, followed rather than re-decided: the row has no
        // market price, so it belongs to no bucket and the caller reports it
        // farm-wide. Naming it here would invent a second meaning for null.
        const out = foldFarmPerArea([
            row({ commodity: 'WHEAT', priceCurrency: 'BGN', costCurrency: 'BGN' }),
            row({ commodity: 'OATS', priceCurrency: null, costCurrency: 'BGN' }),
        ]);

        const bgn = out.byCurrency.find((c) => c.currency === 'BGN')!;
        expect(bgn.without.standingValuePerDca).toEqual([]);
        expect(bgn.without.marginPerDca).toEqual([]);
        // Its COST still counts — that figure has a currency.
        expect(bgn.costAreaDca).toBe(200);
    });
});

describe('the row level now guarantees what this fold used to check (#2259)', () => {
    it('excludes NOTHING that computePerArea admitted', () => {
        // The fold keeps explicit cost-currency checks as belt and braces. This
        // asserts they are no longer DOING anything: every row the row level
        // gave a margin to must survive the fold. A row appearing in
        // `without.marginPerDca` here would mean #2259 has regressed upstream,
        // which is the only way these checks could start mattering again.
        //
        // Built through the REAL computePerArea rather than hand-written
        // fixtures, because the point is the two modules agreeing.
        const inputs = [
            { costCurrencies: ['BGN'], priceCurrency: 'BGN' },
            { costCurrencies: [], priceCurrency: 'BGN' },
            { costCurrencies: ['BGN', 'EUR'], priceCurrency: 'BGN' },
            { costCurrencies: ['EUR'], priceCurrency: 'BGN' },
        ];
        const rows = inputs.map((over, i) => {
            const perArea = computePerArea({
                standingCropAreaHa: 12.5,
                occupiedAreaHa: 12.5,
                standingCropValue: 15_000,
                attributableCost: 5_000,
                standingCropExcludedCount: 0,
                unvaluedNoUnitCost: 0,
                unvaluedUnitMismatch: 0,
                unattributedCostEntries: 0,
                payrollAllocated: false,
                ...over,
            });
            return {
                commodity: `crop${i}`,
                priceCurrency: over.priceCurrency,
                perArea,
                unvaluedNoUnitCost: 0,
                unvaluedUnitMismatch: 0,
                unattributedCostEntries: 0,
                payrollAllocated: false,
                netWorth: 1,
            };
        });

        // A control: the four inputs really do split, so this is not a sweep
        // over four identical rows.
        const admitted = rows.filter((r) => r.perArea.marginPerDca != null).map((r) => r.commodity);
        expect(admitted).toEqual(['crop0', 'crop1']);

        const out = foldFarmPerArea(rows);
        for (const entry of out.byCurrency) {
            // Nothing the row level admitted is excluded here.
            expect(entry.without.marginPerDca.filter((c) => admitted.includes(c))).toEqual([]);
        }
    });
});

describe('the farm margin refuses to inherit #2259', () => {
    it('EXCLUDES a row whose cost rate was refused for mixed currencies, and names it', () => {
        // computePerArea publishes marginPerDca on such a row even though it
        // blended the currencies its own cost rate declined to blend (#2259).
        // Folding it in would put a figure denominated in nothing into the
        // farm's margin.
        const out = foldFarmPerArea([
            row({ commodity: 'WHEAT', areaDca: 100, marginPerDca: 30 }),
            row({
                commodity: 'SUNFLOWER',
                areaDca: 100,
                marginPerDca: 999,
                attributableCostPerDca: null,
                costCurrency: null,
            }),
        ]);

        const bgn = out.byCurrency.find((c) => c.currency === 'BGN')!;
        // 30, not (30+999)/2 — the blended row contributed nothing.
        expect(bgn.marginPerDca).toBe(30);
        expect(bgn.without.marginPerDca).toEqual(['SUNFLOWER']);
        // And the figure says it is short rather than reading as whole.
        expect(bgn.uncertainty).toBe(UNCERTAINTY.PARTIAL);
    });

    it('a null cost currency BESIDE a present cost rate still contributes', () => {
        // The agreement rule is deliberately lax here, matching net worth: a
        // present rate with a null currency is the tenant's own currency.
        const out = foldFarmPerArea([
            row({ commodity: 'WHEAT', priceCurrency: 'BGN', costCurrency: null, marginPerDca: 30 }),
        ]);

        const entry = out.byCurrency.find((c) => c.currency === 'BGN')!;
        expect(entry.marginPerDca).toBe(30);
        expect(entry.without.marginPerDca).toEqual([]);
    });
});

describe('the margin says what qualifies it', () => {
    it('atMost when a contributing row carries an unpriced cost', () => {
        const out = foldFarmPerArea([row({ commodity: 'WHEAT', unvaluedNoUnitCost: 1 })]);
        expect(out.byCurrency[0].uncertainty).toBe(UNCERTAINTY.AT_MOST);
    });

    it('atMost for an unattributed cost entry too (#1530)', () => {
        const out = foldFarmPerArea([row({ commodity: 'WHEAT', unattributedCostEntries: 2 })]);
        expect(out.byCurrency[0].uncertainty).toBe(UNCERTAINTY.AT_MOST);
    });

    it('allocated when payroll was spread and nothing is missing', () => {
        const out = foldFarmPerArea([row({ commodity: 'WHEAT', payrollAllocated: true })]);
        expect(out.byCurrency[0].uncertainty).toBe(UNCERTAINTY.ALLOCATED);
    });

    it('exact only when every row in the bucket contributed and none is short', () => {
        const out = foldFarmPerArea([row({ commodity: 'WHEAT' }), row({ commodity: 'MAIZE' })]);
        expect(out.byCurrency[0].uncertainty).toBe(UNCERTAINTY.EXACT);
    });

    it('refused — not a confident zero — when no row could contribute a margin', () => {
        const out = foldFarmPerArea([
            row({ commodity: 'WHEAT', marginPerDca: null, attributableCostPerDca: null }),
        ]);
        const entry = out.byCurrency.find((c) => c.currency === 'BGN')!;
        expect(entry.marginPerDca).toBeNull();
        expect(entry.uncertainty).toBe(UNCERTAINTY.REFUSED);
    });
});

describe('shape and ordering', () => {
    it('an empty farm is an empty answer, not a zero', () => {
        const out = foldFarmPerArea([]);
        expect(out.areaDca).toBe(0);
        expect(out.byCurrency).toEqual([]);
    });

    it('a rate with no land behind it is absent rather than zero', () => {
        const out = foldFarmPerArea([
            row({ commodity: 'WHEAT', areaDca: 0, costAreaDca: 0, standingValuePerDca: 50 }),
        ]);
        const entry = out.byCurrency.find((c) => c.currency === 'BGN');
        expect(entry?.standingValuePerDca ?? null).toBeNull();
        expect(entry?.areaDca ?? 0).toBe(0);
    });

    it('orders by land, most first, so the main currency is not buried', () => {
        const out = foldFarmPerArea([
            row({ commodity: 'WHEAT', priceCurrency: 'BGN', costCurrency: 'BGN', areaDca: 500 }),
            row({ commodity: 'MAIZE', priceCurrency: 'EUR', costCurrency: 'EUR', areaDca: 3 }),
        ]);
        expect(out.byCurrency.map((c) => c.currency)).toEqual(['BGN', 'EUR']);
    });

    it('omission lists are sorted, so a client can compare two of them', () => {
        // The point of `without`: a client says «Без: …» once when every figure
        // leaves out the same crops, which needs a stable order.
        const out = foldFarmPerArea([
            row({ commodity: 'WHEAT' }),
            row({ commodity: 'SUNFLOWER', standingValuePerDca: null }),
            row({ commodity: 'BARLEY', standingValuePerDca: null }),
        ]);
        expect(out.byCurrency[0].without.standingValuePerDca).toEqual(['BARLEY', 'SUNFLOWER']);
    });
});
