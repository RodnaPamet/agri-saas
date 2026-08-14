/**
 * Break-even: the price a crop must fetch to cover what it cost.
 *
 * The most decision-shaped figure on the page. Net worth says what the
 * grain is worth; break-even says whether to sell it now, and the answer
 * is a comparison a farmer can make in one glance — market price against
 * the price that clears cost.
 *
 * ── Why a RATIO, and why that is not a currency blend ───────────────
 *
 * `market / breakEven` is dimensionless. Both sides of that division are
 * in the SAME currency by construction — a row's cost currency must equal
 * its price currency or the usecase refuses the row entirely — so the
 * quotient carries no currency at all. A EUR crop and a BGN crop can sit
 * on one ratio scale without anything being blended, because there is no
 * money on that scale. The money itself is still shown per crop, with its
 * own code.
 */
import { computeBreakEven } from '@/lib/grain/break-even';
import { UNCERTAINTY } from '@/lib/grain/uncertainty';

const base = {
    standingCropExpectedKg: 60_000, // 60 t
    attributableCost: 12_000,
    pricePerTonne: 250 as number | null,
    priceCurrency: 'EUR' as string | null,
    standingCropExcludedCount: 0,
    unvaluedNoUnitCost: 0,
    unvaluedUnitMismatch: 0,
    payrollAllocated: false,
};

describe('computeBreakEven', () => {
    it('is cost divided by the tonnage that cost produced', () => {
        const r = computeBreakEven(base);
        expect(r.breakEvenPricePerTonne).toBe(200); // 12,000 / 60 t
        expect(r.marketPricePerTonne).toBe(250);
        expect(r.currency).toBe('EUR');
    });

    it('reports cover as a percentage, and whether the crop clears', () => {
        const r = computeBreakEven(base);
        expect(r.coverPercent).toBe(125); // 250 / 200
        expect(r.covered).toBe(true);
    });

    it('says plainly when the market does NOT cover the cost', () => {
        const r = computeBreakEven({ ...base, pricePerTonne: 150 });
        expect(r.coverPercent).toBe(75);
        expect(r.covered).toBe(false);
    });

    describe('the divisions are guarded', () => {
        it('refuses with no expected tonnage rather than dividing by zero', () => {
            const r = computeBreakEven({ ...base, standingCropExpectedKg: 0 });
            expect(r.breakEvenPricePerTonne).toBeNull();
            expect(r.coverPercent).toBeNull();
            expect(r.uncertainty).toBe(UNCERTAINTY.REFUSED);
            expect(r.refusalCode).toBe('NO_EXPECTED_TONNAGE');
        });

        it('refuses with no market price — there is nothing to compare against', () => {
            const r = computeBreakEven({ ...base, pricePerTonne: null });
            expect(r.coverPercent).toBeNull();
            expect(r.uncertainty).toBe(UNCERTAINTY.REFUSED);
            expect(r.refusalCode).toBe('NO_MARKET_PRICE');
        });

        it('treats a costless crop as covered, without dividing by zero', () => {
            // Break-even of 0 means any price clears it. The RATIO is
            // undefined, so it is withheld rather than reported as
            // Infinity — but the verdict is not in doubt.
            const r = computeBreakEven({ ...base, attributableCost: 0 });
            expect(r.breakEvenPricePerTonne).toBe(0);
            expect(r.coverPercent).toBeNull();
            expect(r.covered).toBe(true);
        });

        it('never produces Infinity or NaN', () => {
            for (const over of [
                { standingCropExpectedKg: 0 },
                { attributableCost: 0 },
                { standingCropExpectedKg: Number.NaN },
                { pricePerTonne: null },
            ]) {
                const r = computeBreakEven({ ...base, ...over });
                for (const v of [r.breakEvenPricePerTonne, r.coverPercent]) {
                    expect(v == null || Number.isFinite(v)).toBe(true);
                }
            }
        });
    });

    describe('uncertainty is composed, not restated', () => {
        it('is EXACT when nothing qualifies it', () => {
            expect(computeBreakEven(base).uncertainty).toBe(UNCERTAINTY.EXACT);
        });

        it('AT_LEAST cost makes break-even AT_LEAST too', () => {
            // Here the bound does NOT invert. An understated cost
            // understates the price needed to clear it, so the true
            // break-even is this or HIGHER — unlike the margin, where the
            // same cause produces a ceiling.
            const r = computeBreakEven({ ...base, unvaluedNoUnitCost: 2 });
            expect(r.uncertainty).toBe(UNCERTAINTY.AT_LEAST);
        });

        it('is PARTIAL when cost covers plantings the tonnage does not', () => {
            expect(
                computeBreakEven({ ...base, standingCropExcludedCount: 1 }).uncertainty,
            ).toBe(UNCERTAINTY.PARTIAL);
        });

        it('is ALLOCATED when payroll was apportioned', () => {
            expect(computeBreakEven({ ...base, payrollAllocated: true }).uncertainty).toBe(
                UNCERTAINTY.ALLOCATED,
            );
        });

        it('reports REFUSED ahead of every other state', () => {
            expect(
                computeBreakEven({
                    ...base,
                    pricePerTonne: null,
                    standingCropExcludedCount: 3,
                    unvaluedNoUnitCost: 4,
                }).uncertainty,
            ).toBe(UNCERTAINTY.REFUSED);
        });
    });
});
