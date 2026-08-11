/**
 * The three cost metrics this product reports, named apart.
 *
 * ─── The problem ────────────────────────────────────────────────────
 *
 * Three incompatible definitions of "cost" shipped under one word, so the
 * same season showed different totals depending which page you opened:
 *
 *   cost-rollup.ts     LogEntry costs for entries LINKED to a planting,
 *                      plus the cost-bearing stock movements on those same
 *                      entries. Attributed to a crop.
 *   portfolio-grain.ts EVERY LogEntry and EVERY StockTransaction in the
 *                      tenant — including entries linked to no planting,
 *                      and receipts.
 *   season-recap.ts    LogEntry only, scoped by an occurredAt window, with
 *                      no stock at all.
 *
 * ─── The decision ───────────────────────────────────────────────────
 *
 * They are NOT collapsed into one number, because they answer three
 * different questions and each has a legitimate reader:
 *
 *   ATTRIBUTED_CROP_COST  "what did growing this crop cost?" — the only one
 *                         that can carry a per-hectare or per-tonne
 *                         denominator, because only it is tied to a crop
 *                         with an area and a yield.
 *   TENANT_ACTIVITY_SPEND "what did this farm spend?" — deliberately wider:
 *                         an org operator comparing farms wants the money
 *                         that left the business, including work nobody
 *                         attributed to a planting. Forcing this to the
 *                         attributed definition would hide unattributed
 *                         spend, which is exactly the spend worth finding.
 *   SEASON_ACTIVITY_COST  "what did activity in this window cost?" — time-
 *                         scoped rather than link-scoped, because a season
 *                         recap covers a period, and an entry linked to no
 *                         planting still happened during it.
 *
 * What they now share, and what makes them consistent rather than
 * arbitrary: the same movement-type policy (only CONSUMPTION is cost — see
 * `COST_BEARING_MOVEMENTS` in cost-rollup), the same soft-delete filtering,
 * and the same refusal to blend currencies.
 *
 * Each consumer labels its metric with the name below, so a reader who sees
 * two different numbers can tell WHY they differ instead of assuming one is
 * broken.
 *
 * ─── The fourth metric ──────────────────────────────────────────────
 *
 * `GRAIN_NET_WORTH` (`src/app-layer/usecases/grain-net-worth.ts`) is a
 * FOURTH definition, and deliberately not a fourth spelling of one of the
 * three above: it is the first to fold in OVERHEADS — land rent
 * (`ParcelLease`, via `resolveRentBasis`) and payroll/labour spend
 * (`PayrollExpense`) — alongside the attributed field/stock cost it
 * reuses verbatim from `ATTRIBUTED_CROP_COST`.
 *
 * **State this plainly wherever the figure is shown: `GRAIN_NET_WORTH`'s
 * cost side will NOT match `ATTRIBUTED_CROP_COST` for the same season**,
 * even though it starts from the exact same `getCostRollupByPlanting`
 * output — rent and payroll are real farm cost that never had a column in
 * the cost-rollup movement-type policy, so adding them is intentional
 * growth, not drift. A reader who sees the costs page and the net-worth
 * page disagree on "what did this crop cost" is seeing two honestly
 * different questions, not a bug — the whole reason this module exists is
 * to make that difference nameable instead of silently shipping a FOURTH
 * unnamed cost number under the same word "cost".
 */

export const COST_METRICS = {
    /** Cost attributed to a planting: linked field events + their consumed stock. */
    ATTRIBUTED_CROP_COST: 'attributed-crop-cost',
    /** Everything the tenant spent, attributed or not. */
    TENANT_ACTIVITY_SPEND: 'tenant-activity-spend',
    /** Field-event cost inside a season's date window. */
    SEASON_ACTIVITY_COST: 'season-activity-cost',
    /**
     * Attributed crop cost PLUS overheads (land rent + payroll) that none
     * of the three metrics above include — see the module docblock's
     * "fourth metric" section. Will NOT equal `ATTRIBUTED_CROP_COST` for
     * the same season whenever rent or payroll is present.
     */
    GRAIN_NET_WORTH: 'grain-net-worth',
    /**
     * What actually LEFT THE BANK — every `CostEntry` the farmer recorded,
     * grouped by the currency it was recorded in.
     *
     * A FIFTH metric rather than an addition to any of the four above,
     * because it answers a different question and mixing it into one of
     * them would double-count by construction:
     *
     *   • Crop cost is CONSUMPTION-based (`cost-rollup` counts only
     *     CONSUMPTION movements, excluding RECEIPT as working capital).
     *     A FERTILIZER cost entry is the PURCHASE. Counting both bills the
     *     same sack once when bought and again when applied.
     *   • Rent cost is the lease-terms ACCRUAL (`resolveRentBasis`) — what
     *     the farmer owes whether or not a lev has been paid. A RENT entry
     *     is the cash half of that same obligation, not a second cost.
     *
     * So cash-out is reported BESIDE the cost side, never inside it. If a
     * future change wants purchases in crop cost, that is another new
     * named metric here — never a quiet addition to an existing one.
     */
    GRAIN_CASH_OUT: 'grain-cash-out',
} as const;

export type CostMetric = (typeof COST_METRICS)[keyof typeof COST_METRICS];

/**
 * The i18n key each metric's on-screen label lives under, so a page cannot
 * show a cost figure without saying which cost it is.
 */
/**
 * Sentinel for money rent's currency. `ParcelLease` carries no currency
 * column (see rent-basis.ts) — this is NOT an ISO code, and is never
 * treated as one; it only makes an unknown-currency cost visible in
 * `GRAIN_NET_WORTH`'s `cashCostCurrencies` / `cashCostCurrencyMixed`
 * instead of silently assumed to match another figure's currency.
 *
 * It lives HERE, in the shared grain-cost vocabulary, rather than as a
 * module-private const inside `grain-net-worth.ts`, because a value that
 * ships inside a DTO array is not private in any useful sense: the array
 * reaches a client component, and a page that cannot name the sentinel
 * has no way to avoid rendering `Costs in UNKNOWN` at a farmer. The
 * calculator filters on this constant; the usecase writes it. One
 * spelling, both ends. This module is import-free by design, so it is
 * safe to pull into a client bundle.
 */
export const UNKNOWN_RENT_CURRENCY = 'UNKNOWN';

export const COST_METRIC_LABEL_KEYS: Record<CostMetric, string> = {
    [COST_METRICS.ATTRIBUTED_CROP_COST]: 'metricAttributedCropCost',
    [COST_METRICS.TENANT_ACTIVITY_SPEND]: 'metricTenantActivitySpend',
    [COST_METRICS.SEASON_ACTIVITY_COST]: 'metricSeasonActivityCost',
    [COST_METRICS.GRAIN_NET_WORTH]: 'metricGrainNetWorth',
    [COST_METRICS.GRAIN_CASH_OUT]: 'metricGrainCashOut',
};
