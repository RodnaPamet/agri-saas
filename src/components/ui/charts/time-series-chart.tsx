/* eslint-disable react-hooks/exhaustive-deps -- Various useEffect/useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers recreated each render) or use selector functions whose change-detection happens elsewhere. Adding the deps would either trigger unnecessary re-runs OR cause infinite render loops; the proper structural fix is to wrap parent-level callbacks in useCallback. Tracked as follow-up. */
"use client";

import { useTranslations } from "next-intl";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { Bar, Circle, Line } from "@visx/shape";
import { PropsWithChildren, ReactNode, useMemo, useState } from "react";

import { ChartContext, ChartTooltipContext } from "./chart-context";
import { ChartTooltipContainer } from "./interaction";
import {
    DEFAULT_CHART_MARGIN,
    buildTimeSeriesXScale,
    buildYScale,
    computeYDomain,
    getDateExtent,
    resolveChartPadding,
} from "./layout";
import {
    ChartProps,
    Datum,
    type ChartContext as ChartContextType,
} from "./types";
import { useTooltip } from "./use-tooltip";

/**
 * Epic 59 — canonical interactive time-series chart.
 *
 * One component powers every dashboard trend panel and future
 * reporting surface. Composes the shared axis / tooltip / layout
 * primitives so every consumer inherits the same spacing, tick
 * density, token-backed palette, and hover behaviour.
 *
 * Usage:
 *
 *   <TimeSeriesChart data={data} series={series}>
 *       <YAxis showGridLines />
 *       <Areas />
 *       <XAxis />
 *   </TimeSeriesChart>
 *
 * Passes through to `<ChartContext.Provider>` + `<ChartTooltipContext.Provider>`
 * so the children (`<Areas>`, `<Bars>`, `<XAxis>`, `<YAxis>`, or any
 * caller-provided overlay) can reach the shared state via the hooks
 * in `./chart-context`.
 *
 * No-data handling: when `data` or `series` is empty the chart
 * renders its `emptyState` instead of a silent zero-height block —
 * dashboards never show a mystery gap where a chart was supposed to
 * be.
 */

interface TimeSeriesChartExtraProps {
    /**
     * Content rendered when `data` or `series` is empty. Defaults to
     * an inline, token-backed copy that matches the broader empty-state
     * dialect. Pass a `<EmptyState icon={...} title=… />` (from
     * `src/components/ui/empty-state.tsx`) for page-level emptiness.
     */
    emptyState?: ReactNode;

    /** Optional className forwarded to the outer wrapper (positioning / height). */
    className?: string;

    /**
     * Accessible name for the chart `<svg role="img">`. Defaults to a generic
     * i18n label so every time-series chart satisfies the `svg-img-alt` a11y
     * rule; pass a specific description (e.g. "Farm task trend, last 14 days")
     * for richer screen-reader output.
     */
    ariaLabel?: string;
}

type TimeSeriesChartProps<T extends Datum> = PropsWithChildren<ChartProps<T>> &
    TimeSeriesChartExtraProps;

export function TimeSeriesChart<T extends Datum>(
    props: TimeSeriesChartProps<T>,
) {
    const t = useTranslations("ui");
    const isEmpty = props.data.length === 0 || props.series.length === 0;

    const defaultEmptyState = (
        <div
            data-chart-empty
            role="status"
            className="flex h-full w-full items-center justify-center px-6 py-8 text-center text-sm text-content-muted"
        >
            {t("timeSeriesChart.emptyState")}
        </div>
    );

    return (
        <ParentSize className={props.className ?? "relative"}>
            {({ width, height }) => {
                if (width <= 0 || height <= 0) return null;
                if (isEmpty) {
                    return (
                        <div
                            style={{ width, height }}
                            className="flex items-center justify-center"
                        >
                            {props.emptyState ?? defaultEmptyState}
                        </div>
                    );
                }
                return (
                    <TimeSeriesChartInner
                        {...props}
                        width={width}
                        height={height}
                    />
                );
            }}
        </ParentSize>
    );
}

function TimeSeriesChartInner<T extends Datum>({
    type = "area",
    width: outerWidth,
    height: outerHeight,
    children,
    data,
    series,
    tooltipContent = (d) => series[0].valueAccessor(d).toString(),
    tooltipClassName = "",
    defaultTooltipIndex = null,
    onHoverDateChange,
    margin: marginProp = DEFAULT_CHART_MARGIN,
    padding: paddingProp,
    ariaLabel,
}: {
    width: number;
    height: number;
} & TimeSeriesChartProps<T>) {
    const t = useTranslations("ui");
    const [leftAxisMargin, setLeftAxisMargin] = useState<number>();

    const margin = {
        ...marginProp,
        left: marginProp.left + (leftAxisMargin ?? 0),
    };

    const padding = resolveChartPadding(type, paddingProp);

    const width = outerWidth - margin.left - margin.right;
    const height = outerHeight - margin.top - margin.bottom;

    const { startDate, endDate } = useMemo(() => getDateExtent(data), [data]);

    const { minY, maxY } = useMemo(
        () => computeYDomain({ data, series, type }),
        [data, series, type],
    );

    const { yScale, xScale } = useMemo(
        () => ({
            yScale: buildYScale({ minY, maxY, padding, height }),
            xScale: buildTimeSeriesXScale({
                data,
                startDate,
                endDate,
                width,
                type,
            }),
        }),
        [
            startDate,
            endDate,
            minY,
            maxY,
            height,
            width,
            data,
            type,
            padding.top,
            padding.bottom,
        ],
    );

    const chartContext: ChartContextType<T> = {
        type,
        width,
        height,
        data,
        series,
        startDate,
        endDate,
        // ScaleBand<Date> (from buildTimeSeriesXScale) is structurally compatible
        // with ChartContextType's xScale union at runtime; the cast bridges the
        // visx StringLike/Date gap without introducing `any`.
        xScale: xScale as ChartContextType<T>["xScale"],
        yScale,
        minY,
        maxY,
        margin,
        padding,
        tooltipContent,
        tooltipClassName,
        defaultTooltipIndex,
        onHoverDateChange,
        leftAxisMargin,
        setLeftAxisMargin,
    };

    const tooltipContext = useTooltip({
        seriesId: series[0].id,
        chartContext,
        onHoverDateChange,
        defaultIndex: defaultTooltipIndex ?? undefined,
    });

    const {
        tooltipData,
        TooltipWrapper,
        tooltipLeft,
        tooltipTop,
        handleTooltip,
        hideTooltip,
        containerRef,
    } = tooltipContext;

    const isBandScale = "bandwidth" in xScale;

    return (
        <ChartContext.Provider value={chartContext}>
            <ChartTooltipContext.Provider value={tooltipContext}>
                <svg
                    width={outerWidth}
                    height={outerHeight}
                    ref={containerRef}
                    role="img"
                    aria-label={ariaLabel ?? t("timeSeriesChart.ariaLabel")}
                    data-chart="time-series"
                    data-chart-type={type}
                >
                    {children}
                    <Group left={margin.left} top={margin.top}>
                        {/* Tooltip hover indicator */}
                        {tooltipData &&
                            (isBandScale ? (
                                <Bar
                                    x={
                                        (xScale(tooltipData.date) ?? 0) -
                                        xScale.bandwidth() * xScale.padding()
                                    }
                                    width={
                                        xScale.bandwidth() *
                                        (1 + xScale.padding() * 2)
                                    }
                                    y={0}
                                    height={height}
                                    fill="var(--content-emphasis)"
                                    fillOpacity={0.05}
                                />
                            ) : (
                                <>
                                    <Line
                                        x1={xScale(tooltipData.date)}
                                        x2={xScale(tooltipData.date)}
                                        y1={height}
                                        y2={0}
                                        stroke="var(--content-emphasis)"
                                        strokeOpacity={0.5}
                                        strokeWidth={1}
                                    />
                                    {series
                                        .filter(({ isActive }) => isActive)
                                        .map((s) => (
                                            <Circle
                                                key={s.id}
                                                cx={xScale(tooltipData.date)}
                                                cy={yScale(
                                                    s.valueAccessor(tooltipData),
                                                )}
                                                r={4}
                                                className={
                                                    s.colorClassName ??
                                                    "text-brand-emphasis"
                                                }
                                                fill="currentColor"
                                            />
                                        ))}
                                </>
                            ))}

                        {/* Tooltip hover capture region */}
                        <Bar
                            x={0}
                            y={0}
                            width={width}
                            height={height}
                            onTouchStart={handleTooltip}
                            onTouchMove={handleTooltip}
                            onMouseMove={handleTooltip}
                            onMouseLeave={hideTooltip}
                            fill="transparent"
                        />
                    </Group>
                </svg>

                {/* Tooltip surface — positioned by visx, styled by the
                    shared ChartTooltipContainer so every chart reads
                    as part of the same system. */}
                <div className="pointer-events-none absolute inset-0">
                    {tooltipData && (
                        <TooltipWrapper
                            key={tooltipData.date.toString()}
                            left={(tooltipLeft ?? 0) + margin.left}
                            top={(tooltipTop ?? 0) + margin.top}
                            offsetLeft={
                                isBandScale
                                    ? xScale.bandwidth() *
                                      (1 + xScale.padding())
                                    : 8
                            }
                            offsetTop={12}
                            className="absolute"
                            unstyled={true}
                        >
                            <ChartTooltipContainer className={tooltipClassName}>
                                {tooltipContent?.(tooltipData) ??
                                    series[0].valueAccessor(tooltipData)}
                            </ChartTooltipContainer>
                        </TooltipWrapper>
                    )}
                </div>
            </ChartTooltipContext.Provider>
        </ChartContext.Provider>
    );
}
