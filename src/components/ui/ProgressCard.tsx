/**
 * ProgressCard — Reusable progress/coverage visualization.
 *
 * Renders a glass-card with a labeled progress bar, percentage,
 * and optional breakdown segments.
 *
 * @example
 * ```tsx
 * <ProgressCard
 *     label="Practice Coverage"
 *     value={75.3}
 *     max={100}
 *     segments={[
 *         { label: 'Implemented', value: 15, color: 'bg-bg-success-emphasis' },
 *         { label: 'In Progress', value: 3, color: 'bg-bg-warning-emphasis' },
 *         { label: 'Not Started', value: 2, color: 'bg-slate-600' },
 *     ]}
 * />
 * ```
 */

import { AnimatedNumber } from '@/components/ui/animated-number';
import { Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card-variants';
import { TrendCard } from '@/components/ui/TrendCard';
import { cn } from '@/lib/cn';

// ─── Props ──────────────────────────────────────────────────────────

export interface ProgressSegment {
    label: string;
    value: number;
    color: string;
}

/**
 * PR-A — optional trend line chart rendered below the segment
 * legend. Same shape as `<TrendCard>`'s data prop. Drives the
 * "more informative + visually substantial" requirement on the
 * Practice Coverage card without forcing every consumer to grow.
 */
export interface ProgressCardTrend {
    label: string;
    /** Ordered oldest→newest series of dated values. */
    points: ReadonlyArray<{ date: Date; value: number }>;
    /** Tailwind `text-*` class for the area fill + stroke. */
    colorClassName: string;
    /** Display suffix on the latest value (e.g. "%"). */
    format?: string;
}

export interface ProgressCardProps {
    /** Card heading */
    label: string;
    /** Current value (0–max) */
    value: number;
    /** Maximum value (default: 100) */
    max?: number;
    /** Gradient for the main progress bar */
    gradient?: string;
    /** Optional breakdown segments (stacked bar) */
    segments?: ProgressSegment[];
    /** Optional trend mini-chart slot (PR-A). */
    trend?: ProgressCardTrend;
    /** Footer text / link */
    footer?: React.ReactNode;
    /** Optional CSS class */
    className?: string;
    /** Optional test-id */
    id?: string;
}

// ─── Component ──────────────────────────────────────────────────────

export default function ProgressCard({
    label,
    value,
    max = 100,
    gradient = 'from-[var(--brand-default)] to-emerald-500',
    segments,
    trend,
    footer,
    className = '',
    id,
}: ProgressCardProps) {
    const percent = max > 0 ? Math.min((value / max) * 100, 100) : 0;

    return (
        // B3 — card sizing parity. `h-full` + `flex flex-col`
        // so the card stretches to the row's tallest sibling
        // (typically the RiskDistribution card). Pre-B3 the
        // ProgressCard sat at its content height and read as
        // "short" next to RiskDistribution.
        <div id={id} className={cn(cardVariants(), 'h-full flex flex-col', className)}>
            <Heading level={3} className="mb-3">{label}</Heading>

            {/* Main progress bar.

                R18 visible-uplift — the track is now `relative`
                and carries a `::after` gloss sheen (a top-down
                white→transparent CSS ramp) so the filled bar
                reads as a glossy surface, not a flat painted
                strip. The Practice Coverage ProgressCard is one of
                the dashboard's most-looked-at charts and R18
                missed it entirely (it polished the SVG chart
                primitives, not this HTML-div bar). The `::after`
                is `inset-0` + `rounded-full` (tracks the track
                shape) + `pointer-events-none`, and sits ABOVE the
                fill divs but is purely decorative. */}
            <div className="flex items-center gap-compact">
                <div className="relative flex-1 bg-bg-subtle rounded-full h-3 overflow-hidden after:content-[''] after:absolute after:inset-0 after:rounded-full after:pointer-events-none after:bg-[linear-gradient(180deg,rgba(255,255,255,0.28)_0%,rgba(255,255,255,0.04)_45%,transparent_100%)]">
                    {segments && segments.length > 0 ? (
                        // Stacked segments
                        <div className="flex h-full">
                            {segments.map((seg) => {
                                const segPercent = max > 0 ? (seg.value / max) * 100 : 0;
                                return (
                                    <div
                                        key={seg.label}
                                        className={`h-full ${seg.color} transition-all duration-500`}
                                        style={{ width: `${segPercent}%` }}
                                        title={`${seg.label}: ${seg.value}`}
                                    />
                                );
                            })}
                        </div>
                    ) : (
                        // Single gradient bar
                        <div
                            className={`h-full bg-gradient-to-r ${gradient} rounded-full transition-all duration-500`}
                            style={{ width: `${percent}%` }}
                        />
                    )}
                </div>
                <span className="text-sm font-medium text-content-default tabular-nums min-w-[3.5rem] text-right">
                    <AnimatedNumber
                        value={percent}
                        format={{ kind: 'percent', fractionDigits: 1 }}
                    />
                </span>
            </div>

            {/* Segment legend */}
            {segments && segments.length > 0 && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
                    {segments.map((seg) => (
                        <div key={seg.label} className="flex items-center gap-1.5 text-xs text-content-muted">
                            <span className={`w-2 h-2 rounded-full ${seg.color}`} />
                            <span>{seg.label}</span>
                            <span className="text-content-subtle tabular-nums">({seg.value})</span>
                        </div>
                    ))}
                </div>
            )}

            {/* PR-A — Trend mini-chart. Sits between the segment
                legend and the footer so the card grows downward
                without disrupting the existing layout for callers
                that don't pass `trend`. */}
            {trend && trend.points.length > 0 && (
                <div
                    className="mt-default rounded-md bg-bg-muted/30 px-default py-tight"
                    data-testid="progress-card-trend"
                >
                    <TrendCard
                        label={trend.label}
                        value={trend.points[trend.points.length - 1].value}
                        format={trend.format}
                        points={trend.points}
                        colorClassName={trend.colorClassName}
                    />
                </div>
            )}

            {/* Footer */}
            {footer && (
                <div className="mt-3 text-xs text-content-muted">{footer}</div>
            )}
        </div>
    );
}
