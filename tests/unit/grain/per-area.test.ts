/**
 * Per-decare figures, and the two denominators that must never be used.
 *
 * Bulgarian farmers think in декари and the land market quotes rent in
 * лв/дка. Absolute totals answer "what is it worth"; per-dca answers what
 * a farmer acts on — is this field better than that one, does this rented
 * parcel earn its rent.
 *
 * ── Trap one: the numerator ─────────────────────────────────────────
 *
 * `netWorth / area` is nonsense. Net worth includes `grainOnHandValue`,
 * which has NO area — it is tonnes in a store, harvested off land that may
 * not even be this season's — and farm-wide overhead. Only terms
 * attributable to the standing crop's own plantings may share the
 * denominator.
 *
 * ── Trap two: the denominator, which the brief did not name ─────────
 *
 * `standingCropAreaHa` sums INCLUDED plantings only. `cashCostTotal` does
 * not: it is every cost attributed to the commodity, including plantings
 * dropped for a missing yield estimate. So when anything was excluded, the
 * cost side covers more land than the revenue side and the margin is
 * understated. That is not a bound in either direction we can state — the
 * unpriced-consumption bias runs the other way — so the figure is PARTIAL,
 * which is what the vocabulary already has for "records are missing".
 */
import { computePerArea } from '@/lib/grain/per-area';
import { UNCERTAINTY } from '@/lib/grain/uncertainty';

const base = {
    // 12.5 ha = 125 dca
    standingCropAreaHa: 12.5,
    // #1512: the COST rate's denominator. Equal to the yield-covered area in
    // this base fixture, so every pre-existing expectation holds unchanged —
    // the cases where they DIFFER are new tests below.
    occupiedAreaHa: 12.5,
    standingCropValue: 15_000 as number | null,
    attributableCost: 5_000,
    // EMPTY is the owner's farm and the common case: the journal path never
    // writes `costCurrency`. It resolves to `costCurrency: null`, meaning
    // "the tenant's display currency", NOT a refusal — so every pre-existing
    // expectation holds unchanged and the currency cases are new tests below.
    costCurrencies: [] as readonly string[],
    priceCurrency: 'BGN' as string | null,
    standingCropExcludedCount: 0,
    unvaluedNoUnitCost: 0,
    unattributedCostEntries: 0,
    unvaluedUnitMismatch: 0,
    payrollAllocated: false,
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

describe('computePerArea', () => {
    it('divides by DECARES, the unit the farmer plans in', () => {
        const r = computePerArea(base);
        expect(r.areaDca).toBe(125);
        expect(r.standingValuePerDca).toBe(120); // 15,000 / 125
        expect(r.attributableCostPerDca).toBe(40); // 5,000 / 125
        expect(r.marginPerDca).toBe(80); // (15,000 − 5,000) / 125
    });

    it('is EXACT when nothing qualifies it', () => {
        expect(computePerArea(base).uncertainty).toBe(UNCERTAINTY.EXACT);
    });

    describe('the division is guarded', () => {
        it('refuses EVERYTHING for a commodity that is only in store', () => {
            // No growing crop at all: no standing-crop area AND no occupied
            // land. Both denominators are zero, so all three figures are
            // withheld rather than returning Infinity.
            //
            // This case and the one below used to be ONE test, which is what
            // #1512 was about: with a single denominator they were
            // indistinguishable, so a farm that knew its costs exactly got no
            // cost-per-decare because nobody could price the crop.
            const r = computePerArea({ ...base, standingCropAreaHa: 0, occupiedAreaHa: 0 });

            expect(r.marginPerDca).toBeNull();
            expect(r.standingValuePerDca).toBeNull();
            expect(r.attributableCostPerDca).toBeNull();
            expect(r.uncertainty).toBe(UNCERTAINTY.REFUSED);
            expect(r.refusalCode).toBe('NO_STANDING_CROP_AREA');
        });

        it('still gives a COST rate when the crop is growing but unforecast', () => {
            // Every planting dropped for a missing yield estimate, so the
            // yield-covered area is 0 — but the crop is on 12.5 ha and that
            // land costs money. The cost rate is knowable and is given; the
            // value and margin are not and are withheld.
            //
            // This is the figure #1512 exists to deliver, and the farm it
            // matters for is the owner's: 1 real planting against 4 parcels
            // carrying 1386.8 дка.
            const r = computePerArea({ ...base, standingCropAreaHa: 0 });

            expect(r.attributableCostPerDca).not.toBeNull();
            expect(r.standingValuePerDca).toBeNull();
            // The margin subtracts a value that does not exist, so it stays
            // refused — and `refusalCode` keeps describing exactly that,
            // which is what the calculator's per-commodity list keys on.
            expect(r.marginPerDca).toBeNull();
            expect(r.refusalCode).toBe('NO_STANDING_CROP_AREA');
        });

        it('reports BOTH denominators, so nothing displayed can contradict them', () => {
            // agrent-ios raised this against the first version of #1512 and was
            // right: `perArea` exposed only `areaDca`, so a client showing the
            // area beside the cost rate would have shown «Площ 0 дка» directly
            // above «Разход / дка 12,50» on the owner's farm. The figures were
            // correct and what a farmer read was a contradiction.
            //
            // Each figure's own denominator is named rather than left to be
            // recomputed, so a client multiplying back up gets the number the
            // server divided by, by construction.
            const r = computePerArea({ ...base, standingCropAreaHa: 5, occupiedAreaHa: 20 });

            expect(r.areaDca).toBe(50);
            expect(r.costAreaDca).toBe(200);
            // And the cost rate really is the second one's quotient, not the
            // first's — the assertion that makes the pair meaningful.
            expect(r.attributableCostPerDca).toBe(round2(base.attributableCost / 200));
        });

        it('reports costAreaDca even when the value figures are refused', () => {
            // The case the contradiction appeared in: no yield-covered area at
            // all, so `areaDca` is 0 and the value figures are withheld — but
            // the cost rate is real and its denominator must travel with it.
            const r = computePerArea({ ...base, standingCropAreaHa: 0, occupiedAreaHa: 20 });

            expect(r.areaDca).toBe(0);
            expect(r.costAreaDca).toBe(200);
            expect(r.attributableCostPerDca).not.toBeNull();
            expect(r.standingValuePerDca).toBeNull();
        });

        it('divides the cost by the OCCUPIED area, not the yield-covered one', () => {
            // The arithmetic, with the two areas deliberately different. A
            // cost divided by the smaller yield-covered area would come back
            // larger — plausible, and overstating what the farm spends per
            // decare by exactly the land it cannot forecast.
            const r = computePerArea({
                ...base,
                standingCropAreaHa: 5,
                occupiedAreaHa: 20,
                standingCropValue: 1000,
                attributableCost: 400,
            });

            // 20 ha = 200 дка, so 400 / 200 = 2.
            expect(r.attributableCostPerDca).toBe(2);
            // And the VALUE still uses the yield-covered area: 5 ha = 50 дка,
            // 1000 / 50 = 20. The two figures use different denominators on
            // purpose, which is the whole of #1512.
            expect(r.standingValuePerDca).toBe(20);
        });

        it('never produces Infinity or NaN for any degenerate input', () => {
            for (const areaHa of [0, -0, Number.NaN]) {
                const r = computePerArea({ ...base, standingCropAreaHa: areaHa });
                for (const v of [r.marginPerDca, r.standingValuePerDca, r.attributableCostPerDca]) {
                    expect(v == null || Number.isFinite(v)).toBe(true);
                }
            }
        });

        it('refuses when the crop has no market value to divide', () => {
            // No price ⇒ standingCropValue is null. A cost-only per-dca
            // figure would read as a margin of minus-everything.
            const r = computePerArea({ ...base, standingCropValue: null });
            expect(r.marginPerDca).toBeNull();
            expect(r.uncertainty).toBe(UNCERTAINTY.REFUSED);
            expect(r.refusalCode).toBe('NO_STANDING_CROP_VALUE');
        });
    });

    describe('uncertainty is composed, not restated', () => {
        it('AT_LEAST cost makes the margin AT_MOST', () => {
            // Cost understated ⇒ margin overstated ⇒ the margin is a
            // ceiling. Same inversion the headline already carries.
            const r = computePerArea({ ...base, unvaluedNoUnitCost: 2 });
            expect(r.uncertainty).toBe(UNCERTAINTY.AT_MOST);
            expect(r.marginPerDca).toBe(80);
        });

        it('ALLOCATED payroll makes the margin ALLOCATED', () => {
            expect(computePerArea({ ...base, payrollAllocated: true }).uncertainty).toBe(
                UNCERTAINTY.ALLOCATED,
            );
        });

        it('is PARTIAL when the cost covers land the revenue does not', () => {
            // The trap the brief did not name. Excluded plantings keep
            // their cost in cashCostTotal but contribute no standing value
            // and no area — so the margin is understated, while an
            // unpriced consumption biases it the other way. Neither bound
            // can be stated, so the figure says it is incomplete.
            const r = computePerArea({ ...base, standingCropExcludedCount: 2 });
            expect(r.uncertainty).toBe(UNCERTAINTY.PARTIAL);
        });

        it('prefers PARTIAL over a bound, matching the farm-level rule', () => {
            expect(
                computePerArea({
                    ...base,
                    standingCropExcludedCount: 1,
                    unvaluedNoUnitCost: 3,
                    payrollAllocated: true,
                }).uncertainty,
            ).toBe(UNCERTAINTY.PARTIAL);
        });

        it('prefers a bound over an allocation, matching the row-level rule', () => {
            expect(
                computePerArea({ ...base, unvaluedUnitMismatch: 1, payrollAllocated: true })
                    .uncertainty,
            ).toBe(UNCERTAINTY.AT_MOST);
        });

        it('reports REFUSED ahead of every other state', () => {
            // There is no figure to qualify.
            expect(
                computePerArea({
                    ...base,
                    standingCropAreaHa: 0,
                    standingCropExcludedCount: 5,
                    unvaluedNoUnitCost: 9,
                }).uncertainty,
            ).toBe(UNCERTAINTY.REFUSED);
        });
    });

    it('rounds to whole cents, like every other money figure here', () => {
        const r = computePerArea({
            ...base,
            standingCropAreaHa: 3.7,
            standingCropValue: 10_000,
            attributableCost: 3_333,
        });
        // 37 dca → (10,000 − 3,333) / 37 = 180.189…
        expect(r.marginPerDca).toBe(180.19);
    });
});

describe('an unattributed cost makes the per-dca figures a ceiling (#1530)', () => {
    // Direction matters: an understated cost overstates the margin, so the
    // per-area figures become AT_MOST. Before #1530 this reached EXACT — the
    // figure read as exact while being structurally short, which is the one
    // thing the vocabulary exists to prevent.
    const priced = { ...base, standingCropAreaHa: 10, standingCropValue: 5_000, attributableCost: 2_000 };

    it('reads AT_MOST on the new cause ALONE', () => {
        const r = computePerArea({ ...priced, unattributedCostEntries: 1 });

        expect(r.uncertainty).toBe(UNCERTAINTY.AT_MOST);
        // The figures are still produced — qualified, not withheld. Withholding
        // would be worse than qualifying, and is what the refusal codes are for.
        expect(r.marginPerDca).not.toBeNull();
        expect(r.refusalCode).toBeNull();
    });

    it('and EXACT when nothing is unattributed — the control', () => {
        const r = computePerArea({ ...priced, unattributedCostEntries: 0 });
        expect(r.uncertainty).toBe(UNCERTAINTY.EXACT);
    });
});

/**
 * The cost rate's CURRENCY, which #1606 shipped without.
 *
 * `attributableCost` is `cashCostTotal`, a magnitude sum taken across whatever
 * currencies the rows carried — its own docblock says never to assume it shares
 * one with the market price. So `attributableCostPerDca` was a bare number a
 * client had to guess the unit of, and the guess available to it was
 * `priceCurrency`, which is the wrong one by construction. These cases pin the
 * resolution and, more importantly, pin WHICH SIDE each ambiguity falls on.
 *
 * The asymmetry is the point and is not an oversight:
 *
 *   · an EMPTY currency set RESOLVES (null, meaning the tenant's display
 *     currency) — net worth makes the same assumption in the same situation,
 *     and refusing would withhold the rate on exactly the farms with no
 *     structured cost data, which are the ones #1512 was filed about;
 *   · a MIXED set REFUSES — no FX is ever invented, so a blend is not money.
 *
 * Getting those two backwards would be invisible on a green farm and wrong on
 * every farm that matters.
 */
describe('the cost rate carries its own currency (#1512)', () => {
    const UNKNOWN = 'UNKNOWN';

    it('EMPTY resolves to the tenant currency, and does NOT refuse', () => {
        const r = computePerArea({ ...base, costCurrencies: [] });

        // The rate is produced. This is the owner's farm: the journal path
        // never writes `costCurrency`, so an empty set is the common case and
        // refusing it would have been the regression.
        expect(r.attributableCostPerDca).toBe(round2(5_000 / 125));
        expect(r.costCurrency).toBeNull();
        expect(r.costRefusalCode).toBeNull();
    });

    it('ONE recorded currency labels the rate with it', () => {
        const r = computePerArea({ ...base, costCurrencies: ['BGN'] });

        expect(r.attributableCostPerDca).toBe(round2(5_000 / 125));
        expect(r.costCurrency).toBe('BGN');
        expect(r.costRefusalCode).toBeNull();
    });

    it('the SAME currency repeated is still one currency', () => {
        // Deduplicated, because the usecase hands over a set-derived array and
        // a future caller may not. Without the dedup this reads as a mix and
        // withholds a perfectly good figure.
        const r = computePerArea({ ...base, costCurrencies: ['EUR', 'EUR', 'EUR'] });

        expect(r.costCurrency).toBe('EUR');
        expect(r.costRefusalCode).toBeNull();
        expect(r.attributableCostPerDca).not.toBeNull();
    });

    it('TWO currencies withhold the rate rather than blending them', () => {
        const r = computePerArea({ ...base, costCurrencies: ['BGN', 'EUR'] });

        expect(r.attributableCostPerDca).toBeNull();
        expect(r.costRefusalCode).toBe('COST_CURRENCY_MIXED');
        // And no label on a figure that is not there.
        expect(r.costCurrency).toBeNull();
    });

    it('the UNKNOWN rent sentinel ALONE is reported as unrecorded', () => {
        // `ParcelLease` has no currency column, so money rent arrives as a
        // sentinel. The farmer's fix is to record the lease — a different
        // sentence from "reconcile your entries", which is why this is its own
        // code rather than folded into MIXED.
        const r = computePerArea({ ...base, costCurrencies: [UNKNOWN] });

        expect(r.attributableCostPerDca).toBeNull();
        expect(r.costRefusalCode).toBe('COST_CURRENCY_UNRECORDED');
    });

    it('a real currency PLUS the sentinel is a MIX, not merely unrecorded', () => {
        // Precedence, and it is deliberate: "these are several currencies" is
        // the more actionable sentence, and the sentinel is one of them.
        const r = computePerArea({ ...base, costCurrencies: ['EUR', UNKNOWN] });

        expect(r.costRefusalCode).toBe('COST_CURRENCY_MIXED');
    });

    it('NO occupied area outranks any currency problem', () => {
        // Both are wrong at once; the area is the one to say. A farmer told
        // "your currencies disagree" would go and fix currencies on a figure
        // that has no denominator either way.
        const r = computePerArea({
            ...base,
            occupiedAreaHa: 0,
            costCurrencies: ['BGN', 'EUR'],
        });

        expect(r.costRefusalCode).toBe('NO_OCCUPIED_AREA');
        expect(r.attributableCostPerDca).toBeNull();
    });

    it('the pair is exhaustive: a refusal code iff the rate is null', () => {
        // The whole contract in one assertion, over every shape above. A
        // refusal with no code is the dash this module exists to avoid, and a
        // code beside a real number would make a client hide a good figure.
        const shapes: Array<Partial<typeof base>> = [
            { costCurrencies: [] },
            { costCurrencies: ['BGN'] },
            { costCurrencies: ['BGN', 'EUR'] },
            { costCurrencies: [UNKNOWN] },
            { costCurrencies: ['EUR', UNKNOWN] },
            { occupiedAreaHa: 0 },
            { occupiedAreaHa: 0, costCurrencies: ['EUR'] },
            { standingCropValue: null, costCurrencies: ['EUR'] },
            { standingCropAreaHa: 0, costCurrencies: ['EUR'] },
        ];

        // A control on the control: an empty list here would make the loop
        // below assert nothing at all, which is the failure mode of every
        // table-driven test.
        expect(shapes.length).toBeGreaterThanOrEqual(9);

        for (const shape of shapes) {
            const r = computePerArea({ ...base, ...shape });
            expect({
                shape,
                codeSet: r.costRefusalCode != null,
                rateNull: r.attributableCostPerDca == null,
            }).toEqual({
                shape,
                codeSet: r.attributableCostPerDca == null,
                rateNull: r.attributableCostPerDca == null,
            });
            // A currency is never stated for a figure that was withheld.
            if (r.attributableCostPerDca == null) expect(r.costCurrency).toBeNull();
        }
    });

    it('the cost currency does not touch the VALUE figures — the control', () => {
        // The cost rate stands alone in BOTH directions: a currency refusal
        // must not withhold a figure that does not use the cost.
        //
        // This used to assert `marginPerDca` too, on the reasoning that
        // withholding it would be "#1606 in reverse". That mirror is false and
        // #1606's own table says so — it lists `marginPerDca` as "needs both".
        // What #1606 removed was an over-gate on the COST rate, which
        // genuinely needs neither a price nor a yield estimate. The margin is
        // the one figure that needs both sides, so gating it on the cost is
        // the real dependency rather than a mirror of that mistake. See
        // `the margin is REFUSED when the cost cannot be subtracted` below.
        const mixed = computePerArea({ ...base, costCurrencies: ['BGN', 'EUR'] });
        const clean = computePerArea({ ...base, costCurrencies: ['BGN'] });

        expect(mixed.standingValuePerDca).toBe(clean.standingValuePerDca);
        expect(mixed.areaDca).toBe(clean.areaDca);
        expect(mixed.refusalCode).toBe(clean.refusalCode);
    });

    it('the margin is REFUSED when the cost cannot be subtracted (#2259)', () => {
        // The defect: this module withheld the cost RATE because two
        // currencies cannot be added, and then published a margin built from
        // that same un-addable sum — and labelled it `exact`. Measured before
        // the fix: attributableCostPerDca null with COST_CURRENCY_MIXED, and
        // marginPerDca 30.
        const r = computePerArea({ ...base, costCurrencies: ['BGN', 'EUR'] });

        expect(r.attributableCostPerDca).toBeNull();
        expect(r.costRefusalCode).toBe('COST_CURRENCY_MIXED');
        // The figure that blended them is gone, and says why.
        expect(r.marginPerDca).toBeNull();
        expect(r.marginRefusalCode).toBe('COST_CURRENCY_MIXED');
        // And the VALUE side is untouched — the control above, restated here
        // so this test cannot pass by withholding everything.
        expect(r.standingValuePerDca).not.toBeNull();
    });

    it('ONE cost currency that is not the price currency refuses the margin, keeping the rate (#2259)', () => {
        // The half of #2259 that the cost-refusal codes do NOT cover. A single
        // EUR cost currency is not a refusal — the rate is a perfectly good
        // "20 EUR/dca" and #1606 is explicit that it stands alone — but it
        // cannot be subtracted from a BGN value.
        const r = computePerArea({ ...base, costCurrencies: ['EUR'], priceCurrency: 'BGN' });

        // The rate SURVIVES, labelled with its own currency.
        expect(r.attributableCostPerDca).not.toBeNull();
        expect(r.costCurrency).toBe('EUR');
        expect(r.costRefusalCode).toBeNull();
        // The subtraction does not.
        expect(r.marginPerDca).toBeNull();
        expect(r.marginRefusalCode).toBe('COST_PRICE_CURRENCY_MISMATCH');
        // Mirrors net worth, which refuses the same farm with its own
        // COST_PRICE_CURRENCY_MISMATCH. The per-dca margin was the one figure
        // that did not.
    });

    it('a MATCHING single currency subtracts normally — the control', () => {
        // Without this the test above passes on any rule that refuses every
        // single-currency row.
        const r = computePerArea({ ...base, costCurrencies: ['BGN'], priceCurrency: 'BGN' });
        expect(r.marginPerDca).toBe(80);
        expect(r.marginRefusalCode).toBeNull();
    });

    it('an EMPTY cost-currency set still subtracts, matching net worth', () => {
        // The journal path never writes `costCurrency`, so an unlabelled
        // magnitude is the common case and is treated as the tenant's display
        // currency. Refusing it would withhold the margin on most farms.
        const r = computePerArea({ ...base, costCurrencies: [], priceCurrency: 'BGN' });
        expect(r.marginPerDca).toBe(80);
        expect(r.marginRefusalCode).toBeNull();
    });

    it('the unrecorded-rent sentinel refuses the margin too, for the same reason', () => {
        const r = computePerArea({ ...base, costCurrencies: [UNKNOWN] });
        expect(r.marginPerDca).toBeNull();
        expect(r.marginRefusalCode).toBe('COST_CURRENCY_UNRECORDED');
    });

    it('marginRefusalCode is non-null EXACTLY when marginPerDca is null', () => {
        // The pair is the contract, the same way costRefusalCode pairs with
        // its own rate. A refused margin with no code is the dash this module
        // exists to avoid, and a code beside a real number is a lie.
        const cases = [
            { ...base },
            { ...base, costCurrencies: ['BGN', 'EUR'] },
            { ...base, costCurrencies: [UNKNOWN] },
            { ...base, standingCropValue: null },
            { ...base, standingCropAreaHa: 0 },
            { ...base, occupiedAreaHa: 0 },
        ];
        for (const input of cases) {
            const r = computePerArea(input);
            expect({
                margin: r.marginPerDca === null,
                code: r.marginRefusalCode !== null,
            }).toEqual({ margin: r.marginPerDca === null, code: r.marginPerDca === null });
        }
    });

    it('a NON-FINITE occupied area reports 0 decares on BOTH return paths', () => {
        // The success path returned `costAreaDca` raw while the refusal path
        // guarded it. `z.number()` accepts a non-finite number and JSON
        // serialises it to `null`, so the non-nullable DTO field would have
        // failed on a path no test covered.
        //
        // INFINITY, not NaN, and that is the whole substance of this test. The
        // computation is `round2((input.occupiedAreaHa || 0) * DCA_PER_HA)`, and
        // `NaN` is FALSY — `NaN || 0` is `0` — so a NaN input never reaches the
        // guard at all. A NaN case here passes whether the guard exists or not,
        // which is the shape of an assertion that is green for the wrong reason:
        // it would be asserting `|| 0`, not the thing it names. Infinity is
        // truthy, survives the `||`, and `round2(Infinity)` is Infinity, so it
        // is the only input that actually exercises the guard.
        //
        // Asserted on a priced row (success path) and an unpriced one (refusal
        // path) because one of the two was already correct, and a test covering
        // only that one would have passed before the fix.
        const priced = computePerArea({ ...base, occupiedAreaHa: Number.POSITIVE_INFINITY });
        const refused = computePerArea({
            ...base,
            occupiedAreaHa: Number.POSITIVE_INFINITY,
            standingCropValue: null,
        });

        // The premise, stated so this cannot quietly stop testing the guard:
        // a NaN input is neutralised upstream and proves nothing here.
        expect(computePerArea({ ...base, occupiedAreaHa: Number.NaN }).costAreaDca).toBe(0);

        expect(priced.refusalCode).toBeNull();
        expect(refused.refusalCode).toBe('NO_STANDING_CROP_VALUE');
        for (const r of [priced, refused]) {
            expect(Number.isFinite(r.costAreaDca)).toBe(true);
            expect(r.costAreaDca).toBe(0);
            expect(r.attributableCostPerDca).toBeNull();
            expect(r.costRefusalCode).toBe('NO_OCCUPIED_AREA');
        }
    });
});

describe('cost refusal — rent no longer poisons a euro-only farm (#2397 follow-up)', () => {
    /*
     * This module did not change. What changed is what reaches it.
     *
     * `grain-net-worth` used to tag EVERY non-zero money rent with
     * `UNKNOWN_RENT_CURRENCY`, regardless of the lease's unit, so any farm with
     * cash rent arrived here as `['EUR', 'UNKNOWN']` and was refused
     * `COST_CURRENCY_MIXED` — which is what withheld cost and margin per дка on
     * the owner's own Калкулатор. A `лв/дка` lease now converts at the peg and
     * arrives labelled EUR.
     *
     * Both halves are asserted: that the new input passes, and that the old
     * input would STILL be refused. The second is not redundant — the refusal
     * is the right answer for a genuinely unlabelled rent, and a fix that
     * removed it would be a worse bug than the one being fixed.
     */
    it('EUR costs plus EUR-labelled rent produce a cost rate', () => {
        const r = computePerArea({ ...base, costCurrencies: ['EUR', 'EUR'] });
        expect(r.costRefusalCode).toBeNull();
        expect(r.attributableCostPerDca).not.toBeNull();
    });

    it('a sentinel-labelled rent is STILL refused, if one ever arrives', () => {
        const r = computePerArea({ ...base, costCurrencies: ['EUR', 'UNKNOWN'] });
        expect(r.costRefusalCode).toBe('COST_CURRENCY_MIXED');
        expect(r.attributableCostPerDca).toBeNull();
    });

    it('and a genuinely mixed pair is refused for the same reason', () => {
        // The control: the refusal is about more than the sentinel, so
        // removing the sentinel does not disarm it.
        const r = computePerArea({ ...base, costCurrencies: ['EUR', 'USD'] });
        expect(r.costRefusalCode).toBe('COST_CURRENCY_MIXED');
    });
});
