/**
 * Epic 59 — chart type-contract tests.
 *
 * These are the type-system invariants downstream chart surfaces
 * will rely on. Rather than test-render a chart, the file:
 *
 *   1. Exercises every shared shape with concrete sample data so a
 *      change that breaks a generic parameter surfaces here first.
 *   2. Round-trips sample data through JSON serialisation, since
 *      the chart layer ships contracts that cross the network (e.g.
 *      dashboard payloads built on the server, rendered on the
 *      client).
 *   3. Exercises the `ChartState<T>` discriminated union + its
 *      constructor + narrowing helpers — the state surface every
 *      data-fetching chart wrapper will consume.
 *
 * Runs under the node Jest project. No React, no jsdom — these are
 * pure contract checks.
 */

import {
    chartEmpty,
    chartError,
    chartLoading,
    chartReady,
    isChartReady,
} from '@/components/ui/charts/types';
import type {
    CategoryPoint,
    ChartDimensions,
    ChartMargin,
    ChartPadding,
    ChartState,
    Datum,
    KpiMetric,
    LabeledSeries,
    ProgressMetric,
    ProgressSegment,
    Series,
    SparklineData,
    TimeSeriesPoint,
    TooltipPayload,
} from '@/components/ui/charts/types';
import {
    exampleCategorical,
    exampleKpiMetric,
    exampleMultiSeries,
    exampleProgressMetric,
    exampleProgressSegments,
    exampleSparkline,
    synthSparkline,
    type ExampleMultiValues,
} from '@/components/ui/charts/examples';

// ─── Primitive point shapes ──────────────────────────────────────────

describe('TimeSeriesPoint / SparklineData', () => {
    it('accepts the stock sparkline example', () => {
        const data: SparklineData = exampleSparkline;
        expect(data.length).toBeGreaterThan(0);
        expect(data[0].date).toBeInstanceOf(Date);
        expect(typeof data[0].value).toBe('number');
    });

    it('synthesises a deterministic series via the helper', () => {
        const data = synthSparkline(7);
        expect(data).toHaveLength(7);
        expect(data[0].value).toBe(50);
        expect(data[6].value).toBe(62);
    });

    it('is generic over the value type', () => {
        // A value type other than number still satisfies the contract.
        const typed: TimeSeriesPoint<{ open: number; closed: number }> = {
            date: new Date(),
            value: { open: 3, closed: 1 },
        };
        expect(typed.value.open).toBe(3);
    });
});

describe('CategoryPoint', () => {
    it('accepts labelled categorical data', () => {
        const data: CategoryPoint[] = exampleCategorical;
        expect(data.map((d) => d.label)).toEqual([
            'CRITICAL',
            'HIGH',
            'MEDIUM',
            'LOW',
        ]);
        // sanity — categorical is not dated.
        expect('date' in (data[0] as unknown as Record<string, unknown>)).toBe(
            false,
        );
    });
});

// ─── Multi-series datum ──────────────────────────────────────────────

describe('TimeSeriesDatum + typed values', () => {
    it('retains per-field typing via the generic parameter', () => {
        const [first] = exampleMultiSeries;
        // `first.values.coverage` is known to be `number` at compile
        // time thanks to the `ExampleMultiValues` narrowing.
        expect(first.values.coverage).toBe(72);
        expect(first.values.open).toBe(14);
        expect(first.values.overdue).toBe(3);
    });

    it('composes with Series.valueAccessor without a cast', () => {
        const series: Series<ExampleMultiValues>[] = [
            {
                id: 'coverage',
                valueAccessor: (d) => d.values.coverage,
            },
            {
                id: 'open',
                valueAccessor: (d) => d.values.open,
            },
        ];
        // Exercise each accessor against the sample data.
        const coverageValues = exampleMultiSeries.map((d) =>
            series[0].valueAccessor(d),
        );
        expect(coverageValues).toEqual([72, 74, 73]);
    });

    it('extends to LabeledSeries for legend / tooltip rendering', () => {
        const s: LabeledSeries<ExampleMultiValues> = {
            id: 'coverage',
            label: 'Practice coverage',
            valueAccessor: (d) => d.values.coverage,
            colorClassName: 'text-brand-emphasis',
        };
        expect(s.label).toBe('Practice coverage');
    });
});

// ─── Chart dimensions ────────────────────────────────────────────────

describe('ChartDimensions + margin + padding', () => {
    it('accepts width + height without margin / padding', () => {
        const d: ChartDimensions = { width: 480, height: 240 };
        expect(d.width).toBe(480);
        expect(d.margin).toBeUndefined();
    });

    it('accepts margin + padding as named types', () => {
        const margin: ChartMargin = { top: 8, right: 8, bottom: 24, left: 32 };
        const padding: ChartPadding = { top: 0.1, bottom: 0.1 };
        const d: ChartDimensions = {
            width: 480,
            height: 240,
            margin,
            padding,
        };
        expect(d.margin?.left).toBe(32);
        expect(d.padding?.top).toBe(0.1);
    });
});

// ─── Tooltip payload ─────────────────────────────────────────────────

describe('TooltipPayload', () => {
    it('carries datum + date + index', () => {
        const payload: TooltipPayload<ExampleMultiValues> = {
            datum: exampleMultiSeries[1],
            date: exampleMultiSeries[1].date,
            index: 1,
        };
        expect(payload.datum.values.coverage).toBe(74);
        expect(payload.date).toBeInstanceOf(Date);
        expect(payload.index).toBe(1);
    });

    it('allows null date during hover-clear', () => {
        const payload: TooltipPayload = {
            datum: { date: new Date(), values: {} },
            date: null,
            index: 0,
        };
        expect(payload.date).toBeNull();
    });
});

// ─── Progress metrics ────────────────────────────────────────────────

describe('ProgressMetric + ProgressSegment', () => {
    it('renders the example stacked-segment shape cleanly', () => {
        const segments: ProgressSegment[] = exampleProgressSegments;
        const total = segments.reduce((sum, s) => sum + s.value, 0);
        expect(total).toBe(20);
        expect(segments.every((s) => s.colorClassName?.startsWith('bg-'))).toBe(
            true,
        );
    });

    it('the example metric carries label + unit + target', () => {
        const m: ProgressMetric = exampleProgressMetric;
        expect(m.current).toBe(72);
        expect(m.target).toBe(100);
        expect(m.unit).toBe('%');
    });

    it('accepts a metric without a target (consumer defaults to 100)', () => {
        const m: ProgressMetric = { current: 42 };
        expect(m.target).toBeUndefined();
    });
});

// ─── KPI metric ──────────────────────────────────────────────────────

describe('KpiMetric', () => {
    it('matches the top-level KpiCard shape the app already uses', () => {
        const m: KpiMetric = exampleKpiMetric;
        expect(m.label).toBe('Practice coverage');
        expect(m.format).toBe('percent');
        expect(m.delta).toBe(2.4);
    });

    it('tolerates nullish value for no-data rendering', () => {
        const m: KpiMetric = {
            label: 'Nothing yet',
            value: null,
            format: 'number',
        };
        expect(m.value).toBeNull();
    });
});

// ─── ChartState discriminated union ──────────────────────────────────

describe('ChartState + helpers', () => {
    it('constructs each branch via the helper API', () => {
        expect(chartLoading()).toEqual({ kind: 'loading' });
        expect(chartEmpty()).toEqual({ kind: 'empty' });
        expect(chartError('boom')).toEqual({ kind: 'error', message: 'boom' });
        expect(chartReady({ n: 1 })).toEqual({
            kind: 'ready',
            data: { n: 1 },
        });
    });

    it('isChartReady narrows the union', () => {
        const s: ChartState<number[]> = chartReady([1, 2, 3]);
        if (isChartReady(s)) {
            // `s.data` must be narrowed — index access without a cast.
            expect(s.data[1]).toBe(2);
        } else {
            throw new Error('expected ready branch');
        }
    });

    it('non-ready branches narrow away the data field', () => {
        const loading: ChartState<number[]> = chartLoading();
        expect(isChartReady(loading)).toBe(false);
        const empty: ChartState<number[]> = chartEmpty();
        expect(isChartReady(empty)).toBe(false);
        const err: ChartState<number[]> = chartError();
        expect(isChartReady(err)).toBe(false);
    });
});

// ─── Serialisation ───────────────────────────────────────────────────

describe('Chart contracts round-trip through JSON', () => {
    it('TimeSeriesPoint survives JSON with ISO-date coercion', () => {
        const roundTrip = JSON.parse(JSON.stringify(exampleSparkline)) as Array<{
            date: string;
            value: number;
        }>;
        expect(roundTrip).toHaveLength(exampleSparkline.length);
        // Dates come back as ISO strings — consumer's job to re-parse
        // with the canonical date-utils helpers. The contract itself
        // doesn't promise Date round-trip, only field-shape.
        expect(typeof roundTrip[0].date).toBe('string');
        expect(typeof roundTrip[0].value).toBe('number');
    });

    it('CategoryPoint is pure data and round-trips unchanged', () => {
        const roundTrip = JSON.parse(JSON.stringify(exampleCategorical));
        expect(roundTrip).toEqual(exampleCategorical);
    });

    it('ProgressSegment round-trips unchanged (no Date fields)', () => {
        const roundTrip = JSON.parse(JSON.stringify(exampleProgressSegments));
        expect(roundTrip).toEqual(exampleProgressSegments);
    });

    it('KpiMetric round-trips unchanged', () => {
        const roundTrip = JSON.parse(JSON.stringify(exampleKpiMetric));
        expect(roundTrip).toEqual(exampleKpiMetric);
    });
});

// ─── Contract purity — no domain leakage ─────────────────────────────

describe('Chart contracts carry zero domain semantics', () => {
    it('no type field in `types.ts` names a product entity', () => {
        // The audit's non-negotiable: chart contracts do not mention
        // evidence / risk / practice / policy / audit. A regression
        // that adds one would fail this grep — catch it at CI time.

        const fs = require('fs') as typeof import('fs');

        const path = require('path') as typeof import('path');
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../src/components/ui/charts/types.ts'),
            'utf-8',
        );
        // Strip comments so a harmless mention in JSDoc doesn't fail.
        const stripped = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        const forbidden = [
            /\bevidence[A-Z]/i,
            /\brisk[A-Z]/i,
            /\bpractice[A-Z]/i,
            /\bpolicy[A-Z]/i,
            /\baudit[A-Z]/i,
        ];
        for (const rx of forbidden) {
            expect(stripped).not.toMatch(rx);
        }
    });

    // Defines a structural type-only assertion via TypeScript's never
    // — used inside the test body so the check compiles.
    it('every Datum ends up being Record<string, any> compatible', () => {
        type _AssertDatumIsRecord = Datum extends Record<string, unknown>
            ? true
            : false;
        const check: _AssertDatumIsRecord = true;
        expect(check).toBe(true);
    });
});
