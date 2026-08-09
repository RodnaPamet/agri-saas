/**
 * Epic 41 — KPI trend computation.
 *
 * Pure, deterministic math for the trend indicator on `<KpiCard>`.
 * Lives outside the component so:
 *
 *   - Tests can exercise edge cases (zero baseline, missing
 *     previous, negative deltas, ambiguous polarity) without
 *     React render machinery.
 *   - Server-rendered consumers (e.g. CSV export) can derive the
 *     same trend semantic without importing the React component.
 *
 * Polarity model — every KPI tile carries one of three values:
 *
 *   - `up-good`   — positive delta is GOOD (green). Examples:
 *                   coverage %, completed-practices count, MFA-enabled
 *                   user count.
 *   - `down-good` — negative delta is GOOD (green). Examples:
 *                   overdue-evidence count, open-incident count,
 *                   critical-risk count.
 *   - `neutral`   — direction has no semantic. Examples: tenant
 *                   count, total-practices count.
 *
 * Picking the right polarity is a per-metric decision; getting it
 * wrong displays "growth in critical risks" as a green arrow,
 * which is actively harmful — hence why the polarity is a per-
 * widget config field, not a global default.
 *
 * Edge cases handled explicitly:
 *
 *   - `current` is null/undefined        → `unavailable` (no trend)
 *   - `previous` is null/undefined       → `unavailable`
 *   - `previous === 0` && `current === 0`→ `flat`
 *   - `previous === 0` && `current > 0`  → `unavailable: baseline_zero`
 *                                          (% change is mathematically
 *                                          undefined; we don't fake it)
 *   - delta sign + polarity              → semantic resolved per the
 *                                          polarity model above
 */

export type TrendPolarity = 'up-good' | 'down-good' | 'neutral';

/** Display semantic — drives the colour token at the renderer. */
export type TrendSemantic = 'good' | 'bad' | 'neutral';

/** Direction of the change. `flat` when delta is exactly zero. */
export type TrendDirection = 'up' | 'down' | 'flat';

/**
 * Reasons a trend can't be computed. Surfaced so the UI can render
 * different placeholders ("baseline pending" vs "metric paused").
 */
export type TrendUnavailableReason =
    | 'no_current'         // current value is null/undefined
    | 'no_baseline'        // previous value is null/undefined
    | 'baseline_zero';     // previous === 0 (and current ≠ 0)

export interface TrendComputed {
    kind: 'computed';
    direction: 'up' | 'down';
    deltaAbsolute: number;
    deltaPercent: number;
    semantic: TrendSemantic;
}

export interface TrendFlat {
    kind: 'flat';
    direction: 'flat';
    deltaAbsolute: 0;
    deltaPercent: 0;
    semantic: 'neutral';
}

export interface TrendUnavailable {
    kind: 'unavailable';
    reason: TrendUnavailableReason;
}

export type TrendResult = TrendComputed | TrendFlat | TrendUnavailable;

export interface ComputeKpiTrendInput {
    current: number | null | undefined;
    previous: number | null | undefined;
    polarity?: TrendPolarity;
}

/**
 * Pure trend computation. The output is one of three discriminated
 * shapes; renderers narrow on `kind`.
 *
 * Why % uses `Math.abs(previous)` in the denominator:
 *
 *   A baseline of `-10` going to `-5` is a 50% improvement, not
 *   a -50% degradation. Dividing by the absolute value keeps the
 *   sign information in the numerator only.
 */
export function computeKpiTrend(input: ComputeKpiTrendInput): TrendResult {
    const polarity = input.polarity ?? 'up-good';

    if (input.current === null || input.current === undefined) {
        return { kind: 'unavailable', reason: 'no_current' };
    }
    if (input.previous === null || input.previous === undefined) {
        return { kind: 'unavailable', reason: 'no_baseline' };
    }

    if (input.previous === 0) {
        if (input.current === 0) {
            return {
                kind: 'flat',
                direction: 'flat',
                deltaAbsolute: 0,
                deltaPercent: 0,
                semantic: 'neutral',
            };
        }
        return { kind: 'unavailable', reason: 'baseline_zero' };
    }

    const deltaAbsolute = input.current - input.previous;
    if (deltaAbsolute === 0) {
        return {
            kind: 'flat',
            direction: 'flat',
            deltaAbsolute: 0,
            deltaPercent: 0,
            semantic: 'neutral',
        };
    }

    const deltaPercent =
        (deltaAbsolute / Math.abs(input.previous)) * 100;
    const direction: 'up' | 'down' = deltaAbsolute > 0 ? 'up' : 'down';

    let semantic: TrendSemantic;
    if (polarity === 'neutral') {
        semantic = 'neutral';
    } else if (
        (polarity === 'up-good' && direction === 'up') ||
        (polarity === 'down-good' && direction === 'down')
    ) {
        semantic = 'good';
    } else {
        semantic = 'bad';
    }

    return {
        kind: 'computed',
        direction,
        deltaAbsolute,
        deltaPercent,
        semantic,
    };
}

/**
 * Format helpers for the UI. Kept here so the math + display
 * vocabulary live next to each other; the renderer just consumes
 * the strings.
 */

/** Formats a percentage delta with sign + one decimal + `%`. */
export function formatTrendPercent(deltaPercent: number): string {
    const sign = deltaPercent > 0 ? '+' : deltaPercent < 0 ? '−' : '';
    return `${sign}${Math.abs(deltaPercent).toFixed(1)}%`;
}

/**
 * Formats an absolute-value delta with sign + the format-aware
 * suffix. `pp` (percentage points) for percent metrics; bare for
 * counts. Mirrors the existing KpiCard delta convention.
 */
export function formatTrendAbsolute(
    deltaAbsolute: number,
    format: 'number' | 'percent' | 'compact',
): string {
    const sign = deltaAbsolute > 0 ? '+' : deltaAbsolute < 0 ? '−' : '';
    const magnitude = Math.abs(deltaAbsolute);
    if (format === 'percent') {
        return `${sign}${magnitude.toFixed(1)}pp`;
    }
    if (format === 'compact') {
        if (magnitude >= 1_000_000) {
            return `${sign}${(magnitude / 1_000_000).toFixed(1)}M`;
        }
        if (magnitude >= 1_000) {
            return `${sign}${(magnitude / 1_000).toFixed(1)}K`;
        }
        return `${sign}${magnitude.toLocaleString()}`;
    }
    return `${sign}${magnitude.toLocaleString()}`;
}

/**
 * Direction icon rendered next to the trend label. Returns the
 * exact Unicode chars the existing KpiCard already uses so the
 * visual stays continuous.
 */
export function trendDirectionIcon(direction: TrendDirection): string {
    switch (direction) {
        case 'up':
            return '▲';
        case 'down':
            return '▼';
        case 'flat':
            return '—';
    }
}
