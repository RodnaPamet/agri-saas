/**
 * Rendered — MyInterestsClient (the buyer's workspace).
 *
 * The page's job is to let a buyer act: see the terms they enquired about,
 * get back to the offer, and — once the seller accepts — reach them. These
 * tests pin the two halves of that.
 *
 *   - Terms + navigation: price, seller, and a link back to the listing.
 *   - The reveal: `counterpartyContact` is rendered when (and only when)
 *     `contactSharedAt` is set. The gate itself is server-side
 *     (`toPublicInquiry`, unit-tested separately); what is pinned here is
 *     that the client cannot render a contact the server withheld — a
 *     PENDING/DECLINED row has nowhere to get one from.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/exchange/my-interests',
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
let swrError: unknown = undefined;
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: swrData, isLoading: false, error: swrError, mutate }),
    usePrefetchTenant: () => () => {},
}));

import { MyInterestsClient } from '@/app/t/[tenantSlug]/(app)/exchange/my-interests/MyInterestsClient';

const SELLER_CONTACT = '+359 88 111 1111';

function listing() {
    return {
        id: 'lst-1', side: 'SELL', kind: 'CULTURE', commodity: 'Wheat',
        quantityTonnes: '100', pricePerTonne: '320', priceCurrency: 'EUR',
        regionCode: 'BG-16', regionName: 'Plovdiv', lat: 42, lon: 24,
        description: null, sellerDisplayName: 'Acme Farm', status: 'ACTIVE',
        createdAt: '2026-07-01T00:00:00.000Z', expiresAt: null, isOwn: false,
    };
}

function inquiry(over: Record<string, unknown> = {}) {
    return {
        id: 'inq-1',
        message: 'Interested in 50t',
        quantityTonnes: '50',
        status: 'PENDING',
        createdAt: '2026-07-20T00:00:00.000Z',
        counterpartyContact: null,
        contactSharedAt: null,
        listing: listing(),
        ...over,
    };
}

function renderClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <TooltipProvider>
                <main><MyInterestsClient /></main>
            </TooltipProvider>
        </QueryClientProvider>,
    );
}

beforeEach(() => {
    mutate.mockClear();
    swrData = [inquiry()];
    swrError = undefined;
});

it('shows the commercial terms — price, seller — and a link back to the offer', () => {
    renderClient();

    expect(screen.getByText('Wheat')).toBeInTheDocument();
    // Quantity + price on one line; the price is the field whose absence sent
    // the buyer back to the browse page.
    // The price carries its OWN currency symbol. It used to be printed as the
    // raw stored code beside a map that stamped every offer "€/t" regardless.
    expect(screen.getByText(/100 t · 320 €\/t/)).toBeInTheDocument();
    expect(screen.getByText(/Seller: Acme Farm/)).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /view offer/i });
    // Deep-links into the browse page's Sheet for this exact listing.
    expect(link).toHaveAttribute('href', '/t/acme/exchange?listing=lst-1');
});

it('falls back to "Market / negotiable" and "Anonymous farm" when the seller published neither', () => {
    swrData = [inquiry({ listing: { ...listing(), pricePerTonne: null, sellerDisplayName: null } })];
    renderClient();
    expect(screen.getByText(/Market \/ negotiable/)).toBeInTheDocument();
    expect(screen.getByText(/Seller: Anonymous farm/)).toBeInTheDocument();
});

it('PENDING: no contact anywhere, and it says what the buyer is waiting for', () => {
    renderClient();
    expect(screen.getByText(/waiting for the seller to respond/i)).toBeInTheDocument();
    expect(screen.queryByText(/contact the seller/i)).not.toBeInTheDocument();
    expect(screen.queryByText(SELLER_CONTACT)).not.toBeInTheDocument();
});

it('DECLINED: says so plainly, and still reveals nothing', () => {
    swrData = [inquiry({ status: 'DECLINED' })];
    renderClient();
    expect(screen.getByText(/the seller declined/i)).toBeInTheDocument();
    expect(screen.queryByText(SELLER_CONTACT)).not.toBeInTheDocument();
});

it('ACCEPTED: surfaces the seller’s contact, copyable, with the date consent completed', () => {
    swrData = [inquiry({
        status: 'ACCEPTED',
        counterpartyContact: SELLER_CONTACT,
        contactSharedAt: '2026-07-21T09:30:00.000Z',
    })];
    renderClient();

    expect(screen.getByText(/accepted — contact the seller/i)).toBeInTheDocument();
    expect(screen.getByText(SELLER_CONTACT)).toBeInTheDocument();
    // Epic 56 copy primitive, not a raw clipboard call.
    expect(screen.getByRole('button', { name: /copy seller contact/i })).toBeInTheDocument();
    expect(screen.getByText(/Shared 21 Jul 2026/)).toBeInTheDocument();
});

it('ACCEPTED with no seller contact: explains the gap instead of rendering an empty box', () => {
    swrData = [inquiry({
        status: 'ACCEPTED',
        counterpartyContact: null,
        contactSharedAt: '2026-07-21T09:30:00.000Z',
    })];
    renderClient();
    expect(screen.getByText(/left no contact on this offer/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy seller contact/i })).not.toBeInTheDocument();
});

it('anchors each row on the listing id so the buyer notification deep-link lands', () => {
    const { container } = renderClient();
    expect(container.querySelector('#listing-lst-1')).not.toBeNull();
});

it('surfaces an ErrorState when the fetch fails', async () => {
    swrError = new Error('boom');
    renderClient();
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.queryByText('Wheat')).not.toBeInTheDocument();
});
