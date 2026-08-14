/**
 * The farm-level answer, per currency.
 *
 * The calculator's own docblock claims it is "the only surface in the
 * product that answers 'what is the grain worth, after everything it cost
 * me?'". It answered that PER COMMODITY: a farm growing wheat, sunflower
 * and maize got three answers behind a toggle and had to add them in its
 * head. That is the same defect #554 fixed WITHIN a commodity — figures a
 * reader is left to combine — still present ACROSS them.
 *
 * ── Why a total is per currency ─────────────────────────────────────
 *
 * This product does not blend currencies. `cost-rollup` refuses to, prices
 * carry their own, and there is no FX table anywhere. So the farm total is
 * a total PER CURRENCY. That is a constraint on its SHAPE, not a reason to
 * omit it.
 *
 * ── Why a refused row contributes nothing ───────────────────────────
 *
 * A refused row still has asset values — a mixed-cost-currency refusal has
 * a perfectly good standing crop. Folding its assets in while its cost
 * cannot be subtracted would OVERSTATE the farm. So refused commodities
 * are excluded from the arithmetic and NAMED, never silently dropped.
 */
import { foldFarmTotals } from '@/lib/grain/farm-total';
import { UNCERTAINTY } from '@/lib/grain/uncertainty';

function row(over: Partial<Parameters<typeof foldFarmTotals>[0][number]> = {}) {
    return {
        commodity: 'wheat',
        priceCurrency: 'EUR' as string | null,
        standingCropValue: 15_000 as number | null,
        grainOnHandValue: 10_000 as number | null,
        rentCostProduceValue: 750 as number | null,
        cashCostTotal: 5_500,
        netWorth: 18_750 as number | null,
        unvaluedNoUnitCost: 0,
        unvaluedUnitMismatch: 0,
        payrollAllocated: false,
        ...over,
    };
}

describe('foldFarmTotals', () => {
    it('sums every term, and the net equals the sum of the nets', () => {
        const totals = foldFarmTotals([
            row({ commodity: 'wheat' }),
            row({
                commodity: 'sunflower',
                standingCropValue: 8_000,
                grainOnHandValue: 2_000,
                rentCostProduceValue: 0,
                cashCostTotal: 3_000,
                netWorth: 7_000,
            }),
        ]);

        expect(totals).toHaveLength(1);
        const [t] = totals;
        expect(t.currency).toBe('EUR');
        expect(t.standingCropValue).toBe(23_000);
        expect(t.grainOnHandValue).toBe(12_000);
        expect(t.rentCostProduceValue).toBe(750);
        expect(t.cashCostTotal).toBe(8_500);
        expect(t.netWorth).toBe(25_750);
        // The identity holds at farm level exactly as it does per row.
        expect(t.netWorth).toBe(
            t.standingCropValue - t.rentCostProduceValue + t.grainOnHandValue - t.cashCostTotal,
        );
    });

    it('keeps currencies apart — one line each, never blended', () => {
        // There is no FX table in this product. A single figure across two
        // currencies would reconcile against nothing.
        const totals = foldFarmTotals([
            row({ commodity: 'wheat', priceCurrency: 'EUR' }),
            row({ commodity: 'maize', priceCurrency: 'BGN', netWorth: 4_000, cashCostTotal: 1_000 }),
        ]);

        expect(totals.map((t) => t.currency).sort()).toEqual(['BGN', 'EUR']);
        expect(totals.find((t) => t.currency === 'EUR')!.netWorth).toBe(18_750);
        expect(totals.find((t) => t.currency === 'BGN')!.netWorth).toBe(4_000);
    });

    it('orders currencies by size, so the farm’s main one leads', () => {
        const totals = foldFarmTotals([
            row({ commodity: 'wheat', priceCurrency: 'BGN', netWorth: 500 }),
            row({ commodity: 'maize', priceCurrency: 'EUR', netWorth: 40_000 }),
        ]);
        expect(totals.map((t) => t.currency)).toEqual(['EUR', 'BGN']);
    });

    it('EXCLUDES a refused row and names it, rather than going silently short', () => {
        // The refused row has real asset values. Including them without its
        // cost would overstate the farm; dropping it silently would produce
        // a smaller number with no indication it is not the whole farm.
        const totals = foldFarmTotals([
            row({ commodity: 'wheat' }),
            row({
                commodity: 'maize',
                standingCropValue: 9_000,
                grainOnHandValue: 1_000,
                netWorth: null,
            }),
        ]);

        expect(totals).toHaveLength(1);
        const [t] = totals;
        expect(t.netWorth).toBe(18_750); // wheat only
        expect(t.standingCropValue).toBe(15_000); // maize's 9,000 NOT folded in
        expect(t.refusedCommodities).toEqual(['maize']);
        expect(t.uncertainty).toBe(UNCERTAINTY.PARTIAL);
    });

    it('carries AT_MOST when a contributing cost is a floor', () => {
        const totals = foldFarmTotals([row({ unvaluedNoUnitCost: 2 })]);
        expect(totals[0].uncertainty).toBe(UNCERTAINTY.AT_MOST);
    });

    it('carries ALLOCATED when a contributing payroll was apportioned', () => {
        const totals = foldFarmTotals([row({ payrollAllocated: true })]);
        expect(totals[0].uncertainty).toBe(UNCERTAINTY.ALLOCATED);
    });

    it('attributes a refused row to its own currency when it has one', () => {
        // A mixed-cost-currency refusal still has a price currency, so the
        // farmer can see WHICH currency's total is short.
        const totals = foldFarmTotals([
            row({ commodity: 'wheat', priceCurrency: 'EUR' }),
            row({ commodity: 'maize', priceCurrency: 'BGN', netWorth: null }),
        ]);
        expect(totals.find((t) => t.currency === 'BGN')?.refusedCommodities).toEqual(['maize']);
        expect(totals.find((t) => t.currency === 'BGN')?.uncertainty).toBe(UNCERTAINTY.REFUSED);
        expect(totals.find((t) => t.currency === 'EUR')?.uncertainty).toBe(UNCERTAINTY.EXACT);
    });

    it('drops a refused row with no currency at all into no total', () => {
        // "No market price" means no price currency either. There is no
        // currency bucket it belongs to — it is reported by the caller as a
        // farm-wide omission instead.
        const totals = foldFarmTotals([
            row({ commodity: 'wheat' }),
            row({ commodity: 'maize', priceCurrency: null, netWorth: null }),
        ]);
        expect(totals).toHaveLength(1);
        expect(totals[0].currency).toBe('EUR');
        expect(totals[0].refusedCommodities).toEqual([]);
    });

    it('returns nothing for a farm with no rows', () => {
        expect(foldFarmTotals([])).toEqual([]);
    });
});
