import { cn } from "@/lib/cn";
import { LinearGradient } from "@visx/gradient";
import { Group } from "@visx/group";
import { Area, AreaClosed, Circle } from "@visx/shape";
import { AnimatePresence, motion } from "motion/react";
import { useMemo } from "react";
import { useChartContext, useChartTooltipContext } from "./chart-context";
import { ChartGloss, chartGlossId } from "./chart-gloss";

export function Areas({
  seriesStyles,
  showLatestValueCircle = true,
}: {
  seriesStyles?: {
    id: string;
    gradientClassName?: string;
    lineClassName?: string;
    areaFill?: string;
    lineStroke?: string;
  }[];
  showLatestValueCircle?: boolean;
}) {
  const { data, series, margin, xScale, yScale, startDate, endDate } =
    useChartContext();

  if (!("ticks" in xScale))
    throw new Error("Areas require a time scale (type=area)");

  const { tooltipData } = useChartTooltipContext();

  // Data with all values set to zero to animate from
  const zeroedData = useMemo(() => {
    return data.map((d) => ({
      ...d,
      values: Object.fromEntries(Object.keys(d.values).map((key) => [key, 0])),
    })) as typeof data;
  }, [data]);

  return (
    <Group left={margin.left} top={margin.top}>
      <AnimatePresence>
        {series
          .filter(({ isActive }) => isActive)
          .map((s) => {
            const seriesStyle = seriesStyles?.find(({ id }) => id === s.id);
            return (
              // Prevent ugly x-scale animations when start/end dates change with unique key
              <motion.g
                initial={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
                // TODO: This key changes immediately and sometimes breaks enter/exit animations
                key={`${s.id}_${startDate.toString()}_${endDate.toString()}`}
              >
                {/* Area background mask gradient */}
                <LinearGradient
                  id={`${s.id}-mask-gradient`}
                  from="white"
                  to="white"
                  fromOpacity={0.2}
                  toOpacity={0}
                  x1={0}
                  x2={0}
                  y1={0}
                  y2={1}
                />
                <mask id={`${s.id}-mask`} maskContentUnits="objectBoundingBox">
                  <rect
                    width="1"
                    height="1"
                    fill={`url(#${s.id}-mask-gradient)`}
                  />
                </mask>

                {/* R18 visible-uplift — gloss def for the area
                    fill. The TrendCard ×4 row on the executive
                    dashboard is built on <Areas>; R18 polished
                    LineChart + MiniAreaChart but missed THIS
                    primitive entirely. `default` intensity — a
                    full TrendCard tile, not a tiny sparkline. */}
                <ChartGloss
                  id={chartGlossId(s.id)}
                  direction="vertical"
                  intensity="default"
                />

                {/* Area */}
                {/* `defined` is what makes a gap a GAP.
                    A series with nothing to say at a date yields undefined
                    (see computeYDomain, which already skips those). Without
                    `defined`, the `?? 0` below plots it at the baseline, so a
                    feed that stopped reporting draws a cliff to the floor
                    instead of ending. The `?? 0` stays because d3 still calls
                    `y` for undefined points and must get a number — `defined`
                    decides whether the point is drawn, `y` only has to not
                    throw. */}
                <AreaClosed
                  data={data}
                  x={(d) => xScale(d.date)}
                  y={(d) => yScale(s.valueAccessor(d) ?? 0)}
                  defined={(d) => s.valueAccessor(d) != null}
                  yScale={yScale}
                >
                  {({ path }) => {
                    return (
                      <>
                        {/* Colour layer — the series area fill. */}
                        <motion.path
                          initial={{ d: path(zeroedData) || "", opacity: 0 }}
                          animate={{ d: path(data) || "", opacity: 1 }}
                          className={cn(
                            s.colorClassName ?? "text-brand-default",
                            seriesStyle?.gradientClassName,
                          )}
                          mask={`url(#${s.id}-mask)`}
                          fill={seriesStyle?.areaFill ?? "currentColor"}
                        />
                        {/* R18 visible-uplift — gloss layer. SAME
                            `d` morph, painted on top, filled with
                            the gloss def — the two-layer paint
                            from chart-gloss.tsx. The white→
                            transparent ramp gives the area fill a
                            glass sheen near its top edge. Tracks
                            the colour layer's `d` morph so the
                            sheen rises with the fill. Inert. */}
                        <motion.path
                          initial={{ d: path(zeroedData) || "" }}
                          animate={{ d: path(data) || "" }}
                          fill={`url(#${chartGlossId(s.id)})`}
                          aria-hidden="true"
                          style={{ pointerEvents: "none" }}
                        />
                      </>
                    );
                  }}
                </AreaClosed>

                {/* Line */}
                <Area
                  data={data}
                  x={(d) => xScale(d.date)}
                  y={(d) => yScale(s.valueAccessor(d) ?? 0)}
                  defined={(d) => s.valueAccessor(d) != null}
                >
                  {({ path }) => (
                    <motion.path
                      initial={{ d: path(zeroedData) || "" }}
                      animate={{ d: path(data) || "" }}
                      className={cn(
                        s.colorClassName ?? "text-brand-emphasis",
                        seriesStyle?.lineClassName,
                      )}
                      stroke={seriesStyle?.lineStroke ?? "currentColor"}
                      strokeOpacity={0.8}
                      strokeWidth={2}
                      fill="transparent"
                    />
                  )}
                </Area>

                {/* Latest value circle — on the series' OWN last reported
                    point, not the last row in the dataset.
                    Those differ the moment a series stops early: the final
                    row belongs to whichever series is still reporting, and
                    reading this one's value there yields undefined, so
                    yScale(undefined) is NaN and the browser drops the circle
                    (or paints it at the origin). Walking back to the last
                    defined value puts the dot where the line actually ends. */}
                {showLatestValueCircle &&
                  !tooltipData &&
                  (() => {
                    const last = [...data]
                      .reverse()
                      .find((d) => s.valueAccessor(d) != null);
                    const lastValue = last && s.valueAccessor(last);
                    if (!last || lastValue == null) return null;
                    return (
                      <Circle
                        cx={xScale(last.date)}
                        cy={yScale(lastValue)}
                        r={4}
                        className={cn(
                          s.colorClassName ?? "text-brand-emphasis",
                          seriesStyle?.lineClassName,
                        )}
                        fill="currentColor"
                      />
                    );
                  })()}
              </motion.g>
            );
          })}
      </AnimatePresence>
    </Group>
  );
}
