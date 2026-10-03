/**
 * Epic 59 — chart layout helpers.
 *
 * Unit coverage for the pure layout + scale helpers every chart
 * composes (`TimeSeriesChart`, `FunnelChart`, future mini/sparkline
 * surfaces). Keeping these helpers visx-free on the type side lets
 * us test them in the node jest project without a DOM.
 */

import {
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
} from '@/components/ui/charts/layout';
import type { Data, Series } from '@/components/ui/charts';

interface DemoValues {
    coverage: number;
    issues?: number;
}

const data: Data<DemoValues> = [
    { date: new Date('2026-04-01T00:00:00Z'), values: { coverage: 70 } },
    { date: new Date('2026-04-02T00:00:00Z'), values: { coverage: 72 } },
    { date: new Date('2026-04-03T00:00:00Z'), values: { coverage: 74 } },
    { date: new Date('2026-04-04T00:00:00Z'), values: { coverage: 76 } },
    { date: new Date('2026-04-05T00:00:00Z'), values: { coverage: 78 } },
    { date: new Date('2026-04-06T00:00:00Z'), values: { coverage: 80 } },
];

const series: Series<DemoValues>[] = [
    { id: 'coverage', valueAccessor: (d) => d.values.coverage, isActive: true },
];

describe('resolveChartMargin', () => {
    it('returns the defaults when no overrides are supplied', () => {
        expect(resolveChartMargin()).toEqual(DEFAULT_CHART_MARGIN);
    });

    it('merges partial overrides onto the defaults', () => {
        expect(resolveChartMargin({ bottom: 40 })).toEqual({
            ...DEFAULT_CHART_MARGIN,
            bottom: 40,
        });
    });

    it('expands the left margin by the axis-label reserve', () => {
        const m = resolveChartMargin(undefined, 32);
        expect(m.left).toBe(DEFAULT_CHART_MARGIN.left + 32);
    });

    it('ignores a non-positive axis reserve', () => {
        expect(resolveChartMargin(undefined, 0)).toEqual(DEFAULT_CHART_MARGIN);
        expect(resolveChartMargin(undefined, -8)).toEqual(DEFAULT_CHART_MARGIN);
    });

    it('compact defaults stay smaller than the standard defaults', () => {
        expect(COMPACT_CHART_MARGIN.top).toBeLessThan(DEFAULT_CHART_MARGIN.top);
        expect(COMPACT_CHART_MARGIN.bottom).toBeLessThan(
            DEFAULT_CHART_MARGIN.bottom,
        );
    });
});

describe('resolveChartPadding', () => {
    it('area charts pad top + bottom so the line never clips the edges', () => {
        expect(resolveChartPadding('area')).toEqual(DEFAULT_AREA_Y_PADDING);
        expect(DEFAULT_AREA_Y_PADDING.top).toBeGreaterThan(0);
        expect(DEFAULT_AREA_Y_PADDING.bottom).toBeGreaterThan(0);
    });

    it('bar charts pad the top only — bottom stays at zero', () => {
        expect(resolveChartPadding('bar')).toEqual(DEFAULT_BAR_Y_PADDING);
        expect(DEFAULT_BAR_Y_PADDING.bottom).toBe(0);
    });

    it('caller-supplied overrides win over the defaults', () => {
        expect(resolveChartPadding('area', { top: 0.25 })).toEqual({
            top: 0.25,
            bottom: DEFAULT_AREA_Y_PADDING.bottom,
        });
    });
});

describe('getDateExtent', () => {
    it('returns the min + max dates in a dataset', () => {
        const { startDate, endDate } = getDateExtent(data);
        expect(startDate.getTime()).toBe(
            new Date('2026-04-01T00:00:00Z').getTime(),
        );
        expect(endDate.getTime()).toBe(
            new Date('2026-04-06T00:00:00Z').getTime(),
        );
    });

    it('is order-agnostic — unsorted input still yields the same extent', () => {
        const shuffled: Data<DemoValues> = [data[3], data[0], data[5], data[2]];
        const { startDate, endDate } = getDateExtent(shuffled);
        expect(startDate.getTime()).toBe(data[0].date.getTime());
        expect(endDate.getTime()).toBe(data[5].date.getTime());
    });

    it('degrades gracefully on an empty dataset', () => {
        const { startDate, endDate } = getDateExtent([]);
        expect(startDate.getTime()).toBe(endDate.getTime());
    });
});

describe('computeYDomain', () => {
    it('area charts use the raw min/max', () => {
        const { minY, maxY } = computeYDomain({ data, series, type: 'area' });
        expect(minY).toBe(70);
        expect(maxY).toBe(80);
    });

    it('bar charts floor the minimum at zero — bars must stay rooted', () => {
        const negative: Data<DemoValues> = [
            { date: new Date('2026-04-01'), values: { coverage: 10 } },
            { date: new Date('2026-04-02'), values: { coverage: 20 } },
        ];
        const { minY, maxY } = computeYDomain({
            data: negative,
            series,
            type: 'bar',
        });
        expect(minY).toBe(0);
        expect(maxY).toBe(20);
    });

    it('bar charts sum across active series per datum (stacked)', () => {
        const twoSeries: Series<DemoValues>[] = [
            { id: 'a', valueAccessor: (d) => d.values.coverage },
            { id: 'b', valueAccessor: (d) => d.values.coverage / 2 },
        ];
        const small: Data<DemoValues> = [
            { date: new Date('2026-04-01'), values: { coverage: 40 } },
        ];
        const { maxY } = computeYDomain({
            data: small,
            series: twoSeries,
            type: 'bar',
        });
        expect(maxY).toBe(60);
    });

    it('inactive series are excluded from the extent', () => {
        const twoSeries: Series<DemoValues>[] = [
            { id: 'a', valueAccessor: (d) => d.values.coverage, isActive: true },
            { id: 'b', valueAccessor: () => 9999, isActive: false },
        ];
        const { maxY } = computeYDomain({ data, series: twoSeries, type: 'area' });
        expect(maxY).toBe(80);
    });

    it('empty data returns a zeroed extent rather than throwing', () => {
        expect(computeYDomain({ data: [], series, type: 'area' })).toEqual({
            minY: 0,
            maxY: 0,
        });
    });
});

describe('buildYScale', () => {
    it('expands the domain by the padding percentages', () => {
        const scale = buildYScale({
            minY: 0,
            maxY: 100,
            padding: { top: 0.1, bottom: 0.1 },
            height: 200,
        });
        const [lo, hi] = scale.domain();
        // `nice` rounds the domain to friendly values, so we assert
        // it's at least as wide as the requested padding.
        expect(lo).toBeLessThanOrEqual(-10);
        expect(hi).toBeGreaterThanOrEqual(110);
    });

    it('maps maxY to 0 and minY to height', () => {
        const scale = buildYScale({
            minY: 0,
            maxY: 100,
            padding: { top: 0, bottom: 0 },
            height: 200,
        });
        expect(scale(100)).toBe(0);
        expect(scale(0)).toBe(200);
    });

    it('pads a flat series (minY === maxY) into a non-degenerate band', () => {
        // A constant series (e.g. a source that reports the same price every
        // week) would otherwise collapse to a [v, v] domain → every point maps
        // to the same y and the area fill renders as a solid block. The scale
        // must open a band around the value so the line sits mid-chart.
        const scale = buildYScale({
            minY: 400,
            maxY: 400,
            padding: { top: 0.1, bottom: 0.1 },
            height: 200,
        });
        const [lo, hi] = scale.domain();
        expect(hi).toBeGreaterThan(lo); // not degenerate
        expect(lo).toBeLessThan(400);
        expect(hi).toBeGreaterThan(400);
        // The constant value renders strictly inside the plot, not at an edge.
        expect(scale(400)).toBeGreaterThan(0);
        expect(scale(400)).toBeLessThan(200);
    });

    it('pads a flat zero series without dividing by zero', () => {
        const scale = buildYScale({
            minY: 0,
            maxY: 0,
            padding: { top: 0.1, bottom: 0.1 },
            height: 200,
        });
        const [lo, hi] = scale.domain();
        expect(hi).toBeGreaterThan(lo);
    });
});

describe('buildTimeSeriesXScale', () => {
    const { startDate, endDate } = getDateExtent(data);

    it('area charts get a continuous utc scale', () => {
        const scale = buildTimeSeriesXScale({
            data,
            startDate,
            endDate,
            width: 500,
            type: 'area',
        });
        expect('invert' in scale).toBe(true);
        expect(scale(startDate)).toBe(0);
        expect(scale(endDate)).toBe(500);
    });

    it('bar charts get a discrete band scale', () => {
        const scale = buildTimeSeriesXScale({
            data,
            startDate,
            endDate,
            width: 500,
            type: 'bar',
        });
        expect('bandwidth' in scale).toBe(true);
        // Every datum in the domain maps to a finite column x.
        expect(scale.domain().length).toBe(data.length);
    });
});

describe('pickXAxisTickCount', () => {
    it.each([
        [320, 4],
        [449, 4],
        [450, 6],
        [599, 6],
        [600, 8],
        [900, 8],
    ])('width %p → %p ticks', (width, expected) => {
        expect(pickXAxisTickCount(width)).toBe(expected);
    });
});

describe('pickYAxisTickCount', () => {
    it.each([
        [200, 3],
        [349, 3],
        [350, 4],
        [480, 4],
    ])('height %p → %p ticks', (height, expected) => {
        expect(pickYAxisTickCount(height)).toBe(expected);
    });
});

describe('pickXAxisTickValues', () => {
    it('returns at most `maxTicks` dates from the dataset', () => {
        const ticks = pickXAxisTickValues(data, 3);
        expect(ticks.length).toBeLessThanOrEqual(3);
    });

    it('always returns the first + last dates when the dataset is sparse', () => {
        const two: Data<DemoValues> = [
            { date: new Date('2026-04-01'), values: { coverage: 1 } },
            { date: new Date('2026-04-05'), values: { coverage: 2 } },
        ];
        const ticks = pickXAxisTickValues(two, 4);
        expect(ticks.map((d) => d.getTime())).toEqual([
            two[0].date.getTime(),
            two[1].date.getTime(),
        ]);
    });

    it('handles the empty + single-datum cases without throwing', () => {
        expect(pickXAxisTickValues([], 4)).toEqual([]);
        const one: Data<DemoValues> = [
            { date: new Date('2026-04-01'), values: { coverage: 1 } },
        ];
        expect(pickXAxisTickValues(one, 4).length).toBe(1);
    });
});

describe('getFactors', () => {
    it('returns the whole factors of a positive integer', () => {
        expect(getFactors(12)).toEqual([1, 2, 3, 4, 6, 12]);
    });

    it('handles 1 and 0', () => {
        expect(getFactors(1)).toEqual([1]);
        expect(getFactors(0)).toEqual([]);
    });

    it('rejects negative and non-finite inputs', () => {
        expect(getFactors(-4)).toEqual([]);
        expect(getFactors(Number.NaN)).toEqual([]);
        expect(getFactors(Number.POSITIVE_INFINITY)).toEqual([]);
    });
});

describe('formatters', () => {
    it('formatShortDate renders canonical "DD Mon" (day-month, UTC)', () => {
        // Epic 58 — formatShortDate now delegates to
        // `formatDateCompact` from `@/lib/format-date`. That helper
        // is locked to en-GB + UTC, so the result is deterministic
        // regardless of host timezone: "16 Apr", not the previous
        // "Apr 16" in en-US + host-local TZ.
        expect(formatShortDate(new Date('2026-04-16T00:00:00Z'))).toBe('16 Apr');
        // Day-month order; short month name; no year.
        expect(formatShortDate(new Date('2026-12-01T12:00:00Z'))).toBe('1 Dec');
    });

    it('formatShortDate is timezone-stable for SSR parity', () => {
        // Two inputs at the same UTC instant render identically no
        // matter what TZ the host interprets them in. The inline
        // `toLocaleDateString('en-US', …)` this function used to
        // call was host-TZ-sensitive, which produced different
        // labels on server vs. client across a UTC-midnight boundary.
        // The PROPERTY this case is named for — a fixed, explicit zone rather
        // than the host's — still holds; the EXAMPLE had to change, because it
        // demonstrated the property using UTC-day truncation. 23:00Z is 02:00
        // the next day in Sofia, so those two instants legitimately differ now.
        //
        // Picked instead: two instants inside the same Sofia day that straddle
        // UTC midnight. Under a host-sensitive formatter these would disagree;
        // under an explicit zone they agree, which is the parity being claimed.
        const beforeUtcMidnight = new Date('2026-04-16T22:30:00Z'); // 01:30 Sofia, 17th
        const afterUtcMidnight = new Date('2026-04-17T00:30:00Z'); // 03:30 Sofia, 17th
        expect(formatShortDate(beforeUtcMidnight)).toBe('17 Apr');
        expect(formatShortDate(afterUtcMidnight)).toBe('17 Apr');
    });

    it('formatNumericTick renders `value.toString()`', () => {
        expect(formatNumericTick(42)).toBe('42');
        expect(formatNumericTick(3.14)).toBe('3.14');
    });
});

describe('constants', () => {
    it('axis label font size matches the UI caption scale', () => {
        expect(AXIS_LABEL_FONT_SIZE).toBe(12);
    });

    it('y-axis tick spacing leaves room for the tick label', () => {
        expect(DEFAULT_Y_AXIS_TICK_AXIS_SPACING).toBeGreaterThanOrEqual(4);
    });
});
