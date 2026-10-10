/**
 * The contract `getGrainNetWorth` guarantees about EVERY row it returns.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * `finalizeRow` once returned `netWorth = netAssetPosition` for the "no
 * cost currency recorded anywhere" branch — subtracting no cost at all.
 * The implementation note records what made it survive:
 *
 *   > nothing inside the usecase could see it. `netWorth =
 *   > netAssetPosition` is internally consistent and its unit tests
 *   > passed. It became a contradiction only when this page put
 *   > `cashCostTotal` on screen four inches from it.
 *
 * The tests asserted hardcoded outputs — `expect(wheat.netWorth).toBe(650)`
 * — one example at a time. Every example was consistent with itself, which
 * is exactly the shape of test the original bug passed. A wrong figure and
 * a right figure are equally easy to hardcode.
 *
 * These assert the RELATIONSHIP instead. They are called from a wrapper
 * around `getGrainNetWorth` in the usecase's test file, so every scenario
 * already written checks them without being edited — including the ones
 * whose author was thinking about rent, or payroll, or exclusions, and not
 * about this at all. That is the point: the invariant should not depend on
 * anyone remembering to assert it.
 *
 * @module tests/helpers/grain-net-worth-invariants
 */
import type { CommodityNetWorthRow } from '@/app-layer/usecases/grain-net-worth';

/** The usecase's own rounding, mirrored so the comparison is exact. */
function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/**
 * `netWorth === netAssetPosition - cashCostTotal`, for every row that has
 * one — plus the refusal's own contract.
 *
 * Throws with the offending row named, because a bare "expected 650, got
 * 750" in a scenario about lease rent is a poor way to learn that the
 * identity broke.
 */
export function assertNetWorthInvariants(rows: readonly CommodityNetWorthRow[]): void {
    for (const row of rows) {
        // ── cashCostTotal IS its four named parts ───────────────────
        //
        // Asserted for every row, refused or not, because this clause is
        // about the COST side and a row can be refused for want of a
        // price while its cost is perfectly well known.
        //
        // The gap this closes: the identity below is written in terms of
        // `cashCostTotal`, so a term added to the sum flows through it and
        // stays green. An imputed land charge, a purchase folded into crop
        // cost, anything not named here: the sum stops matching its own
        // printed slices, which is the #556 defect in the opposite
        // direction.
        //
        // ── why this list grew to four, and what did NOT change ─────
        //
        // #1530 added `typedCropCost` — the farmer's own per-crop figure —
        // and this assertion caught it, which is the whole point of having
        // written it. The rule was never "there are exactly three terms";
        // it is **every term in the sum is printed beside the total**, so a
        // new term is admissible precisely when it is also a row field a
        // surface can show. `typedCropCost` is one, so it joins the list.
        //
        // The teeth are unchanged. A FIFTH term that is not added here
        // still fails, and an imputed or otherwise non-cash term still has
        // no business in the sum whether or not it is printed — see
        // `COST_METRICS.IMPUTED_LAND_CHARGE`, which is reported beside
        // these and deliberately not among them.
        //
        // Note `attributedCropCost` and `typedCropCost` are MUTUALLY
        // EXCLUSIVE per (commodity, season) rather than per commodity, so
        // both being non-zero on one row is correct for a farm that typed a
        // figure for one season and recorded consumption in another. This
        // assertion is about the SUM and deliberately does not police that
        // exclusivity — `grain-net-worth.test.ts` does, where the seasons
        // are visible.
        expect({
            commodity: row.commodity,
            cashCostTotal: row.cashCostTotal,
        }).toEqual({
            commodity: row.commodity,
            cashCostTotal: round2(
                row.attributedCropCost +
                    row.rentCostMoneyAmount +
                    row.payrollCost +
                    row.typedCropCost,
            ),
        });

        if (row.netWorth != null) {
            // A computed net worth cannot rest on an absent asset
            // position: the usecase only reaches the arithmetic once a
            // price exists, and a price is what makes the position real.
            expect({
                commodity: row.commodity,
                netAssetPosition: row.netAssetPosition,
            }).toEqual({
                commodity: row.commodity,
                netAssetPosition: expect.any(Number),
            });

            expect({
                commodity: row.commodity,
                netWorth: row.netWorth,
            }).toEqual({
                commodity: row.commodity,
                netWorth: round2((row.netAssetPosition ?? 0) - row.cashCostTotal),
            });
        } else {
            // A refusal without a reason is the failure mode the whole
            // calculator page is built to prevent. It belongs in the
            // usecase's contract, not only in the island's rendering —
            // the island can only show what it is given.
            expect({
                commodity: row.commodity,
                hasReason:
                    typeof row.netWorthUnavailableReason === 'string' &&
                    row.netWorthUnavailableReason.trim().length > 0,
            }).toEqual({ commodity: row.commodity, hasReason: true });
        }
    }
}
