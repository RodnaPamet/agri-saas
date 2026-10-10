/**
 * Which SEASON a cost and a planting are talking about, as one comparable key.
 *
 * #1530's exclusivity rule is "one typed figure per (commodity, season)": a
 * farmer-typed `CROP` cost supersedes the consumption-derived cost for the
 * same crop in the same season. That needs the two sides to produce the SAME
 * key, and they arrive with different information:
 *
 *   · a typed `CostEntry` has an optional `seasonId` and a required
 *     `incurredOn`;
 *   · a rollup row has a `Planting`, whose season comes through
 *     `cropPlan.seasonId` and may be null.
 *
 * Owner ruling 2026-10-10 — **the Season containing the date, else its
 * calendar year**. That is what makes the two sides meet: a cost dated inside
 * a Season resolves to that Season's id, which is exactly what a planting of
 * that Season carries. No season picker on the phone, and no new column.
 *
 * ## Why a tagged string and not a nullable id
 *
 * `S:<id>` and `Y:<year>` are different kinds of answer and must never
 * collide. A plain `string | null` would make "no season" one key shared by
 * every unseasoned cost and every unseasoned planting across all years — so a
 * typed 2024 cost would supersede a 2026 planting's consumption cost. Tagging
 * keeps the calendar-year fallback year-specific.
 *
 * ## The edge this leaves, deliberately
 *
 * A typed cost dated OUTSIDE every Season falls back to `Y:<year>`, and can
 * therefore only supersede a planting that ALSO has no season. A planting
 * inside a Season keeps its consumption cost. That is the honest outcome: the
 * farm said the cost belongs to a period it has not defined as a season, and
 * guessing the nearest one would move money on a guess. It is also why the
 * fallback is the YEAR and not "no season at all".
 */

/** A season identity that a cost and a planting can be compared on. */
export type CostSeasonKey = string;

/** Seasons as this module needs them — id plus the window. */
export interface SeasonWindow {
    id: string;
    startDate: Date;
    endDate: Date;
}

/** The key for a known Season id. */
export function seasonKeyOf(seasonId: string): CostSeasonKey {
    return `S:${seasonId}`;
}

/** The key for a calendar year. */
export function yearKeyOf(year: number): CostSeasonKey {
    return `Y:${year}`;
}

/**
 * The key a planting contributes — its Season when it has one, else the year
 * of the date the caller считает its own (the rollup passes nothing, so an
 * unseasoned planting is `null` and takes part in no supersession).
 */
export function plantingSeasonKey(seasonId: string | null | undefined): CostSeasonKey | null {
    return seasonId != null ? seasonKeyOf(seasonId) : null;
}

/**
 * The key a typed cost contributes.
 *
 * `seasonId` wins when the farmer linked one — an explicit answer beats an
 * inferred one. Otherwise the Season whose window CONTAINS `incurredOn`, and
 * failing that the calendar year.
 *
 * Both bounds are INCLUSIVE. A cost dated exactly on a season's `endDate`
 * belongs to it; treating the end as exclusive would drop the last day of
 * every season into the year fallback, where it would stop superseding the
 * plantings it was typed for — one wrong day per season, and invisible.
 *
 * Overlapping seasons are resolved DETERMINISTICALLY rather than refused:
 * earliest `startDate`, then lowest id. Nothing in the schema forbids two
 * seasons covering one date, and a rule that depended on row order would move
 * money between refreshes. Refusing would be worse — it would withhold a
 * figure over a data shape the farm is allowed to have.
 */
export function costSeasonKey(
    cost: { seasonId: string | null | undefined; incurredOn: Date },
    seasons: readonly SeasonWindow[],
): CostSeasonKey {
    if (cost.seasonId != null) return seasonKeyOf(cost.seasonId);

    const t = cost.incurredOn.getTime();
    let best: SeasonWindow | null = null;
    for (const s of seasons) {
        if (t < s.startDate.getTime() || t > s.endDate.getTime()) continue;
        if (
            best == null ||
            s.startDate.getTime() < best.startDate.getTime() ||
            (s.startDate.getTime() === best.startDate.getTime() && s.id < best.id)
        ) {
            best = s;
        }
    }
    if (best != null) return seasonKeyOf(best.id);

    // UTC, matching how `incurredOn` is stored and compared everywhere else
    // here. `getFullYear()` would read the runner's local year and put a
    // 1 January cost in the previous season on any machine behind UTC.
    return yearKeyOf(cost.incurredOn.getUTCFullYear());
}

/** The (crop, season) identity the exclusivity rule is keyed on. */
export function cropSeasonKey(commodity: string, season: CostSeasonKey): string {
    return `${commodity}@${season}`;
}
