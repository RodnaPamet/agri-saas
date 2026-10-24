/**
 * The farm-level per-decare rates, folded from the per-commodity rows.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * Both clients were computing it. `farm-total.ts` folds the farm's MONEY
 * server-side so the two cannot disagree; the per-decare rates had no such
 * fold, so agrent-ios added `FarmFigures` and did the arithmetic on the
 * phone while the web showed only `farm.totals`. Two clients dividing the
 * same sums by their own choice of denominator is a drift waiting to be
 * reported as a bug on whichever screen the farmer looked at second
 * (#2249).
 *
 * A fold, not a query: every input is already computed by the usecase, so
 * this adds no read and cannot trip the D1/D2 query guardrails.
 *
 * ── Three figures, two denominators, and that is the whole difficulty ──
 *
 * `PerAreaFigures` is emphatic that each figure names its own denominator
 * "so the two cannot drift: a client multiplying back up gets the number
 * the server divided by, by construction" (#1512). That constraint does not
 * relax one level up — it gets worse, because WHICH rows contributed now
 * varies per figure. So every currency entry carries both denominators it
 * actually divided by:
 *
 *   - `areaDca`     — Σ `areaDca` over the rows that had a value rate. The
 *                     yield-covered area, and the denominator of
 *                     `standingValuePerDca` and `marginPerDca`.
 *   - `costAreaDca` — Σ land over the rows that had a cost rate, where land
 *                     is `costAreaDca ?? areaDca`. The denominator of
 *                     `attributableCostPerDca`.
 *
 * `FarmPerAreaFigures.areaDca` is a THIRD number and not a duplicate of
 * either: it is Σ land over EVERY row, which is the farm's land — what a
 * farmer recognises as the size of their farm. It is deliberately outside
 * the currency entries because land has no currency. Showing it beside a
 * rate would be the #1512 mistake again, which is why the rates sit next to
 * their own denominators instead.
 *
 * ── Why the entries are per CURRENCY, and why `null` is one of them ────
 *
 * This product does not blend currencies (#1614) and there is no FX table
 * anywhere in the repo. Value and margin follow the row's `priceCurrency`;
 * the cost rate follows `perArea.costCurrency`, which is a different field
 * and can legitimately differ on the same row.
 *
 * A `costCurrency` of `null` is an INSTRUCTION rather than an absence — the
 * convention `PerAreaFigures.costCurrency` documents is "use your tenant
 * symbol", because net worth makes the same assumption in the same
 * situation. So `null` is a real bucket here, carried through rather than
 * collapsed into a sentinel. It can only ever arise from the cost side; see
 * the next paragraph for why.
 *
 * A row whose `priceCurrency` is null contributes to NO value or margin
 * bucket and is named in neither `without` list. That is `foldFarmTotals`'
 * rule, followed deliberately rather than re-decided: such a row has no
 * market price, so it is "not attributable to any bucket and appears in
 * none", and the caller already reports those as a farm-wide omission on
 * `GrainNetWorthResult.farm`. Inventing a second meaning for `null` on the
 * value side would make the one on the cost side unreadable.
 *
 * ── Why a refused cost EXCLUDES the row from the farm margin ───────────
 *
 * A row's own `marginPerDca` can be present while its `attributableCostPerDca`
 * is refused for mixed cost currencies — and in that state the row's margin
 * has blended the currencies the cost rate declined to blend. That is #2259,
 * a pre-existing defect in `computePerArea` which this module does not try to
 * fix and must not inherit: folding such a row in would put a figure denominated
 * in no currency at all into the farm's margin.
 *
 * So a row contributes to the farm margin only when its cost rate is present
 * AND its cost currency agrees with its price currency. Everything else is
 * named in `without.marginPerDca`, which is what that list is for. This keeps
 * the farm figure correct however #2259 is resolved.
 *
 * `costCurrency === null` COUNTS as agreement, and that is not laxity: net
 * worth assumes the tenant's display currency in exactly that situation
 * (`farm-total.ts` says so of its own fold), and being stricter here would
 * make the farm's margin disagree with the farm's net worth on the same
 * farm — two figures on one screen, differing for a reason no farmer could
 * see.
 *
 * @module lib/grain/farm-per-area
 */
import { costIsFloor, UNCERTAINTY, type UncertaintyInput, type UncertaintyState } from './uncertainty';

/** The per-row `perArea` fields the fold reads — nothing more, so it stays pure. */
export interface FarmPerAreaRowFigures {
    areaDca: number;
    costAreaDca: number;
    standingValuePerDca: number | null;
    attributableCostPerDca: number | null;
    marginPerDca: number | null;
    costCurrency: string | null;
}

/** The row fields the fold reads. */
export interface FarmPerAreaInput extends UncertaintyInput {
    commodity: string;
    /** The currency the row's VALUE and MARGIN are in. Null = no market price. */
    priceCurrency: string | null;
    perArea: FarmPerAreaRowFigures;
}

/** What each figure left out, by commodity. Sorted, so a client can compare them. */
export interface FarmPerAreaOmissions {
    standingValuePerDca: string[];
    attributableCostPerDca: string[];
    marginPerDca: string[];
}

export interface FarmPerAreaCurrencyTotal {
    /** `null` means the tenant's display currency — see the module note. */
    currency: string | null;
    /** Denominator of `standingValuePerDca` and `marginPerDca`, in decares. */
    areaDca: number;
    /** Denominator of `attributableCostPerDca`, in decares. */
    costAreaDca: number;
    standingValuePerDca: number | null;
    attributableCostPerDca: number | null;
    marginPerDca: number | null;
    without: FarmPerAreaOmissions;
    /**
     * Qualifies `marginPerDca` specifically, composed from the rows that
     * contributed to it — never invented here.
     *
     * `atMost` when any contributing row's cost is a floor, so the margin is a
     * ceiling; `partial` when a row that belongs in this bucket was left out;
     * `refused` when nothing contributed. Same vocabulary and the same
     * position as `FarmNetWorthTotal.uncertainty`, which both clients already
     * decode — a bare `atMost` boolean would have lost `partial` and
     * `allocated`, which this figure genuinely can be.
     */
    uncertainty: UncertaintyState;
}

export interface FarmPerAreaFigures {
    /**
     * Σ (`costAreaDca` ?? `areaDca`) over EVERY row — the farm's land, in
     * decares. Currency-independent, and NOT the denominator of any rate
     * below. See the module note.
     */
    areaDca: number;
    /** One entry per currency; never blended. Most land first. */
    byCurrency: FarmPerAreaCurrencyTotal[];
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** The land a row occupies: the cost denominator, falling back to the value one. */
function landOf(row: FarmPerAreaInput): number {
    return row.perArea.costAreaDca ?? row.perArea.areaDca;
}

/**
 * A weighted mean, or null when nothing carried the rate.
 *
 * Σ(rate × weight) / Σweight rather than a mean of the rates: a 200-decare
 * wheat block and a 3-decare trial plot are not two equal opinions about
 * lv/dca. Null when the weight sums to zero as well as when no row
 * qualifies — a rate divided by no land is not 0, it is absent.
 */
function weightedRate(
    rows: readonly FarmPerAreaInput[],
    rate: (r: FarmPerAreaInput) => number | null,
    weight: (r: FarmPerAreaInput) => number,
): { value: number | null; weight: number } {
    let numerator = 0;
    let denominator = 0;
    for (const row of rows) {
        const r = rate(row);
        if (r == null) continue;
        const w = weight(row);
        if (!(w > 0)) continue;
        numerator += r * w;
        denominator += w;
    }
    if (denominator <= 0) return { value: null, weight: 0 };
    return { value: round2(numerator / denominator), weight: round2(denominator) };
}

/**
 * True when the row's cost may be subtracted from its value in one currency.
 *
 * Both halves matter: a refused cost rate means #2259's blend, and a cost
 * currency that differs from the price currency cannot be subtracted at all.
 */
function marginIsSingleCurrency(row: FarmPerAreaInput): boolean {
    if (row.perArea.marginPerDca == null) return false;
    if (row.perArea.attributableCostPerDca == null) return false;
    const cost = row.perArea.costCurrency;
    return cost == null || cost === row.priceCurrency;
}

function names(rows: readonly FarmPerAreaInput[]): string[] {
    return rows.map((r) => r.commodity).sort();
}

/**
 * One entry per currency, most land first.
 *
 * Ordered by land rather than alphabetically for `foldFarmTotals`' reason:
 * the farm's main currency is the answer a farmer came for, and a rounding
 * remnant sorting above it would bury the number. Ties break on the currency
 * code so the output is deterministic — `null` last, since it is a fallback
 * rather than a currency.
 */
export function foldFarmPerArea(rows: readonly FarmPerAreaInput[]): FarmPerAreaFigures {
    const farmLand = round2(rows.reduce((acc, r) => acc + landOf(r), 0));

    // Every currency that either side of any row names. A Map keyed on the
    // string|null directly, so the null bucket is a key rather than a sentinel
    // that could collide with a real code.
    const currencies = new Set<string | null>();
    for (const row of rows) {
        if (row.priceCurrency != null) currencies.add(row.priceCurrency);
        if (row.perArea.attributableCostPerDca != null) currencies.add(row.perArea.costCurrency);
    }

    const byCurrency: FarmPerAreaCurrencyTotal[] = [];
    for (const currency of currencies) {
        // Two different populations, because the two sides key on two
        // different fields. A row can be in one and not the other.
        const valueRows = rows.filter((r) => r.priceCurrency != null && r.priceCurrency === currency);
        const costRows = rows.filter(
            (r) => r.perArea.attributableCostPerDca != null && r.perArea.costCurrency === currency,
        );

        const value = weightedRate(valueRows, (r) => r.perArea.standingValuePerDca, (r) => r.perArea.areaDca);
        const cost = weightedRate(costRows, (r) => r.perArea.attributableCostPerDca, landOf);

        const marginRows = valueRows.filter(marginIsSingleCurrency);
        const margin = weightedRate(marginRows, (r) => r.perArea.marginPerDca, (r) => r.perArea.areaDca);

        byCurrency.push({
            currency,
            // The denominators ACTUALLY divided by, not a recomputation — see
            // the module note. The value side's is the one the rate used, so a
            // client multiplying back up lands on the numerator.
            areaDca: value.weight,
            costAreaDca: cost.weight,
            standingValuePerDca: value.value,
            attributableCostPerDca: cost.value,
            marginPerDca: margin.value,
            without: {
                standingValuePerDca: names(
                    valueRows.filter((r) => r.perArea.standingValuePerDca == null),
                ),
                attributableCostPerDca: names(
                    rows.filter(
                        (r) =>
                            r.perArea.attributableCostPerDca == null &&
                            r.priceCurrency != null &&
                            r.priceCurrency === currency,
                    ),
                ),
                marginPerDca: names(valueRows.filter((r) => !marginIsSingleCurrency(r))),
            },
            uncertainty: composeMarginUncertainty(valueRows, marginRows),
        });
    }

    return {
        areaDca: farmLand,
        byCurrency: byCurrency.sort(
            (a, b) =>
                b.areaDca + b.costAreaDca - (a.areaDca + a.costAreaDca) ||
                (a.currency ?? '￿').localeCompare(b.currency ?? '￿'),
        ),
    };
}

/**
 * The margin's qualifier, from the rows that actually contributed.
 *
 * Same precedence as `composeFarmUncertainty`, but keyed on MARGIN presence
 * rather than on `netWorth`: a row can have a net worth and no margin, and
 * the reverse. Reusing that function would have filtered on the wrong field
 * and reported a figure's completeness by another figure's rows.
 */
function composeMarginUncertainty(
    bucket: readonly FarmPerAreaInput[],
    contributing: readonly FarmPerAreaInput[],
): UncertaintyState {
    if (contributing.length === 0) return UNCERTAINTY.REFUSED;
    if (contributing.length < bucket.length) return UNCERTAINTY.PARTIAL;
    if (contributing.some(costIsFloor)) return UNCERTAINTY.AT_MOST;
    if (contributing.some((r) => r.payrollAllocated)) return UNCERTAINTY.ALLOCATED;
    return UNCERTAINTY.EXACT;
}
