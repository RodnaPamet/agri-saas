/**
 * KpiCard — Reusable executive KPI stat card.
 *
 * Renders a headline numeric value with label, optional subtitle,
 * optional delta/trend indicator, optional icon, and optional
 * inline sparkline (Epic 59 `MiniAreaChart`) so an exec can read
 * both the current number and the 30-day direction at a glance.
 *
 * Design language:
 *   - glass-card container with hover lift
 *   - gradient text for the headline value
 *   - Inter font (inherited from globals)
 *   - Dark theme compatible (slate-400/500 for secondary text)
 *
 * @example
 * ```tsx
 * <KpiCard
 *     label="Practice Coverage"
 *     value={75.3}
 *     format="percent"
 *     icon={ShieldCheck}
 *     gradient="from-emerald-500 to-teal-500"
 *     subtitle="15 of 20 implemented"
 *     trend={[{ date, value }, ...]}
 *     trendVariant="success"
 * />
 * ```
 */
import { type ElementType } from 'react';

import { AnimatedNumber, type AnimatedNumberFormat } from '@/components/ui/animated-number';
import { MetricCard } from '@/components/ui/MetricCard';
import { MiniAreaChart, type MiniAreaChartVariant } from '@/components/ui/mini-area-chart';
import { ShimmerDots } from '@/components/ui/shimmer-dots';
import { computeKpiTrend, formatTrendAbsolute, formatTrendPercent, trendDirectionIcon, type TrendPolarity } from '@/lib/kpi-trend';

// ─── Props ──────────────────────────────────────────────────────────

export type KpiFormat = 'number' | 'percent' | 'compact';

export interface KpiCardProps {
    /** Card label (top-left, small caps) */
    label: string;
    /** Headline value */
    value: number | null | undefined;
    /** How to format the value */
    format?: KpiFormat;
    /** Optional icon component — any icon family (Lucide or the
     *  canonical Nucleo set); forwarded to MetricCard's ElementType slot. */
    icon?: ElementType;
    /** Tailwind gradient classes for headline text, e.g. "from-blue-500 to-cyan-500" */
    gradient?: string;
    /** Secondary text below the value */
    subtitle?: string;
    /**
     * Delta from previous period — shows as ▲/▼ with color.
     *
     * Two ways to drive the trend indicator:
     *   1. **Pre-computed** — pass `delta` (caller owns the math).
     *      Polarity flag still applies for colour. Right path when
     *      "vs what" isn't a simple subtraction (running averages,
     *      weighted scores, multi-period composite metrics).
     *   2. **Auto-compute** — pass `previousValue` and let the card
     *      compute delta + percent. Edge cases (null, zero baseline,
     *      negative baseline) are handled by `computeKpiTrend`.
     *
     * If both are passed, `delta` wins (explicit > derived).
     */
    delta?: number | null;
    /** What the delta represents (e.g. "vs last quarter"). */
    deltaLabel?: string;
    /**
     * Previous-period value for auto-computed trend. Null = baseline
     * missing → indicator hidden. See `computeKpiTrend` for the full
     * edge-case matrix (zero baseline, negative baseline).
     */
    previousValue?: number | null;
    /**
     * Polarity of the metric for good/bad colouring.
     *   - `up-good`   — positive delta is GREEN (default; matches
     *                   the prior behaviour for back-compat).
     *   - `down-good` — negative delta is GREEN (overdue evidence,
     *                   critical risks, open incidents).
     *   - `neutral`   — colour always subtle (tenant count, total
     *                   practices — direction has no semantic).
     *
     * Picking the wrong polarity displays "growth in critical
     * risks" as a green arrow, which is actively harmful — hence
     * why this is per-widget config, not a global default.
     */
    trendPolarity?: TrendPolarity;
    /** Optional CSS class on the outer container */
    className?: string;
    /** Optional test-id */
    id?: string;
    /** Optional sparkline data — ordered oldest→newest. Renders below the value row when provided. */
    trend?: ReadonlyArray<{ date: Date; value: number }>;
    /** Token-backed variant for the sparkline. Defaults to "brand". */
    trendVariant?: MiniAreaChartVariant;
    /** Override the sparkline's accessible label. Defaults to `${label} 30-day trend`. */
    trendAriaLabel?: string;
    /**
     * Epic 64 — show animated `<ShimmerDots>` in place of the
     * headline value (and suppress the trend indicator) while the
     * underlying data is loading. Distinct from `value === null`,
     * which renders the static `—` "no data" placeholder.
     */
    loading?: boolean;
    /**
     * R17-PR7 — optional click handler. Forwarded to MetricCard;
     * makes the whole tile a keyboard-accessible button.
     */
    onClick?: () => void;
    /**
     * R17-PR7 — visually-selected state. Drives the brand-default
     * ring + amped glow when this tile is the dashboard's focused
     * KPI.
     */
    selected?: boolean;
}

// ─── Format mapping ─────────────────────────────────────────────────
//
// Maps the KpiCard's coarse format vocabulary onto the underlying
// AnimatedNumber preset. Compact uses Intl's `notation: 'compact'`
// (which bakes "K" / "M" into the formatter output) so the animated
// digits and the unit suffix transition together rather than the
// suffix re-mounting on each tier change.
function kpiFormatToAnimated(format: KpiFormat): AnimatedNumberFormat {
    switch (format) {
        case 'percent':
            return { kind: 'percent', fractionDigits: 1 };
        case 'compact':
            return {
                kind: 'intl',
                options: {
                    notation: 'compact',
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                },
            };
        case 'number':
        default:
            return { kind: 'integer' };
    }
}

// ─── Trend resolver ─────────────────────────────────────────────────
//
// Token-backed colour bag per semantic. Tailwind's `text-*` classes
// pull from CSS variables (Epic 51 token system); the shared theme
// flips light/dark in lockstep.

const SEMANTIC_TEXT_TOKEN = {
    good: 'text-content-success',
    bad: 'text-content-error',
    neutral: 'text-content-subtle',
} as const;

interface TrendIndicator {
    direction: 'up' | 'down' | 'flat';
    semantic: 'good' | 'bad' | 'neutral';
    icon: string;
    /**
     * Pre-rendered text — kept for backward compatibility with any
     * caller / test that asserts on the indicator's full string. The
     * decomposed (sign + magnitude + unit) fields below are what the
     * card renders so the magnitude can animate smoothly through
     * AnimatedNumber.
     */
    text: string;
    /** '+' (positive), '−' (Unicode minus, negative), '' (flat). */
    sign: '+' | '−' | '';
    /** Magnitude — always non-negative. Fed to AnimatedNumber. */
    magnitude: number;
    /**
     * Unit string appended after the animated magnitude. '%' for
     * percent-deltas, 'pp' for absolute percent-point deltas, '' when
     * the format itself bakes its unit in (Intl compact).
     */
    unit: string;
    /** Format spec for the AnimatedNumber that renders `magnitude`. */
    animatedFormat: AnimatedNumberFormat;
}

// ─── Magnitude format mapping ───────────────────────────────────────
//
// The trend indicator splits the formatter's output into
// (sign, magnitude, unit) so the magnitude can be animated in
// isolation. The format spec returned here mirrors the existing
// `formatTrendAbsolute` / `formatTrendPercent` digit conventions.

function magnitudeFormatForPercent(): AnimatedNumberFormat {
    return { kind: 'decimal', fractionDigits: 1 };
}

function magnitudeFormatForAbsolute(format: KpiFormat): AnimatedNumberFormat {
    switch (format) {
        case 'percent':
            // Percentage-point delta — the unit ("pp") is appended
            // separately. Just animate the digits.
            return { kind: 'decimal', fractionDigits: 1 };
        case 'compact':
            // Intl compact bakes "K" / "M" into the formatter output,
            // so the unit string stays empty and the suffix tier
            // transitions visually with the digits.
            return {
                kind: 'intl',
                options: {
                    notation: 'compact',
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                },
            };
        case 'number':
        default:
            // Plain count — toLocaleString() defaults; AnimatedNumber's
            // 'intl' preset with no constraints matches that.
            return { kind: 'intl', options: {} };
    }
}

function signFromDelta(delta: number): '+' | '−' | '' {
    if (delta > 0) return '+';
    if (delta < 0) return '−';
    return '';
}

function resolveTrendIndicator(input: {
    value: number | null;
    delta: number | null;
    previousValue: number | null;
    format: KpiFormat;
    polarity: TrendPolarity;
}): TrendIndicator | null {
    // Path 1 — explicit delta. Caller has done the math; we only
    // colour + format. Polarity still applies.
    if (input.delta !== null) {
        const direction: 'up' | 'down' | 'flat' =
            input.delta > 0 ? 'up' : input.delta < 0 ? 'down' : 'flat';
        const semantic: 'good' | 'bad' | 'neutral' =
            direction === 'flat' || input.polarity === 'neutral'
                ? 'neutral'
                : (input.polarity === 'up-good' && direction === 'up') ||
                    (input.polarity === 'down-good' && direction === 'down')
                  ? 'good'
                  : 'bad';
        const magnitude = Math.abs(input.delta);
        const unit = input.format === 'percent' ? 'pp' : '';
        return {
            direction,
            semantic,
            icon: trendDirectionIcon(direction),
            text: formatTrendAbsolute(input.delta, input.format),
            sign: signFromDelta(input.delta),
            magnitude,
            unit,
            animatedFormat: magnitudeFormatForAbsolute(input.format),
        };
    }

    // Path 2 — auto-compute. All edge cases live in the helper.
    if (input.previousValue === null) return null;
    const trend = computeKpiTrend({
        current: input.value,
        previous: input.previousValue,
        polarity: input.polarity,
    });
    if (trend.kind === 'unavailable') return null;
    if (trend.kind === 'flat') {
        return {
            direction: 'flat',
            semantic: 'neutral',
            icon: trendDirectionIcon('flat'),
            text: formatTrendPercent(0),
            sign: '',
            magnitude: 0,
            unit: '%',
            animatedFormat: magnitudeFormatForPercent(),
        };
    }
    return {
        direction: trend.direction,
        semantic: trend.semantic,
        icon: trendDirectionIcon(trend.direction),
        text: formatTrendPercent(trend.deltaPercent),
        sign: signFromDelta(trend.deltaPercent),
        magnitude: Math.abs(trend.deltaPercent),
        unit: '%',
        animatedFormat: magnitudeFormatForPercent(),
    };
}

// ─── Component ──────────────────────────────────────────────────────

export default function KpiCard({
    label,
    value,
    format = 'number',
    icon: Icon,
    gradient = 'from-[var(--brand-default)] to-[var(--brand-muted)]',
    subtitle,
    delta,
    deltaLabel,
    previousValue,
    trendPolarity = 'up-good',
    className = '',
    id,
    trend,
    trendVariant = 'brand',
    trendAriaLabel,
    loading = false,
    onClick,
    selected = false,
}: KpiCardProps) {
    const isEmpty = value === null || value === undefined;
    const animatedFormat = kpiFormatToAnimated(format);
    // While loading, suppress the trend indicator — showing a stale
    // delta against an unknown current value would be misleading.
    const indicator = loading
        ? null
        : resolveTrendIndicator({
              value: value ?? null,
              delta: delta ?? null,
              previousValue: previousValue ?? null,
              format,
              polarity: trendPolarity,
          });

    // v2-PR-8 — KpiCard now composes via the <MetricCard> chassis.
    // The chassis owns layout + frame + spacing rhythm; KpiCard owns
    // the smart logic (animated number, shimmer, gradient text,
    // trend resolution, sparkline rendering).
    const valueSlot = loading ? (
        <span className="inline-flex h-8 items-center" data-kpi-loading>
            <ShimmerDots
                rows={2}
                cols={20}
                className="h-6"
                aria-label={`${label} loading`}
            />
        </span>
    ) : isEmpty ? (
        <span className="text-content-subtle">{'—'}</span>
    ) : (
        <span
            className={`bg-gradient-to-r ${gradient} bg-clip-text text-transparent`}
        >
            <AnimatedNumber value={value} format={animatedFormat} />
        </span>
    );

    // The legacy `data-kpi-trend-row` marker is preserved for E2E +
    // rendered-test selectors that target the row. The chassis owns
    // the indicator slot positioning; this span carries the marker
    // INSIDE the chassis's `data-metric-card-indicator` wrapper.
    const indicatorSlot = indicator ? (
        <span data-kpi-trend-row className="contents">
            <span
                className={`text-xs font-medium ${SEMANTIC_TEXT_TOKEN[indicator.semantic]}`}
                data-kpi-trend-direction={indicator.direction}
                data-kpi-trend-semantic={indicator.semantic}
            >
                {indicator.icon}
                {' '}
                {indicator.sign}
                <AnimatedNumber
                    value={indicator.magnitude}
                    format={indicator.animatedFormat}
                />
                {indicator.unit}
            </span>
            {deltaLabel && (
                <span className="text-xs text-content-subtle">{deltaLabel}</span>
            )}
        </span>
    ) : undefined;

    const trailingSlot = trend && trend.length > 0 ? (
        <div className="h-8 w-full" data-kpi-trend>
            <MiniAreaChart
                data={trend}
                variant={trendVariant}
                aria-label={trendAriaLabel ?? `${label} 30-day trend`}
            />
        </div>
    ) : undefined;

    return (
        <MetricCard
            id={id}
            icon={Icon}
            eyebrow={label}
            indicator={indicatorSlot}
            subtitle={subtitle}
            trailing={trailingSlot}
            className={className}
            onClick={onClick}
            selected={selected}
        >
            {valueSlot}
        </MetricCard>
    );
}
