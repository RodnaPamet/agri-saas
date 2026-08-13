/**
 * Asset KPI trendlines: the 4 asset KPI tiles render an inline sparkline.
 *
 * The series now comes from the daily compliance-snapshot table (one frozen
 * point per 24h) via getMetricTrends — see DashboardRepository.getAssetSummary
 * + the snapshot job. The KpiFilterCard sparkline wiring below is the
 * presentational contract (renders the chart when given ≥2 points), unchanged
 * by the data-source swap. The per-day series shape is covered server-side in
 * the metric-trends + snapshot unit tests.
 */
import { render } from '@testing-library/react';
import * as React from 'react';
import type { TimeSeriesPoint } from '@/components/ui/charts';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';

describe('KpiFilterCard sparkline', () => {
    const spark: TimeSeriesPoint[] = [
        { date: new Date('2026-01-01'), value: 1 },
        { date: new Date('2026-02-01'), value: 2 },
        { date: new Date('2026-03-01'), value: 3 },
    ];

    // MiniAreaChart's <ParentSize> renders its wrapper div (with the
    // passed className) but returns null inside at 0×0 (jsdom has no
    // layout), so we assert the wrapper, not the svg.
    // B2 (2026-06-07): the wrapper is to the RIGHT of the value (was
    // .mt-3.h-8.w-full stacked beneath it). B2-follow (#73 → #75,
    // 2026-06-07): it now spans the right TWO-THIRDS of the card (h-8 w-2/3).
    const sparkWrapper = (c: HTMLElement) =>
        c.querySelector('.h-8[class*="w-2/3"]');

    it('renders the sparkline wrapper when given ≥2 points', () => {
        const { container } = render(<KpiFilterCard label="Total assets" value={3} sparkline={spark} />);
        expect(sparkWrapper(container)).not.toBeNull();
    });

    it('lays the sparkline to the RIGHT of the value (B2 — flex row, not stacked below)', () => {
        const { container } = render(<KpiFilterCard label="Total assets" value={3} sparkline={spark} />);
        // value + sparkline share a horizontal flex row (items-end).
        expect(container.querySelector('.flex.items-end')).not.toBeNull();
        // the old below-the-value stacked wrapper is gone.
        expect(container.querySelector('.mt-3.h-8.w-full')).toBeNull();
    });

    it('renders no sparkline without data', () => {
        const { container } = render(<KpiFilterCard label="Total assets" value={3} />);
        expect(sparkWrapper(container)).toBeNull();
    });

    it('renders no sparkline with fewer than 2 points', () => {
        const { container } = render(
            <KpiFilterCard label="Total assets" value={1} sparkline={[{ date: new Date('2026-01-01'), value: 1 }]} />,
        );
        expect(sparkWrapper(container)).toBeNull();
    });
});
