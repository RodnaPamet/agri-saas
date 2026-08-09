/* eslint-disable @typescript-eslint/no-explicit-any --
 * The `any` defaults on the chart generics (`T extends Datum = any`,
 * `Record<string, any>`, `ReactElement<any>`) are load-bearing for
 * downstream specialization. Replacing them with `Datum` or `unknown`
 * defaults breaks 9 consumer files (chart-context, time-series-chart,
 * use-tooltip, examples) because the chart system's generic
 * relationships rely on `any`'s "accept-anything" semantics in unbound
 * defaults — `Datum` self-reference creates an over-narrowed default
 * that doesn't unify with concrete consumer types.
 *
 * The proper structural fix is a chart-system generics redesign — out
 * of scope for the lint-cleanup PR. Re-evaluate when the chart
 * primitive next gets a substantive update.
 */
import { ScaleTypeToD3Scale } from "@visx/scale";
import { TooltipWithBounds, UseTooltipParams, TooltipInPortalProps } from "@visx/tooltip";
import { Dispatch, FC, ReactElement, SetStateAction } from "react";

export type Datum = Record<string, any>;

export type TimeSeriesDatum<T extends Datum = any> = {
  date: Date;
  values: T;
};

export type AccessorFn<T extends Datum, TValue = number> = (
  datum: TimeSeriesDatum<T>,
) => TValue;

export type Series<T extends Datum = any, TValue = number> = {
  id: string;
  isActive?: boolean;
  valueAccessor: AccessorFn<T, TValue>;
  colorClassName?: string;
};

export type Data<T extends Datum> = TimeSeriesDatum<T>[];

type ChartRequiredProps<T extends Datum = any> = {
  data: Data<T>;
  series: Series<T>[];
};

type ChartOptionalProps<T extends Datum = any> = {
  type?: "area" | "bar";
  tooltipContent?: (datum: TimeSeriesDatum<T>) => ReactElement<any> | string;
  tooltipClassName?: string;
  defaultTooltipIndex?: number | null;
  /**
   * Called when the hovered x-value (date) changes, or when hover is cleared.
   * Useful for syncing external UI to the currently hovered datum.
   */
  onHoverDateChange?: (date: Date | null) => void;

  /**
   * Absolute pixel values for margins around the chart area.
   * Default values accommodate axis labels and other expected overflow.
   */
  margin?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };

  /**
   * Decimal percentages for padding above and below highest and lowest y-values
   */
  padding?: {
    top: number;
    bottom: number;
  };
};

export type ChartProps<T extends Datum = any> = ChartRequiredProps<T> &
  ChartOptionalProps<T>;

export type ChartContext<T extends Datum = any> = Required<
  Omit<ChartProps<T>, "onHoverDateChange">
> & {
  width: number;
  height: number;
  startDate: Date;
  endDate: Date;
  xScale:
    | ScaleTypeToD3Scale<number>["utc"]
    | ScaleTypeToD3Scale<number>["band"];
  yScale: ScaleTypeToD3Scale<number>["linear"];
  minY: number;
  maxY: number;
  leftAxisMargin?: number;
  setLeftAxisMargin: Dispatch<SetStateAction<number | undefined>>;
  /**
   * Optional callback invoked when the hovered x-value (date) changes.
   */
  onHoverDateChange?: (date: Date | null) => void;
};

export type ChartTooltipContext<T extends Datum = any> = {
  handleTooltip: (
    event: React.TouchEvent<SVGRectElement> | React.MouseEvent<SVGRectElement>,
  ) => void;
  TooltipWrapper: FC<TooltipInPortalProps> | typeof TooltipWithBounds;
  containerRef: (element: SVGElement | HTMLElement | null) => void;
} & UseTooltipParams<TimeSeriesDatum<T>>;

// ─── Epic 59 — shared chart contracts ─────────────────────────────────
//
// The types above are the visx-tied surface the `TimeSeriesChart`
// primitive consumes directly. The contracts below are the
// consumer-facing shapes every chart surface in Inflect should speak
// — sparklines, bar charts, progress widgets, KPI cards, and any
// future reporting component. They carry zero domain semantics
// (evidence / risk / practice / audit stay out of `charts/`) and no
// visx dependency, so non-chart consumers (tooltip content, export
// serialisers, API clients) can import them without pulling a d3
// transitive.

// ─── Primitive point shapes ──────────────────────────────────────────

/**
 * A single time-series measurement. The flat `{ date, value }` shape
 * the sparkline, mini-chart, and any other "one line, one metric"
 * surface consumes. For charts that need multiple metrics per
 * timestamp, see {@link TimeSeriesDatum} above.
 */
export interface TimeSeriesPoint<V = number> {
  date: Date;
  value: V;
}

/**
 * A single categorical measurement — `{ label, value }`. Used by
 * grouped bar charts, ranked-list views, and any chart where the
 * x-axis is discrete rather than temporal.
 */
export interface CategoryPoint<V = number> {
  label: string;
  value: V;
}

/**
 * Alias for the `{ date, value }[]` shape sparkline / mini-chart
 * components accept. Using the alias keeps the component prop types
 * consistent and self-documenting.
 */
export type SparklineData<V = number> = ReadonlyArray<TimeSeriesPoint<V>>;

// ─── Chart dimensions ────────────────────────────────────────────────

/**
 * Absolute pixel values for margins around the chart area.
 * Separated from the chart props so layout helpers and axis
 * components can trade in it directly.
 */
export interface ChartMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Decimal percentages for padding above and below the highest and
 * lowest y-values. Keeps plotted series from clipping the chart
 * edges at their extremes.
 */
export interface ChartPadding {
  top: number;
  bottom: number;
}

/**
 * Rendered chart dimensions. `width` + `height` are always present
 * (usually provided by `<ParentSize>`); `margin` and `padding` are
 * optional — consumers that don't supply them inherit the primitive's
 * defaults.
 */
export interface ChartDimensions {
  width: number;
  height: number;
  margin?: ChartMargin;
  padding?: ChartPadding;
}

// ─── Series (display-oriented) ───────────────────────────────────────

/**
 * A display-oriented variant of {@link Series}. Adds a required
 * `label` (used in legends, tooltips, and accessibility copy).
 * Extend this for chart surfaces that render their own legend.
 */
export interface LabeledSeries<T extends Datum = Datum, V = number>
  extends Series<T, V> {
  label: string;
}

// ─── Tooltip payload ─────────────────────────────────────────────────

/**
 * Structured payload every `tooltipContent` render function receives.
 * Generic over the datum shape so consumers get autocomplete on
 * `payload.datum.values.<field>` without a cast.
 *
 * Not tied to visx — a future tooltip surface (modal, docked panel,
 * URL-synced detail drawer) can consume the same payload shape.
 */
export interface TooltipPayload<T extends Datum = Datum> {
  /** The datum under the cursor. */
  datum: TimeSeriesDatum<T>;
  /** The date value under the cursor. `null` once the hover clears. */
  date: Date | null;
  /** Index of the datum within the chart's source data array. */
  index: number;
}

// ─── Progress metrics ────────────────────────────────────────────────

/**
 * A single progress measurement the `ProgressCard` / dashboard KPI
 * widgets render. `current` + `target` are the two values the bar
 * fills from; `unit` is the optional trailing display unit (e.g.
 * "%", "practices", "days"). When `target` is omitted, consumers
 * default to 100 — the common percent-coverage case.
 */
export interface ProgressMetric {
  /** Current measured value. */
  current: number;
  /** Target / maximum. Defaults to 100 in consumers (percent scale). */
  target?: number;
  /** Display unit suffix. */
  unit?: string;
  /** Optional label for accessibility / legend. */
  label?: string;
}

/**
 * A single segment on a stacked progress visualisation. `id` is
 * stable (React keying); `label` is human-readable;
 * `colorClassName` is a Tailwind token class rather than a hex code
 * so the segment inherits theme changes.
 */
export interface ProgressSegment {
  id: string;
  label: string;
  value: number;
  colorClassName?: string;
}

// ─── KPI card data ───────────────────────────────────────────────────

/**
 * The primitive a single KPI card renders. Kept small on purpose —
 * anything more elaborate (sparkline, segmented breakdown) is a
 * separate prop on the component, not a field on the metric itself.
 */
export interface KpiMetric {
  label: string;
  /** `null` / `undefined` ⇒ "no data"; consumers render a fallback. */
  value: number | null | undefined;
  format?: 'number' | 'percent' | 'compact';
  /** Delta vs. the previous period. `null` / `undefined` hides the indicator. */
  delta?: number | null;
  /** Human-readable label for the delta — "vs. last quarter", etc. */
  deltaLabel?: string;
  /** Free-form secondary line (e.g. "15 of 20 implemented"). */
  subtitle?: string;
}

// ─── Chart lifecycle state ───────────────────────────────────────────

/**
 * Discriminated union for the "what is the chart showing" question.
 * Consumers that wrap a chart with its own data-fetching hook (the
 * dashboard / reporting surfaces do this) should store their fetch
 * result as a `ChartState<T>` and render the appropriate branch —
 * avoiding the `loading ? … : error ? … : data?.length ? … : emptyState`
 * nested-ternary drift that pre-Epic-59 chart call sites all had.
 */
export type ChartState<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly message?: string }
  | { readonly kind: 'ready'; readonly data: T };

/** Constructor helper: `chartLoading()`. */
export function chartLoading<T>(): ChartState<T> {
  return { kind: 'loading' };
}
/** Constructor helper: `chartEmpty()`. */
export function chartEmpty<T>(): ChartState<T> {
  return { kind: 'empty' };
}
/** Constructor helper: `chartError('reason')`. */
export function chartError<T>(message?: string): ChartState<T> {
  return { kind: 'error', message };
}
/** Constructor helper: `chartReady(data)`. */
export function chartReady<T>(data: T): ChartState<T> {
  return { kind: 'ready', data };
}
/** Narrowing helper: `isChartReady(state) ? state.data : fallback`. */
export function isChartReady<T>(
  state: ChartState<T>,
): state is { readonly kind: 'ready'; readonly data: T } {
  return state.kind === 'ready';
}
