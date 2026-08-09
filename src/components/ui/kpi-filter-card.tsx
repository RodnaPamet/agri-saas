/**
 * R23-PR-A — KpiFilterCard primitive.
 *
 * Extracts the Risks-page KPI card pattern into a reusable shared
 * component. Six other list pages (Assets, Practices, Tasks, Evidence,
 * Policies, Vendors) need the same look + interaction, so the
 * primitive lives here and the Risks page becomes its first consumer.
 *
 * Visual contract — matches the Risks-page Card + KPIStat exactly:
 *   • `<Card>` chassis (glass-card recipe, raised elevation, default
 *     density).
 *   • `<KPIStat>` typography (md size: 11px uppercase label, 30px
 *     tabular-nums value, optional description, optional trend).
 *   • Tone bag: default / success / attention / critical (inherits
 *     KPIStat's TONE_VALUE_CLASS).
 *
 * Interaction contract — three states:
 *   1. Static (no `onClick`)              — read-only KPI, used for
 *                                           metrics that don't map to
 *                                           a single filter (avg
 *                                           score, total count).
 *   2. Clickable (`onClick`, not selected) — `cursor-pointer` +
 *                                           hover ring. Click sets
 *                                           the page's KPI filter.
 *   3. Selected (`onClick` + selected)    — brand-emphasis ring +
 *                                           filled accent. Visual
 *                                           lock that "this filter is
 *                                           the active KPI right
 *                                           now". Click again to
 *                                           deactivate (caller wires
 *                                           the toggle).
 *
 * The `selected` state is the R23 ADDITION on top of the existing
 * Risks-page pattern. The R22-era Risks page had clickable cards but
 * NO active-state affordance — clicking the OPEN card set the filter
 * but the card itself didn't visibly mark itself as the active one.
 * R23 closes that loop so the user can tell at a glance which KPI is
 * driving the table.
 *
 * Accessibility
 *   • Clickable cards render as `<button>` (via `as="button"`-like
 *     props on the underlying Card) so keyboard activation works for
 *     free — Enter and Space both fire `onClick`.
 *   • Selected state mirrors to `aria-pressed="true"` so screen
 *     readers announce the toggle state.
 *
 * Composition
 *   • Pairs with the shared `useKpiFilter` hook (R23-PR-B).
 *   • Renders inside a `<KpiCardRow>` grid (R23-PR-D+).
 */

"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

import { Card } from "@/components/ui/card";
import { KPIStat, type KPIStatProps, type MetricTone, type MetricTrend } from "@/components/ui/metric";
import { MiniAreaChart, type MiniAreaChartVariant } from "@/components/ui/mini-area-chart";
import type { TimeSeriesPoint } from "@/components/ui/charts";
import { KPI_ACCENTS, kpiAccentValueClass, type KpiAccent } from "@/components/ui/kpi-accent";

export interface KpiFilterCardProps {
    /** Short label rendered as 11px uppercase eyebrow above the value. */
    label: React.ReactNode;
    /** Headline numeric value. */
    value: React.ReactNode;
    /** Optional secondary text below the value (e.g. "5 due this week"). */
    description?: React.ReactNode;
    /** Optional trend indicator next to the value. */
    trend?: MetricTrend;
    /**
     * Optional inline sparkline drawn under the value — the metric's
     * recent trajectory. Needs ≥2 points; fewer renders nothing.
     */
    sparkline?: TimeSeriesPoint[];
    /**
     * Colour variant for the sparkline. Defaults to the `accent`'s
     * sparkline (or `brand` when no accent is set).
     */
    sparklineVariant?: MiniAreaChartVariant;
    /**
     * Optional shared y-domain `[min, max]` for the sparkline. Pass the same
     * `[0, maxAcrossCards]` to every card in a row so their sparklines become
     * comparable on absolute scale instead of each auto-fitting its own range
     * (which makes differently-valued-but-similarly-shaped series look alike).
     */
    sparklineDomain?: [number, number];
    /**
     * KPI colour accent — gives the headline value a gradient (the
     * dashboard `<KpiCard>` look) and supplies the default sparkline
     * colour. The shared palette in `kpi-accent.ts` keeps every list
     * page's KPI cards on the same scheme. When set, the gradient owns
     * the value colour (`tone` is ignored).
     */
    accent?: KpiAccent;
    /** Tone bag for the value colour. Ignored when `accent` is set. */
    tone?: MetricTone;
    /**
     * When provided, makes the card clickable. Renders as a `<button>`
     * for keyboard accessibility; `cursor-pointer` + hover ring on
     * hover. Pair with `selected` to indicate the active filter state.
     */
    onClick?: () => void;
    /**
     * Visually indicates this card's filter is the active KPI. Pairs
     * with `onClick`. Without `onClick` the prop is a no-op (selected
     * read-only cards don't carry meaning).
     */
    selected?: boolean;
    /** Optional id forwarded to KPIStat's value span — preserves E2E selectors. */
    id?: string;
    /** Optional class on the outer Card. */
    className?: string;
    /** Optional test-id for the wrapper element. */
    "data-testid"?: string;
}

/**
 * Static card class — matches the Risks-page Card defaults. Outer
 * spacing and elevation come from Card's own defaults (density
 * "comfortable" = p-6, elevation "raised" = glass-card recipe).
 *
 * `select-none` keeps the headline number + label from being
 * text-highlighted when the card is clicked (these cards are filter
 * toggles, not copyable content).
 */
const STATIC_CARD_CLASSES = "select-none";

/**
 * Hover affordance for clickable cards — preserves the exact ring
 * recipe the Risks page uses today (`hover:ring-1 hover:ring-[color:var(--ring)]`
 * with a 150ms ease-out colour transition). The `cursor-pointer` is
 * the click cue; the ring is the hover-state lift.
 */
const CLICKABLE_CARD_CLASSES =
    "cursor-pointer select-none hover:ring-1 hover:ring-[color:var(--ring)] transition-colors duration-150 ease-out";

/**
 * Selected affordance — brand-emphasis ring + tinted glow. R23's
 * NEW visual that closes the loop on "which KPI is driving the
 * table right now?". Heavier than hover (ring-2 vs ring-1, brand-
 * emphasis vs --ring) so the active state stays visually distinct
 * from the cursor-hover state. Composes with CLICKABLE_CARD_CLASSES
 * — selected cards stay clickable (the toggle is "click active card
 * to deactivate").
 *
 * `ring-inset` is LOAD-BEARING. The Card chassis is `glass-card`
 * (raised default), which paints with `backdrop-filter: blur(...)`.
 * Backdrop-filter creates a stacking context clipped to the
 * element's border-radius box; an OUTSET `ring-2` (the prior
 * recipe) extends 2px beyond that box and Chrome's compositor
 * draws the bottom rounded corners inconsistently — the lower
 * curve of the ring fades visibly. The inset ring renders inside
 * the radius envelope, lives inside the same compositing layer as
 * the card's content, and traces every corner identically. Same
 * pattern as `CalendarMonth.tsx:214` (selected day cell) which
 * faced the identical issue.
 */
const SELECTED_CARD_CLASSES =
    "ring-2 ring-inset ring-[color:var(--brand-default)] bg-bg-elevated";

export function KpiFilterCard({
    label,
    value,
    description,
    trend,
    sparkline,
    sparklineVariant,
    sparklineDomain,
    accent,
    tone,
    onClick,
    selected = false,
    id,
    className,
    "data-testid": testId = "kpi-filter-card",
}: KpiFilterCardProps) {
    const isClickable = onClick !== undefined;

    // Accent drives the headline-value gradient + the default sparkline
    // colour (the dashboard <KpiCard> look). An explicit sparklineVariant
    // still wins; without an accent we fall back to `brand`.
    const accentDef = accent ? KPI_ACCENTS[accent] : null;
    const effectiveSparklineVariant =
        sparklineVariant ?? accentDef?.sparkline ?? "brand";
    const renderedValue = accentDef ? (
        <span className={kpiAccentValueClass(accent!)}>{value}</span>
    ) : (
        value
    );

    const kpiStatProps: KPIStatProps = {
        label,
        value: renderedValue,
        description,
        trend,
        // The gradient owns the value colour when an accent is set.
        tone: accentDef ? undefined : tone,
        size: "md",
        id,
    };

    const sparkLabel =
        typeof label === "string" ? `${label} trend` : "Trend";
    const body = (
        // B2 (2026-06-07): the sparkline sits to the RIGHT of the value, not
        // beneath it — so trendline cards keep the SAME (compact) height as
        // cards without a trendline, instead of growing a row taller.
        // `items-end` aligns the sparkline to the value's baseline.
        <div className="flex items-end justify-between gap-compact">
            <KPIStat {...kpiStatProps} />
            {sparkline && sparkline.length >= 2 && (
                // Fixed-size wrapper is LOAD-BEARING. MiniAreaChart's
                // <ParentSize> forces inline `height: 100%`, which would
                // override an `h-8` passed on the chart itself and resolve
                // against the auto-height card — ParentSize then grows to
                // fill, the card grows to fit, and they expand without
                // bound. Pinning the parent height (h-8) stops the loop.
                // B2-follow (#73 → #75, 2026-06-07): the trend spans the
                // right TWO-THIRDS of the card (w-2/3) — value on the left
                // third, sparkline filling the rest — instead of a narrow
                // chip jammed against the right.
                <div className="h-8 w-2/3 shrink-0">
                    <MiniAreaChart
                        data={sparkline}
                        variant={effectiveSparklineVariant}
                        yDomain={sparklineDomain}
                        aria-label={sparkLabel}
                        className="h-full w-full"
                    />
                </div>
            )}
        </div>
    );

    // Render a <button> when clickable so Enter/Space activate the
    // filter for free. Without onClick, render a plain <div> Card
    // (read-only KPI surface).
    if (isClickable) {
        return (
            <Card
                as="div"
                className={cn(
                    CLICKABLE_CARD_CLASSES,
                    selected && SELECTED_CARD_CLASSES,
                    className,
                )}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                data-testid={testId}
                data-selected={selected ? "true" : "false"}
                onClick={onClick}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onClick();
                    }
                }}
            >
                {body}
            </Card>
        );
    }

    return (
        <Card
            className={cn(STATIC_CARD_CLASSES, className)}
            data-testid={testId}
        >
            {body}
        </Card>
    );
}
