/**
 * Epic 59 — sample data shapes for the chart type contracts.
 *
 * Consumers of the chart layer can copy these as starter shapes
 * when wiring a new chart surface. Exposed via a dedicated module
 * so tests can round-trip them without pulling in any runtime chart
 * code, and so the examples stay close to the types they exercise.
 *
 * No domain semantics live here — these are purely illustrative
 * values for the generic contracts.
 */

import type {
    CategoryPoint,
    KpiMetric,
    ProgressMetric,
    ProgressSegment,
    SparklineData,
    TimeSeriesDatum,
    TimeSeriesPoint,
} from './types';

// ─── Simple time-series ──────────────────────────────────────────────

export const exampleSparkline: SparklineData = [
    { date: new Date('2026-04-01T00:00:00Z'), value: 72 },
    { date: new Date('2026-04-02T00:00:00Z'), value: 74 },
    { date: new Date('2026-04-03T00:00:00Z'), value: 73 },
    { date: new Date('2026-04-04T00:00:00Z'), value: 77 },
    { date: new Date('2026-04-05T00:00:00Z'), value: 80 },
    { date: new Date('2026-04-06T00:00:00Z'), value: 82 },
    { date: new Date('2026-04-07T00:00:00Z'), value: 85 },
];

// ─── Multi-series time-series ────────────────────────────────────────
//
// `TimeSeriesDatum<T>` with an explicit `values` shape lets the
// TimeSeriesChart carry multiple metrics per day without losing type
// safety on the `series` accessors.

export interface ExampleMultiValues {
    coverage: number;
    open: number;
    overdue: number;
}

export const exampleMultiSeries: TimeSeriesDatum<ExampleMultiValues>[] = [
    {
        date: new Date('2026-04-01T00:00:00Z'),
        values: { coverage: 72, open: 14, overdue: 3 },
    },
    {
        date: new Date('2026-04-02T00:00:00Z'),
        values: { coverage: 74, open: 13, overdue: 3 },
    },
    {
        date: new Date('2026-04-03T00:00:00Z'),
        values: { coverage: 73, open: 15, overdue: 4 },
    },
];

// ─── Categorical ─────────────────────────────────────────────────────

export const exampleCategorical: CategoryPoint[] = [
    { label: 'CRITICAL', value: 2 },
    { label: 'HIGH', value: 7 },
    { label: 'MEDIUM', value: 18 },
    { label: 'LOW', value: 31 },
];

// ─── Progress metric + stacked segments ──────────────────────────────

export const exampleProgressMetric: ProgressMetric = {
    current: 72,
    target: 100,
    unit: '%',
    label: 'Practice coverage',
};

export const exampleProgressSegments: ProgressSegment[] = [
    {
        id: 'implemented',
        label: 'Implemented',
        value: 15,
        colorClassName: 'bg-brand-emphasis',
    },
    {
        id: 'in-progress',
        label: 'In progress',
        value: 3,
        colorClassName: 'bg-content-warning',
    },
    {
        id: 'not-started',
        label: 'Not started',
        value: 2,
        colorClassName: 'bg-bg-muted',
    },
];

// ─── KPI metric ──────────────────────────────────────────────────────

export const exampleKpiMetric: KpiMetric = {
    label: 'Practice coverage',
    value: 75.3,
    format: 'percent',
    delta: 2.4,
    deltaLabel: 'vs. last quarter',
    subtitle: '15 of 20 implemented',
};

// ─── Freshly constructed sparkline — for test convenience ─────────────

export function synthSparkline(n: number, base = 50, step = 2): TimeSeriesPoint[] {
    const out: TimeSeriesPoint[] = [];
    const start = Date.UTC(2026, 3, 1);
    for (let i = 0; i < n; i++) {
        out.push({
            date: new Date(start + i * 86_400_000),
            value: base + i * step,
        });
    }
    return out;
}
