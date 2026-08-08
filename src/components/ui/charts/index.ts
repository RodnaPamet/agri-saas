/**
 * Epic 59 — chart platform barrel.
 *
 * The canonical entry point for every reusable chart primitive in
 * Inflect. Consumers should import from `@/components/ui/charts`
 * rather than reaching for individual files — the sub-modules are
 * implementation details that can be refactored without touching
 * call sites.
 *
 * Public API surface:
 *
 *   - **Primitives**   — `Areas`, `Bars`, `XAxis`, `YAxis`
 *   - **Charts**       — `TimeSeriesChart`, `FunnelChart`
 *   - **Coordination** — `ChartTooltipSync`, `ChartContext`,
 *                        `ChartTooltipContext`, `useChartContext`,
 *                        `useChartTooltipContext`
 *   - **Types**        — `Datum`, `TimeSeriesDatum`, `Series`,
 *                        `ChartProps`, plus the `ChartContext` /
 *                        `ChartTooltipContext` type aliases
 *
 * Private to the module (not re-exported):
 *
 *   - `./use-tooltip.ts` — internal hook composing `@visx/tooltip`'s
 *     portal + bounds behaviour.
 *   - `./utils.ts` — legacy alias for the `getFactors` helper; new
 *     code should import from `./layout` via the barrel instead.
 *
 * Tokens & theming:
 *   - Chart surfaces should declare colours via the existing design
 *     tokens (`bg-bg-*`, `text-content-*`, `border-border-*`,
 *     `bg-brand-*`). Never hardcode hex values in chart call sites.
 *   - The `Series.colorClassName` prop accepts any Tailwind utility
 *     — pass a token-backed class there rather than inline styles.
 *
 * Non-goals:
 *   - This module is *not* the home for KPI / progress / donut /
 *     risk-heatmap widgets (`src/components/ui/KpiCard.tsx`,
 *     `ProgressCard.tsx`, `DonutChart.tsx`, `RiskHeatmap.tsx`,
 *     `mini-area-chart.tsx`). Those are compact widgets with their
 *     own display contract; later Epic 59 prompts may migrate them
 *     onto these primitives where it helps, but the boundary is
 *     deliberate: pick this module when you need an interactive
 *     time-series / funnel; pick the top-level widget when you need
 *     a static, compact card.
 */

// ─── Primitives ────────────────────────────────────────────────────────

export * from './areas';
export * from './bars';
export * from './x-axis';
export * from './y-axis';

// ─── Full charts ──────────────────────────────────────────────────────

export * from './time-series-chart';
export * from './funnel-chart';

// ─── Coordination (context + sync across multiple charts) ─────────────

export * from './chart-context';
export * from './tooltip-sync';

// ─── Roadmap-16 — Lickable Chart gradient primitives ─────────────────
//
// SVG `<defs>` gradient primitives wired to the R16-PR1 token
// foundation. Every R16 chart consumer (donut, line, radar, gantt)
// paints fills via `fill="url(#<id>)"` referencing a gradient
// rendered through one of these primitives.

export {
    ChartLinearGradient,
    ChartRadialGradient,
    ChartFlowGradient,
    chartGradientId,
} from './chart-gradient';
export type {
    ChartSeriesIndex,
    ChartGradientDirection,
} from './chart-gradient';

// ─── Roadmap-18 — ChartGloss specular-highlight primitive ───────────
//
// The "light" layer that sits ON TOP of a ChartGradient colour
// layer. A white → transparent ramp consumers paint as an overlay
// shape (same `d`, stacked) to give chart surfaces a glass
// catch-light. See chart-gloss.tsx for the two-layer paint
// contract.

export { ChartGloss, chartGlossId } from './chart-gloss';
export type {
    ChartGlossDirection,
    ChartGlossIntensity,
} from './chart-gloss';

// ─── Roadmap-18 PR-10 — ChartSheenSweep periodic light pan ──────────
//
// The MOVING counterpart of ChartGloss: a narrow white band that
// pans across the surface on a slow loop. Pair `<ChartSheenSweep>`
// with the `useChartSheen` motion hook (see chart-motion exports).

export { ChartSheenSweep, chartSheenId } from './chart-gloss';
export type { ChartSheenDirection } from './chart-gloss';

// ─── Roadmap-16 — ChartFrame wrapper ────────────────────────────────
//
// Responsive container + state-driven branch rendering. Every R16
// chart consumer mounts inside `<ChartFrame>` so loading / empty /
// error states share the same vocabulary across charts.

export { ChartFrame } from './chart-frame';

// ─── Roadmap-16 — chart motion hooks ────────────────────────────────
//
// `useChartHoverPop` — hover-pop transforms for donut segments /
// bars / line focus points. Subtle by design (4px donut, 2px lift,
// 1.05× scale). Motion-reduce snaps to identity.
//
// `useChartFlow` — animate `gradientTransform` translate on a
// `<ChartFlowGradient>` ref so the gradient pans across the segment
// in a continuous loop. The "flowing river" effect.

export {
    useChartHoverPop,
    useChartFlow,
    CHART_HOVER_POP_DISTANCE,
    CHART_HOVER_LIFT,
    CHART_HOVER_POINT_SCALE,
    CHART_FLOW_PERIOD_MS,
    // R18-PR2 — bubbly-settle entrance spring
    useChartSpring,
    CHART_SPRING_DURATION_MS,
    CHART_SPRING_OVERSHOOT,
    // R18-PR10 — periodic sheen-sweep loop
    useChartSheen,
    CHART_SHEEN_PERIOD_MS,
} from './chart-motion';

// ─── Roadmap-16 — LineChart primitive ───────────────────────────────
//
// Smooth single-series line + area-under-line gradient + on-mount
// path draw. Phase 3 of R16.

export { LineChart } from './line-chart';

// ─── Roadmap-21 — Sculpted Charts foundation ────────────────────────
//
// PR-A: shared `useHeatScale` hook + `<ChartLegend>` primitive.
// `useHeatScale` maps a value to a CSS `color-mix(in oklab, ...)`
// interpolated between two chart-series tokens — theme-agnostic,
// continuous, perceptually uniform. `<ChartLegend>` carries two
// variants: discrete series-swatch list (for line/radar/sankey)
// and continuous gradient strip (for heatmaps). The heatmap legend
// shares its `gradientId` with the cell fills so the legend ramp
// and the cells are visually continuous.

export {
    useHeatScale,
    buildHeatColorMix,
    buildStepValues,
    clampIntensity,
} from './use-heat-scale';
export type { HeatScale, HeatScaleOptions } from './use-heat-scale';

export { ChartLegend, seriesDotBackground } from './chart-legend';
export type {
    ChartLegendProps,
    ChartLegendSeriesEntry,
    ChartLegendSeriesProps,
    ChartLegendGradientProps,
} from './chart-legend';

// ─── Roadmap-21 PR-E — 3D foundation ────────────────────────────────
//
// `<Chart3D>` wraps react-three-fiber's <Canvas> with SSR-safe
// dynamic import + prefers-reduced-motion fallback + constrained
// OrbitControls. `tokenColor()` resolves a chart-series CSS var to
// a hex string Three.js materials can consume. Three.js + drei +
// r3f only load on routes that mount a 3D chart (~180KB gzipped,
// dynamic-imported via `dynamicChart3D()`).

export { Chart3D, tokenColor } from './chart-3d';
export type { Chart3DProps } from './chart-3d';
export { dynamicChart3D } from './chart-3d-dynamic';

// PR-F — first 3D chart: BarField3D (cross-tab time × category bars).
export { BarField3D } from './bar-field-3d';
export type { BarField3DDatum, BarField3DProps } from './bar-field-3d';

// ─── Roadmap-16 — RadarChart primitive ──────────────────────────────
//
// Multi-axis radar chart with gradient polygon fill. Phase 4 of R16.

export { RadarChart } from './radar-chart';
export type { RadarAxisDatum } from './radar-chart';

// ─── Roadmap-16 — GanttChart primitive ──────────────────────────────
//
// Horizontal Gantt with gradient bars + dependency arrows. Phase 5.

export { GanttChart } from './gantt-chart';
export type { GanttRow } from './gantt-chart';

// ─── Shared scale / layout helpers (Epic 59) ─────────────────────────
//
// Pure helpers charts (and non-chart consumers that need to speak the
// same scale or margin vocabulary) compose. Exported as values + as a
// namespace so a downstream component can either pick individual
// helpers or reach for the whole module via an alias import.

export {
    AXIS_LABEL_FONT_SIZE,
    COMPACT_CHART_MARGIN,
    DEFAULT_AREA_Y_PADDING,
    DEFAULT_BAR_Y_PADDING,
    DEFAULT_CHART_MARGIN,
    DEFAULT_Y_AXIS_TICK_AXIS_SPACING,
    buildTimeSeriesXScale,
    buildYScale,
    computeYDomain,
    formatNumericTick,
    formatShortDate,
    getDateExtent,
    getFactors,
    pickXAxisTickCount,
    pickXAxisTickValues,
    pickYAxisTickCount,
    resolveChartMargin,
    resolveChartPadding,
} from './layout';

// ─── Shared interaction primitives (Epic 59) ─────────────────────────
//
// Hover + keyboard state hooks, and token-backed tooltip surface
// components that every chart consumer should reach for so the
// dashboard reads as one system rather than a patchwork of tooltip
// implementations.

export {
    ChartTooltipContainer,
    ChartTooltipRow,
    useChartHover,
    useChartKeyboardNavigation,
} from './interaction';
export type {
    ChartHoverState,
    ChartKeyboardNavigationOptions,
    ChartKeyboardNavigationReturn,
    ChartTooltipContainerProps,
    ChartTooltipRowProps,
} from './interaction';

// ─── Public types ─────────────────────────────────────────────────────
//
// Visx-tied primitives the TimeSeriesChart / Funnel primitives consume
// internally, plus the Epic 59 consumer contracts (point shapes,
// dimensions, tooltip payloads, progress metrics, KPI metrics, state).

export type {
    // Visx-tied internals
    AccessorFn,
    ChartContext as ChartContextType,
    ChartProps,
    ChartTooltipContext as ChartTooltipContextType,
    Data,
    Datum,
    Series,
    TimeSeriesDatum,
    // Consumer contracts
    CategoryPoint,
    ChartDimensions,
    ChartMargin,
    ChartPadding,
    ChartState,
    KpiMetric,
    LabeledSeries,
    ProgressMetric,
    ProgressSegment,
    SparklineData,
    TimeSeriesPoint,
    TooltipPayload,
} from './types';

// ─── Chart-state constructors + narrowing ────────────────────────────

export {
    chartEmpty,
    chartError,
    chartLoading,
    chartReady,
    isChartReady,
} from './types';
