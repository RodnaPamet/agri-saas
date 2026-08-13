/** @jest-environment jsdom */
/**
 * Trends → Prices: category picker, and the inputs a farm BUYS.
 *
 * ── Which viewport ───────────────────────────────────────────────────
 *
 * The jsdom default (a PHONE) is used deliberately and left unchanged:
 * nothing asserted here branches on a media query — the category selector,
 * the commodity options, the empty state and the provenance line all render
 * identically at every width. Stated rather than assumed, so the next reader
 * does not have to work it out.
 *
 * ── Why a separate file from trends-prices-tab.test.tsx ──────────────
 *
 * That suite shares ONE `useTenantSWR` mock across both reads (interests and
 * prices), so every read gets the same fixture. These cases need the prices
 * read to answer differently per commodity, so the mock here routes on the
 * SWR key.
 *
 * Each `it()` names the production break it catches.
 */
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

jest.mock('@/components/ui/charts', () => ({
    TimeSeriesChart: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="ts-chart">{children}</div>
    ),
    Areas: () => <div data-testid="areas" />,
    XAxis: () => null,
    YAxis: () => null,
}));

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

jest.mock('@/lib/tenant-context-provider', () => ({
    usePermissions: () => ({ admin: { manage: false } }),
}));

/** Prices payloads by commodity slug; anything absent reads as "no series". */
const PAYLOADS: Record<string, unknown> = {};
const swrKeys: string[] = [];

jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string) => {
        swrKeys.push(key);
        if (key.startsWith('/me/interests')) return { data: { keywords: [] }, error: undefined };
        const commodity = /commodity=([^&]+)/.exec(key)?.[1] ?? '';
        return {
            data: PAYLOADS[commodity] ?? { commodity, range: '3m', generatedAt: NOW, series: [] },
            error: undefined,
        };
    },
}));

import { PricesTab } from '@/components/trends/PricesTab';
import { TooltipProvider } from '@/components/ui/tooltip';

const NOW = '2026-08-12T00:00:00.000Z';

function seriesPayload(commodity: string, series: unknown[]) {
    return { commodity, range: '3m', generatedAt: NOW, series };
}

const DIESEL = seriesPayload('diesel', [
    {
        source: 'oil-bulletin',
        region: 'BG',
        stage: 'with-tax',
        unit: 'EUR/1000l',
        currency: 'EUR',
        label: 'Automotive gas oil (with duties and taxes)',
        lastObservedAt: '2026-08-03',
        points: [
            { date: '2026-07-27', price: 1679 },
            { date: '2026-08-03', price: 1742.6 },
        ],
    },
]);

/** MAP has no feed anywhere, so its series is somebody's typing. */
const MAP_MANUAL = seriesPayload('map', [
    {
        source: 'manual',
        region: 'BG',
        stage: null,
        unit: 'BGN/t',
        currency: 'BGN',
        label: 'МАП',
        lastObservedAt: '2026-07-01',
        points: [{ date: '2026-07-01', price: 1420.5 }],
    },
]);

function renderTab() {
    return render(
        <TooltipProvider>
            <PricesTab />
        </TooltipProvider>,
    );
}

beforeEach(() => {
    swrKeys.length = 0;
    for (const k of Object.keys(PAYLOADS)) delete PAYLOADS[k];
});

describe('the category picker', () => {
    // Break: a picker hardcoded in the component, so adding a commodity means
    // editing a React file — and fuel/fertiliser never appearing at all.
    it('opens on grain and offers only crops', () => {
        renderTab();
        expect(screen.getByTestId('cmbx-wheat')).toBeInTheDocument();
        expect(screen.queryByTestId('cmbx-diesel')).not.toBeInTheDocument();
        expect(screen.queryByTestId('cmbx-urea')).not.toBeInTheDocument();
    });

    it('swaps the commodity options when the category changes', () => {
        renderTab();
        fireEvent.click(document.getElementById('trends-category-fuel')!);
        expect(screen.getByTestId('cmbx-diesel')).toBeInTheDocument();
        expect(screen.queryByTestId('cmbx-wheat')).not.toBeInTheDocument();

        fireEvent.click(document.getElementById('trends-category-fertilizer')!);
        expect(screen.getByTestId('cmbx-urea')).toBeInTheDocument();
        expect(screen.getByTestId('cmbx-map')).toBeInTheDocument();
        expect(screen.queryByTestId('cmbx-diesel')).not.toBeInTheDocument();
    });

    // Break: offering a picker entry the read path 400s on. The vocabulary is
    // a superset of what is quotable — rapeseed, oats, rye, soybean, peas and
    // lentils are nameable on the exchange but have no price series.
    it('offers only commodities the read path can actually serve', () => {
        renderTab();
        for (const unquotable of ['rapeseed', 'oats', 'rye', 'soybean', 'peas', 'lentils']) {
            expect(screen.queryByTestId(`cmbx-${unquotable}`)).not.toBeInTheDocument();
        }
    });

    // Break: changing category yanking a still-valid selection out from under
    // the user — the same promise the commodity picker already made.
    it('moves the selection only when the current one leaves the category', () => {
        renderTab();
        fireEvent.click(screen.getByTestId('cmbx-barley'));
        // Still in grain: barley survives a no-op category click.
        fireEvent.click(document.getElementById('trends-category-grain')!);
        expect(swrKeys.some((k) => k.includes('commodity=barley'))).toBe(true);

        // Fuel has no barley, so the picker moves — to fuel's first entry,
        // not to nothing.
        fireEvent.click(document.getElementById('trends-category-fuel')!);
        expect(swrKeys.some((k) => k.includes('commodity=diesel'))).toBe(true);
    });
});

describe('inputs the farm buys', () => {
    it('fetches and charts a diesel series', () => {
        PAYLOADS.diesel = DIESEL;
        renderTab();
        fireEvent.click(document.getElementById('trends-category-fuel')!);
        expect(swrKeys.some((k) => k.includes('commodity=diesel'))).toBe(true);
        expect(screen.getAllByTestId('ts-chart').length).toBeGreaterThan(0);
    });

    // Break: THE one P5.4 exists for. A hand-typed fertiliser price rendering
    // indistinguishably from a live quote. Before this, 'manual' fell through
    // to the 'other' label key and read as "Other source".
    it('names a hand-entered series as such', () => {
        PAYLOADS.map = MAP_MANUAL;
        renderTab();
        fireEvent.click(document.getElementById('trends-category-fertilizer')!);
        fireEvent.click(screen.getByTestId('cmbx-map'));
        expect(screen.getAllByText('sources.manual').length).toBeGreaterThan(0);
        // And never as the anonymous fallback.
        expect(screen.queryByText('sources.other')).not.toBeInTheDocument();
    });

    // Break: three "no data" tiles sitting above a perfectly good chart,
    // because the crop tiles look up EC / listings / Alpha Vantage by name and
    // none of them publish diesel.
    it('shows one honest tile for an input rather than three empty crop tiles', () => {
        PAYLOADS.diesel = DIESEL;
        renderTab();
        fireEvent.click(document.getElementById('trends-category-fuel')!);
        expect(screen.queryByText('tiles.listings')).not.toBeInTheDocument();
        expect(screen.queryByText('tiles.reference')).not.toBeInTheDocument();
        expect(screen.getByText('tiles.latestPrice')).toBeInTheDocument();
    });

    // Break: a blank chart behind a dropdown entry, which reads as a broken
    // page rather than as "nobody publishes this yet".
    it('explains an unpublished commodity instead of drawing nothing', () => {
        renderTab();
        fireEvent.click(document.getElementById('trends-category-fertilizer')!);
        fireEvent.click(screen.getByTestId('cmbx-ammonium-nitrate'));
        expect(screen.getByTestId('trends-empty')).toBeInTheDocument();
        expect(screen.getByText('noSeries.title')).toBeInTheDocument();
        expect(screen.queryByTestId('ts-chart')).not.toBeInTheDocument();
    });

    // Break: telling a farmer to set EC_AGRIFOOD_BASE_URL when the real
    // answer is "no source on earth publishes MAP". The operator hint is
    // admin-only anyway, but the input empty state is a different fact.
    it('does not blame configuration for a commodity nobody publishes', () => {
        renderTab();
        fireEvent.click(document.getElementById('trends-category-fertilizer')!);
        fireEvent.click(screen.getByTestId('cmbx-map'));
        expect(screen.queryByText('empty.title')).not.toBeInTheDocument();
        expect(screen.getByText('noSeries.title')).toBeInTheDocument();
    });
});
