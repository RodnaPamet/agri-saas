/**
 * Pure utilities backing the range filter UI.
 *
 * Separated from `filter-range-panel.tsx` so the logic can be unit-tested
 * without loading React / JSX under the node-env jest runner. These are
 * internal helpers: keep them colocated with the panel, not exposed via the
 * barrel (consumers go through `FilterRangePanel`).
 */

/**
 * Swap inverted min/max and drop undefined sides. Returns an empty object
 * when both bounds are absent so callers can short-circuit emit logic.
 */
export function normalizeRangeBounds(
    min?: number,
    max?: number,
): { min?: number; max?: number } {
    if (min == null && max == null) {
        return {};
    }
    if (min != null && max != null && min > max) {
        return { min: max, max: min };
    }
    return { ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) };
}

/**
 * Convert a stored bound (storage units — e.g. cents) into the string shown
 * in the input. At `displayScale === 1` we truncate (integers only); otherwise
 * divide and normalise to two decimal places without trailing zeros.
 */
export function storageToDraft(
    storage: number | undefined,
    displayScale: number,
): string {
    if (storage == null) {
        return "";
    }
    if (displayScale === 1) {
        return String(Math.trunc(storage));
    }
    const display = storage / displayScale;
    return String(Number(display.toFixed(2)));
}

/**
 * Filter a raw keystroke stream down to characters valid for the range input.
 * At `displayScale === 1` only integers are permitted; otherwise at most one
 * decimal point may survive.
 */
export function sanitizeNumericDraft(raw: string, displayScale: number): string {
    if (raw === "") {
        return "";
    }
    if (displayScale === 1) {
        return raw.replace(/\D/g, "");
    }
    let s = raw.replace(/[^0-9.]/g, "");
    const firstDot = s.indexOf(".");
    if (firstDot !== -1) {
        s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
    }
    return s;
}

/**
 * The bounds of a `"lo|hi"` token, as VALIDATED strings.
 *
 * Both range kinds share the token shape but not its alphabet: `range`
 * bounds are numbers, `dateRange` bounds are `YYYY-MM-DD`. Reading a date
 * token with the numeric parser yields `NaN` on both sides — which is how a
 * date pill would come to render the raw `"2026-08-01|2026-08-12"` instead
 * of a window — so validity is decided per kind here, once, rather than at
 * each render site.
 *
 * A side that is present but MALFORMED reads as absent. That is deliberate:
 * a hand-edited URL should degrade to "no min" rather than to the string
 * `"NaN"`, and the server rejects the same token anyway.
 */
export function rangeTokenBounds(
    token: string,
    isDate: boolean,
): { lo: string | null; hi: string | null } {
    const [rawLo = "", rawHi = ""] = String(token).split("|");
    const valid = (raw: string): string | null => {
        const s = raw.trim();
        if (s === "") return null;
        if (isDate) return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
        return Number.isFinite(Number(s)) ? s : null;
    };
    return { lo: valid(rawLo), hi: valid(rawHi) };
}
