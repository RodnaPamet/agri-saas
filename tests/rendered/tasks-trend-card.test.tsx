/** @jest-environment jsdom */
/**
 * TasksTrendCard — the dashboard "created vs completed" trendline card.
 * The visx chart is stubbed (jsdom has no layout, so the real chart renders
 * empty); these tests pin the three states — loading skeleton, empty state,
 * and the active legend with totals.
 */
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => ({
    // P2.1c — `useLocale` is part of this module and these mocks did not
    // provide it, so the first component to call it threw
    // "useLocale is not a function". The mock was incomplete relative to the
    // module, not wrong about this suite: `useDateFormat()` needs the active
    // locale, and a partial barrel mock turns a new dependency into a crash
    // across every suite that stubs it.
    useLocale: () => 'en',
    useTranslations: () => (key: string) => key,
}));

// Stub the chart primitives — visx needs real layout that jsdom lacks, and
// the card's own contract (title, legend, totals, empty/loading) is what
// matters here. The TimeSeriesChart stub is a jest.fn so a test can inspect
// the `series` prop it receives (see the isActive regression test).
const mockTimeSeriesChart = jest.fn(
    ({ children }: { children: React.ReactNode; series: unknown[] }) => (
        <div data-testid="ts-chart">{children}</div>
    ),
);
jest.mock('@/components/ui/charts', () => ({
    TimeSeriesChart: (props: { children: React.ReactNode; series: unknown[] }) =>
        mockTimeSeriesChart(props),
    Areas: () => <div data-testid="areas" />,
    XAxis: () => null,
    YAxis: () => null,
}));

const useTenantSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => useTenantSWR(...args),
}));

import TasksTrendCard from '@/app/t/[tenantSlug]/(app)/dashboard/TasksTrendCard';

describe('TasksTrendCard', () => {
    beforeEach(() => {
        useTenantSWR.mockReset();
        mockTimeSeriesChart.mockClear();
    });

    it('renders a skeleton while the read is in flight', () => {
        useTenantSWR.mockReturnValue({ data: undefined });
        render(<TasksTrendCard />);
        // Title always shows; the chart + legend do not until data arrives.
        expect(screen.getByText('title')).toBeInTheDocument();
        expect(screen.queryByText('created')).not.toBeInTheDocument();
        expect(screen.queryByTestId('ts-chart')).not.toBeInTheDocument();
    });

    it('shows the empty state when the window has no activity', () => {
        useTenantSWR.mockReturnValue({
            data: { trend: [
                { date: '2026-07-12', created: 0, completed: 0 },
                { date: '2026-07-13', created: 0, completed: 0 },
            ] },
        });
        render(<TasksTrendCard />);
        expect(screen.getByText('empty')).toBeInTheDocument();
        expect(screen.queryByTestId('ts-chart')).not.toBeInTheDocument();
    });

    it('renders the legend with created/completed totals and the chart', () => {
        useTenantSWR.mockReturnValue({
            data: { trend: [
                { date: '2026-07-12', created: 2, completed: 1 },
                { date: '2026-07-13', created: 3, completed: 4 },
            ] },
        });
        render(<TasksTrendCard />);
        expect(screen.getByText('created')).toBeInTheDocument();
        expect(screen.getByText('completed')).toBeInTheDocument();
        // Totals: created 2+3=5, completed 1+4=5.
        expect(screen.getAllByText('5')).toHaveLength(2);
        expect(screen.getByTestId('ts-chart')).toBeInTheDocument();
    });

    it('passes ACTIVE series to the chart so the areas actually render', () => {
        // Regression (dashboard "axes but no line" bug): <Areas> filters on
        // truthy `isActive`, so a series that omits it draws the axes/scale
        // but no area. Every series this card feeds the chart MUST be active.
        useTenantSWR.mockReturnValue({
            data: { trend: [{ date: '2026-07-13', created: 2, completed: 1 }] },
        });
        render(<TasksTrendCard />);
        const props = mockTimeSeriesChart.mock.calls.at(-1)?.[0] as {
            series: { id: string; isActive?: boolean }[];
        };
        expect(props.series.length).toBeGreaterThan(0);
        for (const s of props.series) {
            expect(s.isActive).toBe(true);
        }
    });
});
