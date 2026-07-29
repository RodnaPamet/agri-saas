/**
 * Rendered — ExchangeClient deep link.
 *
 * When the URL carries `?listing=<id>` and that listing is NOT on the loaded
 * page, the client fetches it standalone (GET /exchange/listings/<id>) and
 * opens the detail Sheet — so a shared/emailed link resolves directly.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/exchange',
    // The deep-link param under test.
    useSearchParams: () => new URLSearchParams('listing=lst-deep'),
    useParams: () => ({ tenantSlug: 'acme' }),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
}));
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    // Empty feed — the deep-linked listing is NOT on the page, forcing the fetch.
    useTenantSWR: () => ({ data: { rows: [], nextCursor: null }, isLoading: false, mutate: jest.fn() }),
    usePrefetchTenant: () => () => {},
}));

const apiGet = jest.fn();
jest.mock('@/lib/api-client', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }));

jest.mock('@/components/exchange/ExchangeMap', () => ({
    __esModule: true,
    EXCHANGE_SIDE_COLORS: { SELL: '#0a0', BUY: '#00a' },
    ExchangeMap: () => <div data-testid="exchange-map" />,
}));

import { ExchangeClient } from '@/app/t/[tenantSlug]/(app)/exchange/ExchangeClient';

const DEEP = {
    id: 'lst-deep', side: 'SELL', commodity: 'DeepWheat', quantityTonnes: '100',
    pricePerTonne: null, priceCurrency: 'BGN', regionCode: 'BG-16', regionName: 'Plovdiv',
    lat: 42, lon: 24, description: null, sellerDisplayName: null, status: 'ACTIVE',
    createdAt: '', expiresAt: null, isOwn: false,
};

beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockResolvedValue(DEEP);
});

it('fetches the deep-linked listing and opens its detail Sheet', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={client}>
            <TooltipProvider><main><ExchangeClient /></main></TooltipProvider>
        </QueryClientProvider>,
    );

    // Fetched standalone from the single-listing GET…
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/t/acme/exchange/listings/lst-deep'));
    // …and the Sheet (with the offer detail + a cross-tenant inquiry CTA) opens.
    expect(await screen.findByRole('button', { name: /express interest/i })).toBeInTheDocument();
    expect(screen.getAllByText('DeepWheat').length).toBeGreaterThan(0);
});
