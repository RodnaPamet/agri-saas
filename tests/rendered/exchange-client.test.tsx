/**
 * Rendered — ExchangeClient (browse split-view) behaviour.
 *
 *   - detail Sheet opens on a list-row select (+ anonymity fallback);
 *   - "Express interest" is hidden on your OWN offer, shown on others';
 *   - hovering a row highlights that offer's map marker;
 *   - a map region click filters the list to that oblast.
 *
 * The map (maplibre/WebGL) is stubbed to an accessible shell that records its
 * props and exposes marker/region click hooks — jsdom can't paint GL.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/exchange',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
}));

const mutate = jest.fn(async () => undefined);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let swrData: any[] = [];
/** Every path the client asked the feed for, in order. */
const swrKeys: string[] = [];

/**
 * Stand-in for the real endpoint. Filtering moved SERVER-side in the
 * one-currency-one-market PR — the filter state is now part of the SWR key
 * rather than a predicate the client runs over a fetched array — so the mock
 * has to answer the query it was asked, not hand back a fixed list.
 */
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (path: string) => {
        swrKeys.push(path);
        const qs = new URLSearchParams(path.split('?')[1] ?? '');
        const regions = (qs.get('region') ?? '').split(',').filter(Boolean);
        const rows = regions.length
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ? swrData.filter((o: any) => regions.includes(o.regionCode))
            : swrData;
        return { data: { rows, nextCursor: null }, isLoading: false, mutate };
    },
    usePrefetchTenant: () => () => {},
}));

// Map stub — records props (highlightedId) + exposes marker/region hooks.
jest.mock('@/components/exchange/ExchangeMap', () => ({
    __esModule: true,
    EXCHANGE_SIDE_COLORS: { SELL: '#0a0', BUY: '#00a' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ExchangeMap: (props: any) => (
        <div data-testid="exchange-map" data-highlighted={props.highlightedId ?? ''}>
            {props.listings.map((l: { id: string }) => (
                <button key={l.id} type="button" onClick={() => props.onListingSelect(l.id)}>
                    marker-{l.id}
                </button>
            ))}
            <button type="button" onClick={() => props.onRegionClick('BG-16')}>region-BG-16</button>
        </div>
    ),
}));

import { ExchangeClient } from '@/app/t/[tenantSlug]/(app)/exchange/ExchangeClient';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function offer(over: Record<string, any> = {}) {
    return {
        id: 'o1', side: 'SELL', commodity: 'Wheat', quantityTonnes: '100',
        pricePerTonne: '320', priceCurrency: 'EUR', regionCode: 'BG-16',
        regionName: 'Plovdiv', lat: 42, lon: 24, description: null,
        sellerDisplayName: null, status: 'ACTIVE', createdAt: '', expiresAt: null,
        isOwn: false, ...over,
    };
}

const OFFERS = [
    offer({ id: 'o1', commodity: 'Wheat', regionCode: 'BG-16', regionName: 'Plovdiv', isOwn: false, sellerDisplayName: null }),
    offer({ id: 'o2', commodity: 'Maize', side: 'BUY', regionCode: 'BG-09', regionName: 'Kardzhali', isOwn: false, sellerDisplayName: 'Acme Farm' }),
    offer({ id: 'o3', commodity: 'Barley', regionCode: 'BG-16', regionName: 'Plovdiv', isOwn: true, sellerDisplayName: null }),
];

function renderClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <TooltipProvider>
                <main><ExchangeClient /></main>
            </TooltipProvider>
        </QueryClientProvider>,
    );
}

beforeEach(() => {
    mutate.mockClear();
    swrKeys.length = 0;
    swrData = OFFERS.map((o) => ({ ...o }));
});

it('opens the detail Sheet on row select and shows the Anonymous-farm fallback', async () => {
    renderClient();
    await screen.findByTestId('exchange-map');
    fireEvent.click(screen.getByRole('button', { name: /Wheat/i }));
    // Sheet body fields + the null-sellerDisplayName fallback.
    await waitFor(() => expect(screen.getByText('Quantity')).toBeInTheDocument());
    expect(screen.getByText('Anonymous farm')).toBeInTheDocument();
});

it('hides "Express interest" on your OWN offer', async () => {
    renderClient();
    await screen.findByTestId('exchange-map');
    fireEvent.click(screen.getByRole('button', { name: /Barley/i })); // o3, isOwn
    await waitFor(() => expect(screen.getByText('Quantity')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /express interest/i })).not.toBeInTheDocument();
});

it('shows "Express interest" on another tenant\'s offer', async () => {
    renderClient();
    await screen.findByTestId('exchange-map');
    fireEvent.click(screen.getByRole('button', { name: /Wheat/i })); // o1, not own
    expect(await screen.findByRole('button', { name: /express interest/i })).toBeInTheDocument();
});

it('highlights the map marker for the hovered row', async () => {
    renderClient();
    await screen.findByTestId('exchange-map');
    fireEvent.mouseEnter(screen.getByRole('button', { name: /Wheat/i }));
    await waitFor(() =>
        expect(screen.getByTestId('exchange-map')).toHaveAttribute('data-highlighted', 'o1'),
    );
});

it('filters the list to the oblast when a map region is clicked', async () => {
    renderClient();
    await screen.findByTestId('exchange-map');
    expect(screen.getByRole('button', { name: /Maize/i })).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'region-BG-16' })); });
    // BG-16 selected → Maize (BG-09) drops out; Wheat/Barley (BG-16) remain.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Maize/i })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Wheat/i })).toBeInTheDocument();
});

it('asks the SERVER for the filtered set rather than trimming a fetched page', async () => {
    renderClient();
    await screen.findByTestId('exchange-map');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'region-BG-16' })); });

    // The point of the change: filters used to run client-side over whatever
    // the feed returned, which was the newest 100 offers NATIONWIDE — so a
    // region filter searched a sample and reported it as the market.
    await waitFor(() => expect(swrKeys.some((k) => k.includes('region=BG-16'))).toBe(true));
    // …and the request is bounded, so the answer is a page, not the table.
    expect(swrKeys[swrKeys.length - 1]).toContain('limit=');
});

it('averages prices in ONE currency and discloses the ones it left out', async () => {
    // A legacy USD row beside two euro rows. Averaging all three would produce
    // a number that is not a price in any currency, which is what the ticker
    // used to print — labelled with whichever currency happened to be first.
    swrData = [
        offer({ id: 'e1', commodity: 'Wheat', pricePerTonne: '200', priceCurrency: 'EUR' }),
        offer({ id: 'e2', commodity: 'Wheat', pricePerTonne: '300', priceCurrency: 'EUR' }),
        offer({ id: 'u1', commodity: 'Maize', pricePerTonne: '900', priceCurrency: 'USD' }),
    ];
    renderClient();
    await screen.findByTestId('exchange-map');

    // (200 + 300) / 2 = 250 EUR — the USD row is not in the mean.
    expect(screen.getByText(/avg 250 EUR/)).toBeInTheDocument();
    // And the exclusion is stated rather than silent.
    expect(screen.getByText(/1 priced in another currency, not averaged/)).toBeInTheDocument();
    // The USD offer still shows its OWN price on its own card.
    expect(screen.getByText(/900 \$\/t/)).toBeInTheDocument();
});
