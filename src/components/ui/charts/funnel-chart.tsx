/* eslint-disable react-hooks/exhaustive-deps -- Various useEffect/useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers recreated each render) or use selector functions whose change-detection happens elsewhere. Adding the deps would either trigger unnecessary re-runs OR cause infinite render loops; the proper structural fix is to wrap parent-level callbacks in useCallback. Tracked as follow-up. */

/**
 * Roadmap-21 PR-D — Funnel polish on R16 chart-tokens.
 *
 * Five refinements applied over the legacy FunnelChart:
 *
 *   1. Curve. `curveBasis` (the legacy choice) produces a very
 *      "smoothed" silhouette that under-emphasises the actual
 *      drop between stages — the funnel reads as one continuous
 *      slope rather than discrete stage transitions. R21-PR-D
 *      swaps to `curveCatmullRom` (centripetal): the silhouette
 *      now reads each stage's value AT the stage boundary, with
 *      a smooth-but-defined transition. Same curve family as the
 *      R16 LineChart, so the funnel + line tools speak one motion
 *      vocabulary.
 *
 *   2. Gradient fills. Each step accepts an optional
 *      `seriesIndex` (ChartSeriesIndex 1..6). When set, the
 *      step paints via `<ChartLinearGradient>` referencing the
 *      R16 chart-series tokens instead of `colorClassName`'s
 *      flat `currentColor`. Backward-compat — callers that
 *      omit seriesIndex still get the colourClassName render
 *      path verbatim.
 *
 *   3. Conversion-rate annotations. Between every pair of
 *      adjacent stages, the chart now surfaces the conversion
 *      delta — small tabular-nums text reading e.g. `−35%` or
 *      `→ 65%`. Currently only the absolute % per stage was
 *      visible; the between-stage delta makes the funnel's
 *      ACTUAL story (where the drop-off happens) readable at
 *      a glance.
 *
 *   4. Hover-isolate sibling fade. When a stage is hovered (or
 *      the default tooltip is pinned), every OTHER stage's
 *      gradient layer dims to 0.3 opacity. Same vocabulary R16
 *      hover-pop established for donut + radar — the focused
 *      thing reads bright, the rest reads recessed.
 *
 *   5. Tooltip on the token vocabulary. The legacy tooltip
 *      hard-coded `bg-white` + `border-neutral-200`. R21-PR-D
 *      uses `ChartTooltipContainer` (the Epic 59 + R16 shared
 *      tooltip surface) so the funnel tooltip reads as part of
 *      the broader chart tooltip system and flips correctly with
 *      the theme.
 */

import { cn } from "@/lib/cn";
import { currencyFormatter, nFormatter } from "@/lib/number-format";
import { curveCatmullRom } from "@visx/curve";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { Area } from "@visx/shape";
import { Text } from "@visx/text";
import { motion } from "motion/react";
import { Fragment, useMemo, useRef, useState } from "react";

import { ChartLinearGradient, type ChartSeriesIndex } from "./chart-gradient";
import { ChartTooltipContainer } from "./interaction";
import { useMediaQuery } from "../hooks";

const layers = [
  {
    opacity: 1,
    padding: 0,
  },
  {
    opacity: 0.3,
    padding: 8,
  },
  {
    opacity: 0.15,
    padding: 16,
  },
];

const maxLayerPadding = 16;

type FunnelChartProps = {
  steps: {
    id: string;
    label: string;
    value: number;
    additionalValue?: number;
    /**
     * Legacy fallback colour. Used via `fill="currentColor"` when
     * `seriesIndex` is not set. Existing callers continue to work
     * unchanged.
     */
    colorClassName: string;
    /**
     * R21-PR-D — optional R16 chart-series index. When set, the
     * step paints with the matching `<ChartLinearGradient>`
     * (vertical) so the funnel speaks the same colour vocabulary
     * as the rest of the chart family. Falls back to
     * `colorClassName` when omitted.
     */
    seriesIndex?: ChartSeriesIndex;
  }[];
  persistentPercentages?: boolean;
  tooltips?: boolean;
  defaultTooltipStepId?: string;
  chartPadding?: number;
  /**
   * R21-PR-D — chart-id prefix for SVG `<defs>` ids so multiple
   * funnels on one page don't collide. Defaults to a stable
   * literal — callers SHOULD pass a unique id when mounting more
   * than one funnel on the same page.
   */
  chartId?: string;
};

export function FunnelChart(props: FunnelChartProps) {
  return (
    <div className="size-full">
      <ParentSize className="relative">
        {({ width, height }) =>
          width && height ? (
            <FunnelChartInner {...props} width={width} height={height} />
          ) : null
        }
      </ParentSize>
    </div>
  );
}

function FunnelChartInner({
  width,
  height,
  steps,
  persistentPercentages = true,
  tooltips = true,
  defaultTooltipStepId,
  chartPadding = 40,
  chartId = "funnel-chart",
}: {
  width: number;
  height: number;
} & FunnelChartProps) {
  const { isMobile } = useMediaQuery();

  const [tooltip, setTooltip] = useState<string | null>(
    defaultTooltipStepId ?? null,
  );
  const tooltipStep = steps.find(({ id }) => id === tooltip);

  const data = useMemo(() => {
    return Object.fromEntries(
      steps.map(({ id, value }, idx) => [
        id,
        interpolate(
          value,
          steps[idx + 1]?.value ?? steps[steps.length - 1].value,
        ),
      ]),
    );
  }, [steps]);

  const zeroData = useMemo(() => interpolate(0, 0), [steps]);

  const maxValue = useMemo(
    () => Math.max(...steps.map((step) => step.value)),
    [steps],
  );

  const xScale = scaleLinear({
    domain: [0, steps.length],
    range: [0, width],
  });

  const yScale = scaleLinear({
    domain: [maxValue, -maxValue],
    range: [
      height - maxLayerPadding - chartPadding,
      maxLayerPadding + chartPadding,
    ],
  });

  // R21-PR-D — collect every distinct seriesIndex used so we can
  // mint one <ChartLinearGradient> def per series. Avoids duplicate
  // defs when multiple steps share a series (rare but cheap to
  // dedupe).
  const seriesIndicesInUse = useMemo<ChartSeriesIndex[]>(() => {
    const set = new Set<ChartSeriesIndex>();
    for (const s of steps) if (s.seriesIndex) set.add(s.seriesIndex);
    return Array.from(set);
  }, [steps]);

  return (
    <div className="relative">
      <svg
        width={width}
        height={height}
        // R21-PR-D-hotfix — the per-stage `<rect>` carried its own
        // `onPointerLeave` that reset `tooltip` to the default. When
        // the cursor crossed an adjacent stage boundary, leave fired
        // on stage A → tooltip flipped to default → and only THEN
        // did enter fire on stage B. One frame at the default state
        // caused every stage's `isolationMultiplier` to snap from
        // 0.3 → 1 → 0.3, reading as a flicker.
        //
        // The leave-to-default behaviour belongs at the chart
        // boundary, not the per-stage boundary: when the cursor
        // truly exits the chart, restore the default. Crossing
        // between adjacent stages is a pure enter on the new stage.
        onPointerLeave={() =>
          !isMobile && setTooltip(defaultTooltipStepId ?? null)
        }
      >
        {/* R21-PR-D — gradient defs for every series in use. */}
        <defs>
          {seriesIndicesInUse.map((seriesIndex) => (
            <ChartLinearGradient
              key={seriesIndex}
              id={`${chartId}-series-${seriesIndex}`}
              series={seriesIndex}
              direction="vertical"
            />
          ))}
        </defs>
        {steps.map(({ id, value, colorClassName, seriesIndex }, idx) => {
          const stepCenterX = (xScale(idx) + xScale(idx + 1)) / 2;
          const isHoveredStage = tooltip === id;
          const hasOtherTooltip = tooltip !== null && tooltip !== id;
          // R21-PR-D — sibling fade. When a different stage is
          // focused, this one drops to 0.3 of its full opacity
          // family. Same vocabulary R16 hover-pop uses across
          // donut / radar / gantt.
          const isolationMultiplier = hasOtherTooltip ? 0.3 : 1;
          // R21-PR-D — between-stage conversion delta. We compute
          // it relative to the PREVIOUS step's value (so step 1
          // is "100% baseline" and step 2 onward shows the drop).
          const prev = idx > 0 ? steps[idx - 1].value : null;
          const deltaPct =
            prev !== null && prev > 0 ? (value / prev) * 100 : null;
          return (
            <Fragment key={id}>
              {/* Background */}
              {tooltips && (
                <rect
                  x={xScale(idx)}
                  y={0}
                  width={width / steps.length}
                  height={height}
                  className="fill-transparent transition-colors hover:fill-[var(--brand-subtle)]"
                  onPointerEnter={() => setTooltip(id)}
                  onPointerDown={() => setTooltip(id)}
                />
              )}

              {/* Divider line */}
              <line
                x1={xScale(idx)}
                y1={0}
                x2={xScale(idx)}
                y2={height}
                className="stroke-border-subtle"
              />

              {/* Funnel — gradient OR colourClassName fill. */}
              {layers.map(({ opacity, padding }) => (
                <Area
                  key={`${id}-${opacity}-${padding}`}
                  data={data[id]}
                  curve={curveCatmullRom}
                  x={(d) => xScale(idx + d.x)}
                  y0={(d) => yScale(-d.y) - padding}
                  y1={(d) => yScale(d.y) + padding}
                >
                  {({ path }) => {
                    const effectiveOpacity = opacity * isolationMultiplier;
                    return (
                      <motion.path
                        initial={{ d: path(zeroData) || "", opacity: 0 }}
                        animate={{
                          d: path(data[id]) || "",
                          opacity: effectiveOpacity,
                        }}
                        transition={{ opacity: { duration: 0.15 } }}
                        className={cn(
                          !seriesIndex && colorClassName,
                          "pointer-events-none",
                        )}
                        fill={
                          seriesIndex
                            ? `url(#${chartId}-series-${seriesIndex})`
                            : "currentColor"
                        }
                      />
                    );
                  }}
                </Area>
              ))}

              {/* R21-PR-D — between-stage conversion annotation.
                  Sits at the BOUNDARY between this stage and the
                  previous one (x = xScale(idx)). Skipped on stage 0
                  because there's no "from" reference for the % yet. */}
              {deltaPct !== null && idx > 0 && (
                <Text
                  x={xScale(idx)}
                  y={maxLayerPadding + 8}
                  textAnchor="middle"
                  verticalAnchor="start"
                  fontSize={10}
                  className={cn(
                    "fill-content-muted font-mono tabular-nums select-none",
                    isHoveredStage && "fill-[var(--brand-default)]",
                  )}
                >
                  {deltaPct >= 100
                    ? `→ ${formatPercentage(deltaPct)}%`
                    : `→ ${formatPercentage(deltaPct)}%`}
                </Text>
              )}

              {/* Percentage */}
              {persistentPercentages && (
                <PersistentPercentage
                  x={stepCenterX}
                  y={height / 2}
                  value={formatPercentage((value / maxValue) * 100) + "%"}
                  colorClassName={colorClassName}
                />
              )}
            </Fragment>
          );
        })}
      </svg>
      {tooltipStep && (
        <div
          key={tooltipStep.id}
          className={cn(
            "pointer-events-none absolute flex items-center justify-center px-1 pb-4",
            persistentPercentages
              ? "animate-slide-up-fade top-16 sm:top-12"
              : "animate-fade-in top-1/2 -translate-y-1/2",
          )}
          style={{
            left: xScale(steps.findIndex(({ id }) => id === tooltipStep.id)),
            width: width / steps.length,
          }}
        >
          {/* R21-PR-D — ChartTooltipContainer replaces the legacy
              hard-coded white surface; the funnel tooltip now reads
              as part of the broader chart tooltip system and flips
              correctly with the theme. */}
          <ChartTooltipContainer title={tooltipStep.label}>
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-2">
              <div className="flex items-center gap-tight">
                <div
                  className={cn(
                    !tooltipStep.seriesIndex && tooltipStep.colorClassName,
                    "h-2 w-2 shrink-0 rounded-sm shadow-[inset_0_0_0_1px_#0003]",
                  )}
                  style={
                    tooltipStep.seriesIndex
                      ? {
                          background: `linear-gradient(135deg, var(--chart-series-${tooltipStep.seriesIndex}-start), var(--chart-series-${tooltipStep.seriesIndex}-end))`,
                        }
                      : { background: "currentColor", opacity: 0.5 }
                  }
                />
                <p className="whitespace-nowrap capitalize text-content-muted">
                  {formatPercentage((tooltipStep.value / maxValue) * 100) + "%"}
                </p>
              </div>
              <p className="whitespace-nowrap font-medium text-content-emphasis">
                {nFormatter(tooltipStep.value, { full: true })}
                {tooltipStep.additionalValue !== undefined && (
                  <span className="text-content-subtle">
                    {" "}
                    ({currencyFormatter(tooltipStep.additionalValue)})
                  </span>
                )}
              </p>
            </div>
          </ChartTooltipContainer>
        </div>
      )}
    </div>
  );
}

function PersistentPercentage({
  x,
  y,
  value,
  colorClassName,
}: {
  x: number;
  y: number;
  value: string;
  colorClassName: string;
}) {
  const textRef = useRef<SVGTextElement>(null);

  // SVG text-measurement pattern: read the rendered text width from
  // the DOM ref to size the surrounding pill. On first render the ref
  // is null so width=0 (rect collapses); after the ref attaches
  // React re-renders with the measured width. Acceptable double-render
  // because the alternative useState+useEffect pattern is the same
  // double-render with extra ceremony.
  // eslint-disable-next-line react-hooks/refs -- reads a DOM measurement during render; the first pass is null so the pill collapses and the ref attach re-renders with the real width — the same double render useState+useEffect would cost, with less ceremony
  const textWidth = textRef.current?.getComputedTextLength() ?? 0;
  const pillWidth = textWidth + 28;

  return (
    <g>
      <rect
        x={x - pillWidth / 2}
        width={pillWidth}
        y={y - 14}
        height={28}
        rx={14}
        className="fill-bg-elevated"
      />
      <Text
        innerTextRef={textRef}
        x={x}
        y={y}
        textAnchor="middle"
        verticalAnchor="middle"
        fill="currentColor"
        fontSize={14}
        className={cn(
          "pointer-events-none select-none font-medium brightness-50",
          colorClassName,
        )}
      >
        {value}
      </Text>
    </g>
  );
}

const formatPercentage = (value: number) => {
  return value > 0 && value < 0.01
    ? "< 0.01"
    : nFormatter(value, { digits: 2 });
};

const interpolate = (from: number, to: number) => [
  { x: 0, y: from },
  { x: 0.3, y: from },
  { x: 0.5, y: (from + to) / 2 },
  { x: 0.7, y: to },
  { x: 1, y: to },
];
