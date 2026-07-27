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
 */

export const COST_METRICS = {
    /** Cost attributed to a planting: linked field events + their consumed stock. */
    ATTRIBUTED_CROP_COST: 'attributed-crop-cost',
    /** Everything the tenant spent, attributed or not. */
    TENANT_ACTIVITY_SPEND: 'tenant-activity-spend',
    /** Field-event cost inside a season's date window. */
    SEASON_ACTIVITY_COST: 'season-activity-cost',
} as const;

export type CostMetric = (typeof COST_METRICS)[keyof typeof COST_METRICS];

/**
 * The i18n key each metric's on-screen label lives under, so a page cannot
 * show a cost figure without saying which cost it is.
 */
export const COST_METRIC_LABEL_KEYS: Record<CostMetric, string> = {
    [COST_METRICS.ATTRIBUTED_CROP_COST]: 'metricAttributedCropCost',
    [COST_METRICS.TENANT_ACTIVITY_SPEND]: 'metricTenantActivitySpend',
    [COST_METRICS.SEASON_ACTIVITY_COST]: 'metricSeasonActivityCost',
};
