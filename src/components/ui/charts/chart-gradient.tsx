/**
 * Roadmap-16 PR-2 — `<ChartGradient>` primitive family.
 *
 * SVG gradient `<defs>` wired to the R16-PR1 token foundation
 * (`--chart-series-{1..6}-start/-end`). Every R16 chart consumer
 * (donut, line, radar, gantt) renders fills via `fill="url(#<id>)"`
 * pointing at one of these defs.
 *
 * Three primitives:
 *
 *   <ChartLinearGradient>  — straight directional gradient.
 *     Used by bars, area-under-line, gantt rows.
 *
 *   <ChartRadialGradient>  — radial gradient centred at top of the
 *     shape. Used by donut segments (the start-stop reads brighter
 *     at the inner edge, deeper at the outer edge).
 *
 *   <ChartFlowGradient>    — 3-stop gradient (`start → end → start`)
 *     at `gradientUnits="userSpaceOnUse"` with a `gradientTransform`
 *     translate that R16-PR4 `useChartFlow` animates. The cyclic
 *     stop pattern lets the colour pan continuously across the
 *     segment on hover without a seam at every cycle.
 *
 * Why a separate file:
 *
 *   - Donut / line / radar / gantt all need the same gradient
 *     shapes. Centralising them ensures every chart paints with
 *     the same visual contract.
 *
 *   - The `id` strategy (consumer-provided) keeps SVG defs free of
 *     accidental ID collisions when multiple charts mount on the
 *     same page (dashboard mounts ~6 charts side-by-side).
 *
 *   - The 3-stop flow shape is the LOAD-BEARING piece for R16-PR4's
 *     gradient-flow hover effect. Locking it here means PR-4 only
 *     has to ship the animation hook, not re-derive the gradient
 *     shape.
 *
 * Consumer contract:
 *
 *   1. Mount inside an `<svg>`'s `<defs>` block.
 *   2. Provide a unique `id` (typically `${chartId}-series-${N}`).
 *   3. Reference the gradient in a shape's `fill` / `stroke` via
 *      `fill={`url(#${id})`}`.
 *   4. For hover-flow, use `<ChartFlowGradient>` and animate the
 *      `gradientTransform` translate via R16-PR4's hook.
 */
import { forwardRef, type ReactElement } from 'react';

/**
 * R16-PR1 series palette. Locked at 6 — adding a 7th requires a
 * conscious vocabulary change (and a ratchet update at
 * `tests/guards/r16-chart-tokens.test.ts`).
 */
export type ChartSeriesIndex = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Direction of a linear gradient.
 *
 *   horizontal — left → right. Bars stacked horizontally,
 *                gantt rows, x-axis-aligned trends.
 *   vertical   — top → bottom. Area-under-line fading to
 *                transparent at the x-axis, vertical bars.
 *   diagonal   — top-left → bottom-right. The "polished" feel
 *                used for tiles + tile-like cards.
 */
export type ChartGradientDirection = 'horizontal' | 'vertical' | 'diagonal';

function directionToVector(direction: ChartGradientDirection): {
    x1: string;
    y1: string;
    x2: string;
    y2: string;
} {
    switch (direction) {
        case 'horizontal':
            return { x1: '0%', y1: '0%', x2: '100%', y2: '0%' };
        case 'vertical':
            return { x1: '0%', y1: '0%', x2: '0%', y2: '100%' };
        case 'diagonal':
            return { x1: '0%', y1: '0%', x2: '100%', y2: '100%' };
    }
}

/**
 * Resolve a series index to its start / end CSS-variable
 * references. Both stops are HEX literals (R16-PR1 contract) so
 * SVG `stop-color="var(--chart-series-N-start)"` resolves without
 * a JS colour resolver.
 */
function seriesStops(series: ChartSeriesIndex): {
    start: string;
    end: string;
} {
    return {
        start: `var(--chart-series-${series}-start)`,
        end: `var(--chart-series-${series}-end)`,
    };
}

interface ChartLinearGradientProps {
    /** Unique SVG `<defs>` id. Consumers reference via `fill="url(#id)"`. */
    id: string;
    /** 1-based series index (1..6). */
    series: ChartSeriesIndex;
    /** Gradient direction. Defaults to `vertical`. */
    direction?: ChartGradientDirection;
    /**
     * Optional alpha applied to BOTH stops via `stop-opacity`.
     * Used for area-under-line fills that need to fade to
     * transparent — combine with a 0% end-stop opacity in a
     * future PR if more practice is needed.
     */
    opacity?: number;
}

/**
 * Two-stop linear gradient. The shape the user's "gradient where
 * two colours meet" effect rides on for stacked / adjacent series
 * — when series N's end-stop sits in a neighbourhood of series
 * (N+1)'s start-stop (per R16-PR1 adjacent-tonal pairing), the
 * boundary reads as a continuous tonal surface.
 */
export function ChartLinearGradient({
    id,
    series,
    direction = 'vertical',
    opacity,
}: ChartLinearGradientProps): ReactElement {
    const { x1, y1, x2, y2 } = directionToVector(direction);
    const { start, end } = seriesStops(series);
    return (
        <linearGradient id={id} x1={x1} y1={y1} x2={x2} y2={y2}>
            <stop
                offset="0%"
                stopColor={start}
                stopOpacity={opacity ?? 1}
            />
            <stop offset="100%" stopColor={end} stopOpacity={opacity ?? 1} />
        </linearGradient>
    );
}

interface ChartRadialGradientProps {
    /** Unique SVG `<defs>` id. */
    id: string;
    /** 1-based series index (1..6). */
    series: ChartSeriesIndex;
    /**
     * Radial centre (defaults to 50%, 50%). Donut segments
     * shift this toward the inner edge so the brighter start-
     * stop concentrates near the donut's inner ring.
     */
    cx?: string;
    cy?: string;
    /** Radial radius (defaults to 50%). */
    r?: string;
}

/**
 * Radial gradient. Used by donut segments — the brighter `start`
 * stop concentrates near the segment's geometric centre and
 * deepens to `end` at the outer edge. Creates the "lit-from-
 * within" feel that flat fills can't.
 */
export function ChartRadialGradient({
    id,
    series,
    cx = '50%',
    cy = '50%',
    r = '50%',
}: ChartRadialGradientProps): ReactElement {
    const { start, end } = seriesStops(series);
    return (
        <radialGradient id={id} cx={cx} cy={cy} r={r}>
            <stop offset="0%" stopColor={start} />
            <stop offset="100%" stopColor={end} />
        </radialGradient>
    );
}

interface ChartFlowGradientProps {
    /** Unique SVG `<defs>` id. */
    id: string;
    /** 1-based series index (1..6). */
    series: ChartSeriesIndex;
    /** Direction of the flow axis. Defaults to `horizontal`. */
    direction?: ChartGradientDirection;
}

/**
 * 3-stop gradient (`start → end → start`) sized at 200% along the
 * flow direction. The cyclic stop pattern is what makes
 * `useChartFlow` (R16-PR4) able to PAN the gradient via
 * `gradientTransform` without a seam at every cycle — the start
 * and end of the pattern are the same colour, so the loop closes
 * cleanly.
 *
 * Wrapped in `forwardRef` so consumers can attach a ref produced
 * by `useChartFlow(...)` — the hook imperatively writes to the
 * `gradientTransform` attribute on every animation frame.
 *
 * The 200% size is locked here so PR-4's pan-by-translate maths
 * has a predictable distance. A future "smoother flow" PR might
 * extend to 300% with 5 stops; that would need its own ratchet.
 */
export const ChartFlowGradient = forwardRef<
    SVGLinearGradientElement,
    ChartFlowGradientProps
>(function ChartFlowGradient(
    { id, series, direction = 'horizontal' },
    ref,
): ReactElement {
    const { x1, y1, x2, y2 } = directionToVector(direction);
    const { start, end } = seriesStops(series);
    // `gradientUnits="userSpaceOnUse"` makes the gradient resolve in
    // the SVG's coordinate space rather than the shape's bounding
    // box. PR-4's transform-pan needs userSpaceOnUse so the pan
    // distance is a single fixed value across every consumer.
    // `gradientTransform="translate(0,0)"` is the IDENTITY transform
    // PR-4 animates away from.
    return (
        <linearGradient
            ref={ref}
            id={id}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            gradientUnits="userSpaceOnUse"
            gradientTransform="translate(0,0)"
            data-chart-flow="true"
        >
            <stop offset="0%" stopColor={start} />
            <stop offset="50%" stopColor={end} />
            <stop offset="100%" stopColor={start} />
        </linearGradient>
    );
});

/**
 * Build the canonical SVG def id for a chart's series gradient.
 * Use inside consumers so the id strategy stays consistent:
 *
 *     const gradId = chartGradientId('risk-overview', 2);
 *     <defs><ChartLinearGradient id={gradId} series={2} /></defs>
 *     <rect fill={`url(#${gradId})`} ... />
 */
export function chartGradientId(
    chartId: string,
    series: ChartSeriesIndex,
    variant: 'linear' | 'radial' | 'flow' = 'linear',
): string {
    return `${chartId}-${variant}-series-${series}`;
}
