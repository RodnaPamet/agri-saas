/**
 * Moisture basis — making two grain tonnages comparable.
 *
 * ─── Why this module exists ─────────────────────────────────────────
 *
 * `YieldRecord.moisturePct` was stored and displayed and used in ZERO
 * calculations. So 90 t at 18% moisture and 90 t at 13.5% were summed into
 * one season total, ranked against each other in t/ha tables, and printed
 * side by side in the year-end PDF as if they were the same quantity of
 * grain. They are not: the wetter load carries ~4.5% more water and
 * correspondingly less sellable dry matter. In a product where trade settles
 * at a standard basis, presenting those two numbers as like-for-like is a
 * measurement error, not a rounding one.
 *
 * ─── The conversion ─────────────────────────────────────────────────
 *
 * Water is the only variable being removed, so the dry matter is invariant:
 *
 *     dry mass            = gross × (100 − m) / 100
 *     mass at standard    = dry mass / ((100 − s) / 100)
 *                         = gross × (100 − m) / (100 − s)
 *
 * where `m` is the measured moisture % and `s` is STANDARD_MOISTURE_PCT.
 * This is the ordinary shrink formula. It is SYMMETRIC: grain drier than the
 * standard converts UP (0.5 t at 10% is more sellable grain than 0.5 t at
 * 14%), grain wetter converts DOWN.
 *
 * That symmetry is deliberate and worth stating, because commercial
 * settlement is usually asymmetric — a buyer shrinks wet grain but rarely
 * pays a bonus for dry. Settlement is a pricing question and belongs to the
 * contract, not here. What this module answers is the measurement question:
 * "expressed on one common basis, how much grain is this?" — which is the
 * only way a sum or a t/ha ranking means anything. Conflating the two would
 * bake a commercial policy into an agronomic figure.
 *
 * ─── Unknown moisture ──────────────────────────────────────────────
 *
 * Returns `null` when moisture was not measured, and callers must NOT treat
 * that as "assume standard". A record with no moisture reading is a record
 * whose comparable weight is unknown; the aggregates report those tonnes
 * separately (see `season-recap` / `portfolio-grain`) so an operator can see
 * how much of a total is unadjusted rather than being told a precise-looking
 * number that quietly mixes bases again.
 */

/**
 * The basis every comparable tonnage is expressed at, in percent.
 *
 * 14.0% is the standard delivery basis for the cereals this product is used
 * for (wheat, barley, maize) across the EU trade, and the one Bulgarian
 * elevators settle at. It is a single constant rather than a per-commodity
 * table on purpose: one basis is what makes cross-commodity season totals
 * addable at all, and a per-commodity basis would need a settlement model to
 * be meaningful. If that arrives, this constant is the seam to widen.
 */
export const STANDARD_MOISTURE_PCT = 14.0;

/**
 * The widest moisture reading that can be a real measurement.
 *
 * Grain above ~40% is not grain being harvested, it is a data-entry error —
 * and the column (`Decimal(5,2)`) happily accepted 999.99%, which then
 * produced a NEGATIVE adjusted tonnage. Bounding the input is what keeps the
 * formula's output physical.
 */
export const MAX_PLAUSIBLE_MOISTURE_PCT = 40.0;

/**
 * Convert a gross tonnage measured at `moisturePct` into its equivalent at
 * `STANDARD_MOISTURE_PCT`.
 *
 * Returns null when either input is missing, when moisture is outside the
 * plausible range, or when the gross tonnage is negative — in every one of
 * those cases the honest answer is "not comparable", not a number.
 *
 * @example netTonnesAtStandardMoisture(90, 18)   // → 86.279 (wetter → less)
 * @example netTonnesAtStandardMoisture(90, 13.5) // → 90.523 (drier → more)
 * @example netTonnesAtStandardMoisture(90, 14)   // → 90 (already at basis)
 */
export function netTonnesAtStandardMoisture(
    grossTonnes: number | null | undefined,
    moisturePct: number | null | undefined,
): number | null {
    if (grossTonnes == null || moisturePct == null) return null;
    if (!Number.isFinite(grossTonnes) || !Number.isFinite(moisturePct)) return null;
    if (grossTonnes < 0) return null;
    if (moisturePct < 0 || moisturePct > MAX_PLAUSIBLE_MOISTURE_PCT) return null;

    const net = (grossTonnes * (100 - moisturePct)) / (100 - STANDARD_MOISTURE_PCT);
    // Decimal(14,3) is the tonnage precision everywhere in the grain module;
    // round here so the value we compute and the value we store agree.
    return Math.round(net * 1e3) / 1e3;
}

/**
 * Yield per hectare — ONE definition, product-wide.
 *
 * The denominator is the HARVESTED area (`YieldRecord.areaHa`), which is the
 * agronomically correct one: yield is what came off the ground that was
 * actually cut. It is deliberately NOT the whole-farm or whole-parcel area —
 * dividing a partial harvest by a full parcel understates the crop, and
 * dividing by every parcel a farm owns produces a "t/ha" that no agronomist
 * would recognise. The season recap and the year-end PDF previously did the
 * latter, which is why the same harvest printed 7.0 t/ha on screen and
 * 4.2 t/ha in the PDF.
 *
 * The numerator is the moisture-adjusted tonnage where moisture is known, so
 * two fields are ranked on one basis. Callers pass whichever tonnage they
 * have and say so in their labels; what they must not do is mix them inside
 * one comparison.
 *
 * Returns null when either input is missing or the area is zero — a division
 * by zero is not "0 t/ha", it is undefined, and the zero-guard is the reason
 * this helper exists rather than an inline division at each call site.
 */
export function tonnesPerHectare(
    tonnes: number | null | undefined,
    areaHa: number | null | undefined,
): number | null {
    if (tonnes == null || areaHa == null) return null;
    if (!Number.isFinite(tonnes) || !Number.isFinite(areaHa)) return null;
    if (areaHa <= 0) return null;
    return Math.round((tonnes / areaHa) * 1e4) / 1e4;
}
