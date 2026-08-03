/**
 * Rendered — Express-interest modal submits an inquiry.
 *
 * Mounts the InquiryModal open, types a message, clicks "Express interest",
 * and asserts a POST to /exchange/inquiries with the listing id + message.
 * The mailer/notification fanout is server-side (covered by the usecase unit
 * tests); here we only lock the client wiring.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('next-intl', () => require('../helpers/next-intl-en-mock'));
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/exchange',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
}));

import { InquiryModal } from '@/app/t/[tenantSlug]/(app)/exchange/InquiryModal';

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'inq-1', status: 'PENDING' }) });
    global.fetch = fetchMock as unknown as typeof fetch;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const listing: any = {
    id: 'lst-1', side: 'SELL', commodity: 'Wheat', quantityTonnes: '100',
    pricePerTonne: null, priceCurrency: 'BGN', regionCode: 'BG-16',
    regionName: 'Plovdiv', lat: 42, lon: 24, description: null,
    sellerDisplayName: null, status: 'ACTIVE', createdAt: '', expiresAt: null, isOwn: false,
};

function wrap(node: React.ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <TooltipProvider>{node}</TooltipProvider>
        </QueryClientProvider>,
    );
}

it('POSTs an inquiry with the typed message + closes', async () => {
    const onSent = jest.fn();
    wrap(<InquiryModal open setOpen={() => {}} listing={listing} onSent={onSent} />);

    const message = await screen.findByPlaceholderText(/introduce yourself/i);
    fireEvent.change(message, { target: { value: 'Interested in 50t' } });

    const submit = screen.getByRole('button', { name: /express interest/i });
    await act(async () => { fireEvent.click(submit); });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/t/acme/exchange/inquiries');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
        listingId: 'lst-1',
        message: 'Interested in 50t',
    });
    await waitFor(() => expect(onSent).toHaveBeenCalled());
});
