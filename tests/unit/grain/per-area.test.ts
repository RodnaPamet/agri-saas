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
