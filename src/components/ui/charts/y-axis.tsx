/* eslint-disable react-hooks/exhaustive-deps -- Various useEffect/useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers recreated each render) or use selector functions whose change-detection happens elsewhere. Adding the deps would either trigger unnecessary re-runs OR cause infinite render loops; the proper structural fix is to wrap parent-level callbacks in useCallback. Tracked in #2736. */
import { AxisLeft } from "@visx/axis";
import { Group } from "@visx/group";
import { Line } from "@visx/shape";
import { getStringWidth } from "@visx/text";
import { useLayoutEffect, useMemo } from "react";

import { useChartContext } from "./chart-context";
import {
    AXIS_LABEL_FONT_SIZE,
    DEFAULT_Y_AXIS_TICK_AXIS_SPACING,
    formatNumericTick,
    pickYAxisTickCount,
} from "./layout";

export type YAxisProps = {
    /** Approximate number of ticks to generate (see d3-array's `ticks`). */
    numTicks?: number;

    /** Whether to render dashed grid lines across the chart area. */
    showGridLines?: boolean;

    /** Whether to only generate integer ticks (no decimals). */
    integerTicks?: boolean;

    /** Tick values to override dynamic tick generation. */
    tickValues?: number[];

    /** Custom formatting function for tick labels. */
    tickFormat?: (value: number) => string;

    /** Amount of space between tick labels and the axis line / chart area. */
    tickAxisSpacing?: number;
};

/**
 * Token-backed y-axis. Tick labels are rendered with `--content-muted`
 * for readability in both themes; grid lines use `--border-subtle` so
 * they sit quietly behind the plotted series. Tick density falls back
 * to `pickYAxisTickCount` — a chart-height-aware default shared with
 * every other chart surface in the platform.
 */
export function YAxis({
    numTicks: numTicksProp,
    showGridLines = false,
    integerTicks = false,
    tickValues: tickValuesProp,
    tickFormat = formatNumericTick,
    tickAxisSpacing = DEFAULT_Y_AXIS_TICK_AXIS_SPACING,
}: YAxisProps) {
    const {
        width,
        height,
        margin,
        yScale,
        minY,
        leftAxisMargin,
        setLeftAxisMargin,
    } = useChartContext();

    const tickValues = useMemo(() => {
        if (tickValuesProp) return tickValuesProp;

        const numTicks = numTicksProp ?? pickYAxisTickCount(height);

        return yScale.ticks(numTicks).filter((value) =>
            // Both reduce the number of ticks farther below numTicks, but only
            // affect small ranges.
            value >= minY && integerTicks ? Number.isInteger(value) : true,
        );
    }, [tickValuesProp, numTicksProp, height, yScale, integerTicks]);

    useLayoutEffect(() => {
        const maxWidth =
            Math.max(
                ...tickValues.map(
                    (v) =>
                        getStringWidth(tickFormat(v), {
                            fontSize: AXIS_LABEL_FONT_SIZE,
                        }) ?? 0,
                ),
            ) + tickAxisSpacing;
        if ((leftAxisMargin ?? 0) < maxWidth) setLeftAxisMargin(maxWidth);
    }, [tickValues, tickAxisSpacing, leftAxisMargin]);

    return (
        <>
            <AxisLeft
                left={margin.left}
                top={margin.top}
                scale={yScale}
                tickValues={tickValues}
                hideTicks
                stroke="transparent"
                tickFormat={(value) => tickFormat(value as number)}
                tickLength={tickAxisSpacing}
                tickLabelProps={() => ({
                    fontSize: AXIS_LABEL_FONT_SIZE,
                    fill: "var(--content-muted)",
                    textAnchor: "end",
                    verticalAnchor: "middle",
                })}
            />
            {showGridLines && (
                <Group left={margin.left} top={margin.top}>
                    {tickValues.length > 0 &&
                        tickValues.map((value) => {
                            const y = yScale(value);
                            if (y === height) return undefined; // Skip grid line at bottom edge.

                            return (
                                <Line
                                    key={value.toString()}
                                    y1={y}
                                    y2={y}
                                    x1={0}
                                    x2={width}
                                    stroke="var(--border-subtle)"
                                    strokeWidth={1}
                                    strokeDasharray={5}
                                />
                            );
                        })}
                </Group>
            )}
        </>
    );
}
