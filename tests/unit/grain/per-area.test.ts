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
    standingCropValue: 15_000 as number | null,
    attributableCost: 5_000,
    standingCropExcludedCount: 0,
    unvaluedNoUnitCost: 0,
    unvaluedUnitMismatch: 0,
    payrollAllocated: false,
};

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
        it('refuses on zero area rather than returning Infinity', () => {
            // A commodity that is only in store has no standing-crop area,
            // and so does one whose every planting was dropped for a
            // missing yield estimate.
            const r = computePerArea({ ...base, standingCropAreaHa: 0 });
            expect(r.marginPerDca).toBeNull();
            expect(r.standingValuePerDca).toBeNull();
            expect(r.attributableCostPerDca).toBeNull();
            expect(r.uncertainty).toBe(UNCERTAINTY.REFUSED);
            expect(r.refusalCode).toBe('NO_STANDING_CROP_AREA');
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
