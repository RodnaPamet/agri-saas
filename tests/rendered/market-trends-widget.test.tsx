/** @jest-environment jsdom */
/**
 * Dashboard "Market trends" widget — a crop slideshow. Cycles wheat → maize →
 * barley → sunflower; auto-advances every 10s; manually slidable via prev/next
 * + dot indicators. The sparkline (visx) is stubbed; SWR is mocked so we can
 * assert which crop's series is being read as the slide changes.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

jest.mock('@/components/ui/mini-area-chart', () => ({
    MiniAreaChart: (props: { 'aria-label': string }) => (
        <div data-testid="sparkline" aria-label={props['aria-label']} />
    ),
}));

const useTenantSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => useTenantSWR(...args),
}));

import { MarketTrendsWidget } from '@/components/trends/MarketTrendsWidget';
import { TooltipProvider } from '@/components/ui/tooltip';

const DATA = {
    data: {
        commodity: 'wheat',
        range: '3m',
        // Server-side reference for staleness — the widget renders "as of" and
        // the stale warning against this, never against the browser clock.
        generatedAt: '2026-01-12T00:00:00.000Z',
        series: [
            {
                source: 'ec-agrifood',
                region: 'BG',
                stage: 'delivered',
                unit: 'EUR/t',
                currency: 'EUR',
                label: 'Crop',
                lastObservedAt: '2026-01-10',
                points: [
                    { date: '2026-01-01', price: 200 },
                    { date: '2026-01-10', price: 212 },
                ],
            },
        ],
    },
};

/**
 * The widget now renders provenance (source, stage, age) with InfoTooltip
 * disclosures, so its tree needs the TooltipProvider the app mounts once in
 * providers.tsx. Wrapping here rather than nesting a provider inside the
 * component keeps Radix's shared delay timer intact — the provider is
 * documented as mount-once-at-root.
 */
function renderWidget() {
    return render(
        <TooltipProvider>
            <MarketTrendsWidget />
        </TooltipProvider>,
    );
}

/** The SWR key the widget reads for a given crop. */
const keyFor = (c: string) => `/trends/prices?commodity=${c}&range=3m`;

beforeEach(() => useTenantSWR.mockReset());

describe('MarketTrendsWidget slideshow', () => {
    it('starts on wheat — headline price, sparkline, tap-through to /trends', () => {
        useTenantSWR.mockReturnValue(DATA);
        renderWidget();
        // Currency is part of the headline now — a bare number next to a
        // EUR/t unit line was the ambiguity this roadmap removes.
        expect(screen.getByText('212 EUR')).toBeInTheDocument();
        expect(screen.getByTestId('sparkline')).toBeInTheDocument();
        expect(screen.getByText('commodities.wheat')).toBeInTheDocument();
        expect(useTenantSWR).toHaveBeenCalledWith(keyFor('wheat'));
        expect(screen.getByRole('link')).toHaveAttribute('href', '/t/acme/trends');
    });

    it('renders one dot per crop, the first selected', () => {
        useTenantSWR.mockReturnValue(DATA);
        renderWidget();
        const dots = screen.getAllByRole('tab');
        expect(dots).toHaveLength(4);
        expect(dots[0]).toHaveAttribute('aria-selected', 'true');
        expect(dots[1]).toHaveAttribute('aria-selected', 'false');
    });

    it('Next advances to the following crop (reads its series)', () => {
        useTenantSWR.mockReturnValue(DATA);
        renderWidget();
        fireEvent.click(screen.getByRole('button', { name: 'widget.next' }));
        expect(screen.getByText('commodities.maize')).toBeInTheDocument();
        expect(useTenantSWR).toHaveBeenLastCalledWith(keyFor('maize'));
    });

    it('Prev from the first crop wraps to the last (sunflower)', () => {
        useTenantSWR.mockReturnValue(DATA);
        renderWidget();
        fireEvent.click(screen.getByRole('button', { name: 'widget.prev' }));
        expect(screen.getByText('commodities.sunflower')).toBeInTheDocument();
        expect(useTenantSWR).toHaveBeenLastCalledWith(keyFor('sunflower'));
    });

    it('a dot jumps directly to its crop', () => {
        useTenantSWR.mockReturnValue(DATA);
        renderWidget();
        fireEvent.click(screen.getAllByRole('tab')[2]); // barley
        expect(screen.getByText('commodities.barley')).toBeInTheDocument();
        expect(useTenantSWR).toHaveBeenLastCalledWith(keyFor('barley'));
    });

    it('auto-advances to the next crop after 10s', () => {
        jest.useFakeTimers();
        try {
            useTenantSWR.mockReturnValue(DATA);
            renderWidget();
            expect(screen.getByText('commodities.wheat')).toBeInTheDocument();
            act(() => {
                jest.advanceTimersByTime(10_000);
            });
            expect(screen.getByText('commodities.maize')).toBeInTheDocument();
        } finally {
            jest.useRealTimers();
        }
    });

    it('still renders a muted empty state (tap-through intact) with no data', () => {
        useTenantSWR.mockReturnValue({ data: { commodity: 'wheat', range: '3m', series: [] } });
        renderWidget();
        expect(screen.getByText('widget.empty')).toBeInTheDocument();
        expect(screen.getByRole('link')).toHaveAttribute('href', '/t/acme/trends');
    });
});
