/** @jest-environment jsdom */
/**
 * Trends → Prices tab. The visx charts are stubbed (jsdom has no layout); these
 * tests pin the three states (loading / empty+operator / ready), the source
 * legend labels, and the commodity-picker + range-selector refetch wiring.
 */
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

// Stub the chart primitives — the tab's own contract (states, legend, tiles,
// SWR key) is what matters, not the visx render.
jest.mock('@/components/ui/charts', () => ({
    TimeSeriesChart: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="ts-chart">{children}</div>
    ),
    Areas: () => <div data-testid="areas" />,
    XAxis: () => null,
    YAxis: () => null,
}));

// A minimal Combobox stub that exposes a button per option.
jest.mock('@/components/ui/combobox', () => ({
    Combobox: ({
        options,
        setSelected,
    }: {
        options: Array<{ value: string; label: React.ReactNode }>;
        setSelected: (o: { value: string; label: React.ReactNode }) => void;
    }) => (
        <div>
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    data-testid={`cmbx-${o.value}`}
                    onClick={() => setSelected(o)}
                >
                    {o.value}
                </button>
            ))}
        </div>
    ),
}));

const useTenantSWR = jest.fn();
// The operator-configuration hint names environment variables, so it is
// gated on an admin permission. Mocked per the house pattern (see
// market-trends-widget.test.tsx) — these tabs always render inside a
// TenantProvider in production, but they are mounted bare here.
let mockIsAdmin = true;
jest.mock('@/lib/tenant-context-provider', () => ({
    usePermissions: () => ({ admin: { manage: mockIsAdmin } }),
}));

jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => useTenantSWR(...args),
}));

import { PricesTab } from '@/components/trends/PricesTab';
import { TooltipProvider } from '@/components/ui/tooltip';

const READY = {
    commodity: 'wheat',
    range: '3m',
    // Server-side reference for staleness. Both fixture series report close to
    // it, so neither is flagged stale and the tiles read "as of".
    generatedAt: '2026-01-12T00:00:00.000Z',
    series: [
        {
            source: 'ec-agrifood',
            region: 'BG',
            stage: 'delivered',
            unit: 'EUR/t',
            currency: 'EUR',
            label: 'Wheat',
            lastObservedAt: '2026-01-10',
            points: [
                { date: '2026-01-01', price: 200 },
                { date: '2026-01-10', price: 212 },
            ],
        },
        {
            source: 'listings',
            region: 'BG',
            stage: null,
            unit: 'BGN/t',
            currency: 'BGN',
            label: 'Own-listings median',
            lastObservedAt: '2026-01-10',
            points: [{ date: '2026-01-10', price: 400, count: 9 }],
        },
    ],
};

/**
 * The tiles now carry provenance (source, stage, age) with InfoTooltip
 * disclosures, so the tree needs the TooltipProvider the app mounts once in
 * providers.tsx. Wrapped here rather than nested inside the component so
 * Radix's shared delay timer — documented as mount-once-at-root — stays
 * intact.
 */
function renderTab() {
    return render(
        <TooltipProvider>
            <PricesTab />
        </TooltipProvider>,
    );
}

describe('PricesTab', () => {
    beforeEach(() => useTenantSWR.mockReset());

    it('renders a loading skeleton while the read is in flight', () => {
        useTenantSWR.mockReturnValue({ data: undefined, error: undefined });
        renderTab();
        expect(screen.getByTestId('trends-loading')).toBeInTheDocument();
        expect(screen.queryByTestId('ts-chart')).not.toBeInTheDocument();
    });

    it('renders the empty state + operator-configuration explainer on no data', () => {
        useTenantSWR.mockReturnValue({
            data: { commodity: 'wheat', range: '3m', series: [] },
            error: undefined,
        });
        renderTab();
        expect(screen.getByTestId('trends-empty')).toBeInTheDocument();
        expect(screen.getByTestId('trends-operator-hint')).toBeInTheDocument();
        expect(screen.queryByTestId('ts-chart')).not.toBeInTheDocument();
    });

    it('renders ONE chart — the official quote, not the noticeboard', () => {
        useTenantSWR.mockReturnValue({ data: READY, error: undefined });
        renderTab();
        // The fixture holds two BG groups (EC EUR/t + own-listings BGN/t).
        // Exactly one is drawn, and it is the official one — leading with the
        // median of our own users' asking prices would be the expensive error.
        expect(screen.getAllByTestId('ts-chart')).toHaveLength(1);
        expect(screen.getAllByText('sources.official').length).toBeGreaterThan(0);
        expect(screen.queryByText('sources.listings')).not.toBeInTheDocument();
        // The listings TILE stays — it is a number, not a fourth chart.
        expect(screen.getByText('tiles.listings')).toBeInTheDocument();
    });

    it('refetches when the range selector changes', () => {
        useTenantSWR.mockReturnValue({ data: READY, error: undefined });
        const { container } = renderTab();
        expect(useTenantSWR).toHaveBeenCalledWith(
            '/trends/prices?commodity=wheat&range=3m',
        );
        const oneYear = container.querySelector('#trends-range-1y') as HTMLElement;
        fireEvent.click(oneYear);
        expect(useTenantSWR).toHaveBeenCalledWith(
            '/trends/prices?commodity=wheat&range=1y',
        );
    });

    it('refetches when the commodity picker changes', () => {
        useTenantSWR.mockReturnValue({ data: READY, error: undefined });
        renderTab();
        fireEvent.click(screen.getByTestId('cmbx-maize'));
        expect(useTenantSWR).toHaveBeenCalledWith(
            '/trends/prices?commodity=maize&range=3m',
        );
    });
});

/**
 * The four-card complaint, written down.
 *
 * `market-prices-pull` fetches EC prices for BG, RO, EL and EU, and since
 * Bulgaria's euro adoption all four are EUR/t — so region was the only thing
 * separating four cards with the same title, same source label and same unit.
 */
describe('PricesTab — one chart, whichever regions the feed carries', () => {
    function ec(region: string, price: number) {
        return {
            source: 'ec-agrifood',
            region,
            stage: 'FGATE',
            unit: 'EUR/t',
            currency: 'EUR',
            label: 'Wheat',
            lastObservedAt: '2026-01-10',
            points: [
                { date: '2026-01-01', price: price - 8 },
                { date: '2026-01-10', price },
            ],
        };
    }
    const payload = (series: unknown[]) => ({
        commodity: 'wheat',
        range: '3m',
        generatedAt: '2026-01-12T00:00:00.000Z',
        series,
    });

    it('draws Bulgaria, not four member states', () => {
        useTenantSWR.mockReturnValue({
            data: payload([ec('EU', 205), ec('RO', 190), ec('BG', 212), ec('EL', 400)]),
            error: undefined,
        });
        renderTab();
        expect(screen.getAllByTestId('ts-chart')).toHaveLength(1);
        expect(screen.getByText('BG')).toBeInTheDocument();
        expect(screen.queryByText('RO')).not.toBeInTheDocument();
        expect(screen.queryByText('EL')).not.toBeInTheDocument();
    });

    it('falls back to the EU average when Bulgaria has not reported', () => {
        useTenantSWR.mockReturnValue({
            data: payload([ec('RO', 190), ec('EU', 205), ec('EL', 400)]),
            error: undefined,
        });
        renderTab();
        expect(screen.getAllByTestId('ts-chart')).toHaveLength(1);
        expect(screen.getByText('EU')).toBeInTheDocument();
    });

    it('quotes the series it drew, so the tile cannot contradict the chart', () => {
        // The tile used to read findEcSeries(series, 'BG') with the region
        // hard-coded: on an EU fallback it printed the no-data dash directly
        // above a populated line.
        useTenantSWR.mockReturnValue({
            data: payload([ec('EU', 205)]),
            error: undefined,
        });
        renderTab();
        expect(screen.getByText('205 EUR')).toBeInTheDocument();
        expect(screen.getByText('tiles.latestPrice')).toBeInTheDocument();
    });
});

describe('PricesTab — an error is not an empty market', () => {
    afterEach(() => { mockIsAdmin = true; });

    it('shows an ERROR state, never "no data for this period"', () => {
        // These were collapsed (`error != null || isEmptyPayload(data)`), so a
        // 500, a 429 from the read limiter, and a dropped rural connection all
        // told the farmer the market had no prices — and then lectured them
        // about environment variables.
        useTenantSWR.mockReturnValue({ data: undefined, error: new Error('boom') });
        renderTab();

        expect(screen.getByTestId('trends-error')).toBeInTheDocument();
        expect(screen.queryByTestId('trends-empty')).not.toBeInTheDocument();
        expect(screen.queryByTestId('trends-operator-hint')).not.toBeInTheDocument();
    });

    it('hides the env-var hint from non-admins on a genuinely empty payload', () => {
        // EC_AGRIFOOD_BASE_URL is an instruction a farmer cannot act on, and
        // it leaks a little of our deployment shape to every user.
        mockIsAdmin = false;
        useTenantSWR.mockReturnValue({
            data: { commodity: 'wheat', range: '3m', generatedAt: '2026-01-12T00:00:00.000Z', series: [] },
            error: undefined,
        });
        renderTab();

        expect(screen.getByTestId('trends-empty')).toBeInTheDocument();
        expect(screen.queryByTestId('trends-operator-hint')).not.toBeInTheDocument();
    });
});
