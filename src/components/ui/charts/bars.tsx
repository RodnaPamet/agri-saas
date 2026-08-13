import { cn } from "@/lib/cn";
import { RectClipPath } from "@visx/clip-path";
import { Group } from "@visx/group";
import { BarRounded } from "@visx/shape";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import { useChartContext } from "./chart-context";
import { ChartGloss, chartGlossId } from "./chart-gloss";

/**
 * R18-PR8 + PR-9 — bubbly bars.
 *
 * Four changes to the Epic-59 `<Bars>` primitive:
 *
 *   1. SETTLE-BOUNCE on mount (PR-8). Each date-column grows up
 *      from the x-axis baseline through a SPRING (`scaleY` 0 →
 *      overshoot → 1), staggered left-to-right by column index.
 *
 *   2. GLOSS (PR-8). A shared vertical `<ChartGloss>` def; every
 *      bar paints a second `<BarRounded>` overlay with the gloss
 *      fill — the two-layer paint from chart-gloss.tsx.
 *
 *   3. ROUNDER TOPS (PR-8). The default corner radius bumps
 *      2 → 3.
 *
 *   4. HOVER BUBBLE-OUT (PR-9). Each individual bar springs its
 *      `scale` 1 → ~1.06 on hover — it "bubbles out" toward the
 *      pointer. The hover scale pivots at the bar's CENTRE (so
 *      it pops symmetrically toward the viewer), distinct from
 *      the PR-8 settle-bounce which pivots at the column bottom.
 *
 * The PR-8 scaleY spring pivots at the column's BOTTOM (the
 * x-axis baseline); the PR-9 hover scale pivots at each bar's
 * CENTRE. Two transforms, two pivots, two motion.g layers — the
 * column-level settle-bounce wraps the per-bar hover bubble.
 */

interface BarItem {
  id: string;
  value: number;
  colorClassName: string | undefined;
  styles: { id: string; barClassName?: string; barFill?: string } | undefined;
  y: number;
  height: number;
}

/** Per-column stagger (ms) so the bars bubble up left-to-right. */
const BAR_STAGGER_MS = 45;

/** Hover bubble-out scale — the bar pops to 106% toward the pointer. */
const BAR_HOVER_SCALE = 1.06;

export function Bars({
  seriesStyles,
  radius = 3,
}: {
  seriesStyles?: {
    id: string;
    barClassName?: string;
    barFill?: string;
  }[];
  radius?: number;
}) {
  const clipPathId = useId();
  const reactId = useId();
  const chartId = `bars-${reactId.replace(/:/g, "")}`;

  // R18-PR9 — hover state. Keyed by `${date}|${seriesId}` so each
  // bar in a stacked column bubbles independently. `null` when
  // nothing is hovered.
  const [hoveredBarKey, setHoveredBarKey] = useState<string | null>(null);
  const {
    data,
    series,
    margin,
    xScale,
    yScale,
    width,
    height,
    startDate,
    endDate,
  } = useChartContext();

  if (!("bandwidth" in xScale))
    throw new Error("Bars require a band scale (type=bar)");

  const activeSeries = series.filter(({ isActive }) => isActive);

  return (
    <Group left={margin.left} top={margin.top}>
      <RectClipPath id={clipPathId} x={0} y={0} width={width} height={height} />
      {/* R18-PR8 — shared gloss def. One vertical sheen for the
          whole bar cluster: every bar is in the same plot under
          the same light. `default` intensity — a full-size chart
          surface, not a sparkline. */}
      <defs>
        <ChartGloss
          id={chartGlossId(chartId)}
          direction="vertical"
          intensity="default"
        />
      </defs>
      <AnimatePresence>
        <motion.g
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.1 }}
          key={`${activeSeries.map((s) => s.id).join(",")}_${startDate.toString()}_${endDate.toString()}`}
          clipPath={`url(#${clipPathId})`}
        >
          {data.map((d, columnIndex) => {
            const barWidth = xScale.bandwidth();
            const x = xScale(d.date) ?? 0;

            // A series with no value at this date contributes no bar. The
            // `?? 0` fallbacks keep the arithmetic total: an absent value and
            // a zero-height bar are the same thing for a stack, unlike for a
            // line, where absent must be a gap rather than a point at zero.
            const sortedSeries = activeSeries
              .filter((s) => (s.valueAccessor(d) ?? 0) > 0)
              .sort((a, b) => (b.valueAccessor(d) ?? 0) - (a.valueAccessor(d) ?? 0));

            const bars = sortedSeries.reduce((acc, s) => {
              const stackHeight = acc.reduce((sum, b) => sum + b.height, 0);
              const value = s.valueAccessor(d) ?? 0;
              const y = yScale(value);

              return [
                ...acc,
                {
                  id: s.id,
                  value,
                  colorClassName: s.colorClassName,
                  styles: seriesStyles?.find(({ id }) => id === s.id),
                  y: stackHeight, // y from x axis to bottom of bar
                  height: height - y, // height from bottom to top of bar
                },
              ];
            }, [] as BarItem[]);

            return (
              // R18-PR8 — settle-bounce. The whole date-column
              // springs up from the x-axis baseline. `scaleY` 0 →
              // 1 through a spring (stiffness/damping tuned for a
              // visible overshoot), pivoted at the column bottom
              // (`transformOrigin` y = `height`, the baseline) so
              // a stacked column grows as one unit. Per-column
              // `delay` staggers the cluster left-to-right.
              <motion.g
                key={d.date.toString()}
                initial={{ scaleY: 0 }}
                animate={{ scaleY: 1 }}
                transition={{
                  scaleY: {
                    type: "spring",
                    stiffness: 420,
                    damping: 17,
                    delay: (columnIndex * BAR_STAGGER_MS) / 1000,
                  },
                }}
                style={{
                  transformOrigin: `${x + barWidth / 2}px ${height}px`,
                }}
              >
                {bars.map((b, idx) => {
                  const rounding =
                    idx === bars.length - 1
                      ? { top: true, radius }
                      : { radius: 0 };
                  const barTop = height - b.height - b.y;
                  // R18-PR9 — hover bubble-out. Key + the bar's
                  // geometric centre (for the scale pivot).
                  const barKey = `${d.date.toString()}|${b.id}`;
                  const isHovered = hoveredBarKey === barKey;
                  const barCenterX = x + barWidth / 2;
                  const barCenterY = barTop + b.height / 2;
                  return (
                    <motion.g
                      key={b.id}
                      onMouseEnter={() => setHoveredBarKey(barKey)}
                      onMouseLeave={() => setHoveredBarKey(null)}
                      animate={{ scale: isHovered ? BAR_HOVER_SCALE : 1 }}
                      transition={{
                        // Spring, not duration/ease — the
                        // overshoot is the "bubble-out." Tuned
                        // to settle inside a brisk hover window.
                        type: "spring",
                        stiffness: 480,
                        damping: 18,
                      }}
                      style={{
                        // Pivot at the bar's CENTRE — the bar
                        // pops symmetrically toward the viewer.
                        // (PR-8's column settle-bounce pivots at
                        // the baseline; this is the inner layer.)
                        transformOrigin: `${barCenterX}px ${barCenterY}px`,
                        cursor: "pointer",
                      }}
                    >
                      {/* Colour layer — the series fill. */}
                      <BarRounded
                        x={x}
                        y={barTop}
                        width={barWidth}
                        height={b.height}
                        className={cn(
                          b.colorClassName ?? "text-brand-emphasis",
                          b.styles?.barClassName,
                        )}
                        fill={b.styles?.barFill || "currentColor"}
                        {...rounding}
                      />
                      {/* R18-PR8 — gloss layer. SAME bar geometry,
                          painted on top, filled with the shared
                          gloss def. The white→transparent ramp
                          gives each bar a glass sheen down its
                          length. aria-hidden + pointer-events:none
                          — light, not data; never intercepts the
                          hover that belongs to the motion.g. */}
                      <BarRounded
                        x={x}
                        y={barTop}
                        width={barWidth}
                        height={b.height}
                        fill={`url(#${chartGlossId(chartId)})`}
                        aria-hidden="true"
                        pointerEvents="none"
                        {...rounding}
                      />
                    </motion.g>
                  );
                })}
              </motion.g>
            );
          })}
        </motion.g>
      </AnimatePresence>
    </Group>
  );
}
