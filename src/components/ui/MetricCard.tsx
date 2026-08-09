"use client";

/**
 * `<MetricCard>` — chassis primitive for "single-number" cards (v2-PR-8).
 *
 * Owns the LAYOUT contract for any card that displays a metric:
 *
 *   ┌────────────────────────────────────────┐
 *   │ {icon} EYEBROW LABEL          {action} │
 *   │                                        │
 *   │ {value}              ← large headline  │
 *   │                                        │
 *   │ ↑ +12% vs last month  ← {indicator}    │
 *   │ {subtitle}                             │
 *   │                                        │
 *   │ {trailing — sparkline / progress bar}  │
 *   └────────────────────────────────────────┘
 *
 * Specialised metric cards (KPI, Progress, Trend, Hero) compose via
 * this chassis instead of hand-rolling the spacing / typography /
 * card frame. The chassis is intentionally LAYOUT-ONLY — formatting
 * the number, animating it, resolving trend direction, choosing the
 * sparkline variant — those stay in the specialised wrapper. The
 * chassis just imposes:
 *
 *   - Consistent card frame (glass-card, padding, rounded radius).
 *   - Eyebrow typography (uppercase, tracking-wide, 11px muted).
 *   - Value typography (large, tabular-nums by default).
 *   - Spacing rhythm (eyebrow → value → indicator → subtitle →
 *     trailing) using semantic spacing tokens.
 *
 * Future polish:
 *   - v2-PR-9 (Card elevation system) replaces the inline
 *     `glass-card` class with `<Card elevation="raised">`.
 *   - v2-PR-10 (Hero metric) ships a new `<HeroMetric>` that wraps
 *     this chassis with the 72px tabular-nums treatment.
 */

import * as React from "react";
import { cn } from "@/lib/cn";
import { cardVariants } from "./card";

export interface MetricCardProps {
    /**
     * Optional inline icon rendered to the LEFT of the eyebrow label.
     * Pass any lucide-react icon component (or any React.ElementType
     * with a `className` prop).
     */
    icon?: React.ElementType;
    /**
     * Eyebrow label (uppercase, tracking-wide, muted). Conventionally
     * the resource name or KPI label ("Practice Coverage", "Open Risks").
     */
    eyebrow: React.ReactNode;
    /**
     * Optional right-edge slot in the header row — typically a
     * `<Tooltip>`-wrapped info icon or a small action chip.
     */
    headerAction?: React.ReactNode;
    /**
     * The value itself — the specialised wrapper renders the
     * <AnimatedNumber>/<ShimmerDots>/empty-state shape inside this
     * slot. The chassis only carries the typography size + tabular-
     * nums alignment.
     */
    children?: React.ReactNode;
    /**
     * Indicator row below the value — typically the trend chip
     * (delta + direction + label). The wrapper composes the chip;
     * the chassis just renders the slot in the correct spacing.
     */
    indicator?: React.ReactNode;
    /**
     * Subtitle line below the indicator. One sentence, ≤ 80 chars.
     */
    subtitle?: React.ReactNode;
    /**
     * Bottom slot — typically a sparkline, a progress bar, or a
     * 2-row mini-chart. Renders with `mt-default` from the
     * subtitle / indicator above.
     */
    trailing?: React.ReactNode;
    /** Optional className forwarded to the outer card frame. */
    className?: string;
    /** Forwarded to the outer card frame for E2E selectors. */
    id?: string;
    /**
     * R17-PR7 — optional click handler. When provided, the card
     * becomes a keyboard-accessible button (role="button",
     * tabIndex=0, Enter/Space activates) and the hover surface
     * gains a brand-tinted emphasis. Used by the dashboard to
     * wire KPI tiles into the chart-filter context.
     */
    onClick?: () => void;
    /**
     * R17-PR7 — visually-selected state. When true, the card
     * carries a brand-default ring + brighter glow. Drives the
     * "this is the focused KPI" affordance when the chart-filter
     * context's selectedKpi matches this card.
     */
    selected?: boolean;
    /**
     * Accessible name forwarded as `aria-label` when `onClick` is
     * provided. Defaults to the eyebrow string when it's a string;
     * callers MUST pass this when the eyebrow is non-text content
     * (icon, badge, etc.) so screen readers can announce the
     * clickable surface.
     */
    'aria-label'?: string;
}

export function MetricCard({
    icon: Icon,
    eyebrow,
    headerAction,
    children,
    indicator,
    subtitle,
    trailing,
    className,
    id,
    onClick,
    selected = false,
    'aria-label': ariaLabel,
}: MetricCardProps) {
    const clickable = typeof onClick === 'function';
    const handleKeyDown = clickable
        ? (e: React.KeyboardEvent<HTMLDivElement>) => {
              if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onClick?.();
              }
          }
        : undefined;
    const resolvedAriaLabel =
        ariaLabel ?? (typeof eyebrow === 'string' ? eyebrow : undefined);

    return (
        <div
            id={id}
            data-metric-card
            data-metric-card-corner-glow
            data-metric-card-selected={selected ? 'true' : undefined}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            aria-pressed={clickable ? selected : undefined}
            aria-label={clickable ? resolvedAriaLabel : undefined}
            onClick={onClick}
            onKeyDown={handleKeyDown}
            className={cn(
                cardVariants({ density: 'compact' }),
                "relative isolate overflow-hidden",
                // `select-none` — the metric value/label aren't copyable
                // content; stops them being text-highlighted on click.
                "select-none",
                clickable
                    ? "cursor-pointer hover:border-border-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-default focus-visible:ring-offset-2 focus-visible:ring-offset-bg-page transition-colors duration-150 ease-out"
                    : "hover:border-border-emphasis transition-colors duration-150 ease-out",
                // R17-PR7 — selected state recipe. Brand-default ring
                // + brand-emphasis border + brightened glow. Anchored
                // to the card's existing corner-glow gradient (PR-4)
                // so the warmth amps up rather than competing with a
                // new visual signal.
                selected &&
                    "ring-2 ring-brand-default border-border-emphasis before:bg-[radial-gradient(circle_240px_at_10%_0%,var(--brand-muted)_0%,transparent_60%)]",
                // R17-PR4 — corner brand glow. Tiny radial wash
                // anchored at the upper-left where the icon + eyebrow
                // sit. Smaller and quieter than the HeroMetric
                // 640×400 ambient glow — these cards live in a stack
                // of 3–6 siblings, so the warmth has to be present
                // without competing for attention. 200px radius +
                // brand-subtle alpha + 55% fade = "highlight on a
                // glass surface", not "glow under a verdict".
                //
                // No breath animation here. Three+ cards breathing
                // in lockstep would be hypnotic; staggering creates
                // visual noise. The hero's masthead is the ONE
                // breathing surface; the cards stay static.
                //
                // kpi-glow-dim-08 (2026-05-15) — pseudo opacity
                // multiplier set to 0.8. The R17-PR4 design used
                // the gradient's natural source alpha (`--brand-
                // subtle` = 18% METRO / 9% PwC) at full pseudo
                // opacity. After the hero-glow tightening sweep
                // (#529/#530/#531) the KPI cards started reading
                // as the brightest surface on the dashboard; 0.8
                // takes ~20% off without touching the selected/
                // unselected RATIO (both states multiply by 0.8,
                // so the selected glow stays exactly 2.22× the
                // default glow). Reversible by deleting one class.
                "before:content-[''] before:absolute before:inset-0 before:-z-10 before:pointer-events-none before:opacity-[0.8]",
                "before:bg-[radial-gradient(circle_200px_at_10%_0%,var(--brand-subtle)_0%,transparent_55%)]",
                className,
            )}
        >
            {/* Header row: icon + eyebrow + (optional) action */}
            <div className="flex items-center gap-tight mb-2">
                {Icon && (
                    <Icon
                        className="w-4 h-4 text-content-muted shrink-0"
                        aria-hidden="true"
                    />
                )}
                <span
                    className="text-xs text-content-muted uppercase tracking-wide font-medium"
                    data-metric-card-eyebrow
                >
                    {eyebrow}
                </span>
                {headerAction && (
                    <span
                        className="ml-auto"
                        data-metric-card-header-action
                    >
                        {headerAction}
                    </span>
                )}
            </div>

            {/* Value slot — the wrapper passes its <AnimatedNumber> /
                <ShimmerDots> / empty placeholder shape. Tabular-nums
                so the digits don't dance during animation.
                Rendered as `<p>` so screen readers and integration
                tests can target the metric value as a single
                paragraph element. */}
            <p
                className="font-display text-2xl font-bold tabular-nums"
                data-metric-card-value
            >
                {children}
            </p>

            {/* Indicator row */}
            {indicator && (
                <div
                    className="flex items-center gap-1 mt-1"
                    data-metric-card-indicator
                >
                    {indicator}
                </div>
            )}

            {/* Subtitle */}
            {subtitle && (
                <p
                    className="text-xs text-content-subtle mt-1"
                    data-metric-card-subtitle
                >
                    {subtitle}
                </p>
            )}

            {/* Trailing slot (sparkline / progress / chart) */}
            {trailing && (
                <div className="mt-2" data-metric-card-trailing>
                    {trailing}
                </div>
            )}
        </div>
    );
}
