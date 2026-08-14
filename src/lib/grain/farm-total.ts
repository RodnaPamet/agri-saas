/**
 * The farm-level net worth, folded from the per-commodity rows.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * `/grain/calculator`'s docblock claims it is "the only surface in the
 * product that answers 'what is the grain worth, after everything it cost
 * me?'". It answered that PER COMMODITY: a farm growing wheat, sunflower
 * and maize got three answers behind a toggle and had to add them in its
 * head. That is the same defect the two-panel layout had — figures a
 * reader is left to combine — one level up.
 *
 * ── Why the total is per CURRENCY ───────────────────────────────────
 *
 * This product does not blend currencies. `cost-rollup` refuses to, prices
 * carry their own, and there is no FX table anywhere in the repo. So the
 * farm answer is one total per currency. That constrains its SHAPE; it is
 * not a reason to omit it, and it is not a reason to hide the smaller
 * currencies either.
 *
 * ── Why a refused row contributes nothing ───────────────────────────
 *
 * A refused row still has asset values — a mixed-cost-currency refusal has
 * a perfectly good standing crop. Folding those in while its cost cannot
 * be subtracted would OVERSTATE the farm, which is the worst direction for
 * this particular number to be wrong in. So refused commodities are
 * excluded from the arithmetic and NAMED. A total that is silently short
 * is worse than no total.
 *
 * A fold, not a query: every input is already computed by the usecase, so
 * this adds no read and cannot trip the D1/D2 query guardrails.
 *
 * @module lib/grain/farm-total
 */
import {
    composeFarmUncertainty,
    type UncertaintyInput,
    type UncertaintyState,
} from './uncertainty';

/** The row fields the fold reads. */
export interface FarmTotalInput extends UncertaintyInput {
    commodity: string;
    /**
     * The currency the row's money is in. A row with a computed net worth
     * always has one — the usecase only reaches the arithmetic when the
     * cost currency agrees with the price currency (or is absent, in which
     * case the tenant's display currency is assumed).
     */
    priceCurrency: string | null;
    standingCropValue: number | null;
    grainOnHandValue: number | null;
    rentCostProduceValue: number | null;
    cashCostTotal: number;
}

export interface FarmNetWorthTotal {
    currency: string;
    /** Same terms the per-commodity sum shows, so the two read alike. */
    standingCropValue: number;
    grainOnHandValue: number;
    rentCostProduceValue: number;
    cashCostTotal: number;
    netWorth: number;
    /** Commodities in this currency whose net worth was refused. */
    refusedCommodities: string[];
    /** Composed from the contributing rows — never invented here. */
    uncertainty: UncertaintyState;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/**
 * One total per currency, biggest net first.
 *
 * Ordering by size rather than alphabetically because the farm's main
 * currency is the answer a farmer came for; a BGN rounding remnant sorting
 * above EUR would bury it.
 *
 * A refused row with NO price currency (the "no market price" case) is not
 * attributable to any bucket and appears in none. The caller reports those
 * as a farm-wide omission — see `GrainNetWorthResult.farm`.
 */
export function foldFarmTotals(rows: readonly FarmTotalInput[]): FarmNetWorthTotal[] {
    const byCurrency = new Map<string, FarmTotalInput[]>();
    for (const row of rows) {
        if (row.priceCurrency == null) continue;
        const bucket = byCurrency.get(row.priceCurrency);
        if (bucket) bucket.push(row);
        else byCurrency.set(row.priceCurrency, [row]);
    }

    const totals: FarmNetWorthTotal[] = [];
    for (const [currency, bucket] of byCurrency) {
        const contributing = bucket.filter((r) => r.netWorth != null);
        const { state } = composeFarmUncertainty(bucket);
        totals.push({
            currency,
            standingCropValue: round2(sum(contributing, (r) => r.standingCropValue)),
            grainOnHandValue: round2(sum(contributing, (r) => r.grainOnHandValue)),
            rentCostProduceValue: round2(sum(contributing, (r) => r.rentCostProduceValue)),
            cashCostTotal: round2(sum(contributing, (r) => r.cashCostTotal)),
            netWorth: round2(sum(contributing, (r) => r.netWorth)),
            refusedCommodities: bucket
                .filter((r) => r.netWorth == null)
                .map((r) => r.commodity)
                .sort(),
            uncertainty: state,
        });
    }

    return totals.sort((a, b) => b.netWorth - a.netWorth);
}

function sum<T>(rows: readonly T[], pick: (row: T) => number | null): number {
    let total = 0;
    for (const row of rows) total += pick(row) ?? 0;
    return total;
}
