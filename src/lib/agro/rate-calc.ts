/**
 * Per-decare rate calculator for spray/fertilizer jobs.
 *
 * Rates are entered PER DECARE (the Bulgarian standard: 1 ha = 10 dca).
 * Parcel areas are stored in hectares, so the total amount needed for a
 * parcel is `ratePerDca × (areaHa × 10)`.
 *
 * Example: a 10 ha parcel (= 100 dca) at 14 L/dca water and 100 ml/dca
 * product needs 1400 L water and 10 L product.
 *
 * Pure functions only — safe to use in the wizard (live preview) and on
 * the operator/task view (recompute from the persisted rate).
 */

/** Decares per hectare (1 ha = 10 dca). */
export const DCA_PER_HA = 10;

/** Convert a hectare area to decares. */
export function haToDca(areaHa: number): number {
    if (!Number.isFinite(areaHa)) return 0;
    return areaHa * DCA_PER_HA;
}

/**
 * Convert a decare area to hectares — the inverse of {@link haToDca}.
 * Same `DCA_PER_HA` factor (divide instead of multiply), so a value
 * round-trips through both functions unchanged.
 *
 * Also the correct operation for the OTHER direction a rate travels at
 * the UI boundary: a кг/дка figure the user typed is per-decare, and a
 * per-hectare rate is a LARGER number for the same physical total (a
 * hectare holds ten decares' worth). Converting кг/дка → кг/ha is a
 * `× DCA_PER_HA`, i.e. `haToDca`; converting a stored кг/ha value BACK
 * to кг/дка for display is `÷ DCA_PER_HA`, i.e. this function. See
 * `PlannedYieldField` in the planting UI for the call site.
 */
export function dcaToHa(areaDca: number): number {
    if (!Number.isFinite(areaDca)) return 0;
    return areaDca / DCA_PER_HA;
}

/**
 * Total amount needed for an area = per-decare rate × the area's decares.
 * Returns 0 for non-finite inputs so callers can render a tidy "—"/0.
 */
export function totalForArea(ratePerDca: number, areaHa: number): number {
    if (!Number.isFinite(ratePerDca) || !Number.isFinite(areaHa)) return 0;
    return ratePerDca * haToDca(areaHa);
}

/**
 * The amount unit at the head of a RATE symbol:
 *   "ml/dca" → "ml", "L/ha" → "L", "kg/dca" → "kg".
 * Falls back to the whole trimmed symbol when there's no `/` form.
 */
export function amountUnitOf(rateSymbol: string): string {
    return (rateSymbol.split('/')[0] ?? '').trim();
}

/**
 * Area basis encoded in a RATE symbol's denominator. Per-decare units
 * ("кг/дка" / "L/dca") multiply by the parcel's decares; everything else is
 * treated as per-hectare ("кг/ха" / "L/ha") and multiplies by hectares.
 * Recognises both the Bulgarian ('дка') and Latin ('dca') decare denominators
 * so the seeded Cyrillic symbols stay dimensionally correct.
 */
export function areaBasisOf(rateSymbol: string): 'ha' | 'dca' {
    const denom = (rateSymbol.split('/')[1] ?? '').toLowerCase();
    return denom.includes('dca') || denom.includes('дка') ? 'dca' : 'ha';
}

/**
 * Total amount for an area, honoring the rate's OWN basis: a `/dca` rate
 * multiplies by decares, a `/ha` rate by hectares. Returns 0 for
 * non-finite inputs.
 */
export function totalForRate(
    ratePerUnit: number,
    rateSymbol: string,
    areaHa: number,
): number {
    if (!Number.isFinite(ratePerUnit) || !Number.isFinite(areaHa)) return 0;
    const area = areaBasisOf(rateSymbol) === 'dca' ? haToDca(areaHa) : areaHa;
    return ratePerUnit * area;
}

/** Round to ≤2dp and drop trailing zeros ("10.00" → "10", "2.50" → "2.5"). */
export function trimNumber(n: number): string {
    if (!Number.isFinite(n)) return '0';
    return String(Math.round(n * 100) / 100);
}

/**
 * Format a total for display, promoting small→large units when the total
 * is large: ml→L and g→kg at ≥ 1000. Other units pass through with the
 * raw amount unit preserved.
 *   formatTotal(10000, "ml/dca") → "10 L"
 *   formatTotal(1400,  "L/dca")  → "1400 L"
 *   formatTotal(100,   "ml/dca") → "100 ml"
 */
export function formatTotal(total: number, rateSymbol: string): string {
    const raw = amountUnitOf(rateSymbol);
    const lower = raw.toLowerCase();
    if ((lower === 'ml' || lower === 'g') && total >= 1000) {
        const big = lower === 'ml' ? 'L' : 'kg';
        return `${trimNumber(total / 1000)} ${big}`;
    }
    return `${trimNumber(total)} ${raw}`.trim();
}

/**
 * Convenience: compute AND format the total for a parcel/area, honoring
 * the rate's /ha or /dca basis.
 */
export function totalLabel(
    ratePerUnit: number,
    rateSymbol: string,
    areaHa: number,
): string {
    return formatTotal(totalForRate(ratePerUnit, rateSymbol, areaHa), rateSymbol);
}
