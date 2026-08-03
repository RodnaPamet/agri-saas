/**
 * Rendered — CreateOfferModal.
 *
 *   - "Create offer" is disabled until commodity + region + quantity are set;
 *   - the region Combobox is populated from the Bulgarian oblast catalogue;
 *   - a free-text commodity (Combobox onCreate) is accepted;
 *   - a full submit POSTs /exchange/listings with the assembled body (region
 *     submitted as the CODE, not the label).
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const apiPost = jest.fn().mockResolvedValue({ id: 'lst-new' });
jest.mock('@/lib/api-client', () => ({ apiPost: (...a: unknown[]) => apiPost(...a) }));

import { CreateOfferModal } from '@/app/t/[tenantSlug]/(app)/exchange/CreateOfferModal';

function renderModal() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <TooltipProvider>
                <CreateOfferModal open setOpen={() => {}} onCreated={jest.fn()} />
            </TooltipProvider>
        </QueryClientProvider>,
    );
}

beforeEach(() => apiPost.mockClear());

it('disables "Create offer" until commodity + region + quantity are set', () => {
    renderModal();
    expect(screen.getByRole('button', { name: /create offer/i })).toBeDisabled();
});

it('populates the region Combobox from the Bulgarian oblast catalogue', async () => {
    renderModal();
    fireEvent.click(document.querySelector('#exchange-region')!);
    const options = await screen.findAllByRole('option');
    // 28 Bulgarian oblasti — a healthy list, not a stub.
    expect(options.length).toBeGreaterThan(20);
});

it('accepts a free-text commodity via the Combobox onCreate path', async () => {
    renderModal();
    fireEvent.click(document.querySelector('#exchange-commodity')!);
    const search = await screen.findByPlaceholderText(/search commodities/i);
    fireEvent.change(search, { target: { value: 'Triticale' } });
    fireEvent.click(await screen.findByText(/Use "Triticale"/i));
    expect(await screen.findByText('Triticale')).toBeInTheDocument();
});

it('enables + POSTs the assembled body (region as CODE) on a full submit', async () => {
    renderModal();

    // Commodity — seed option.
    fireEvent.click(document.querySelector('#exchange-commodity')!);
    fireEvent.click(await screen.findByRole('option', { name: 'Wheat' }));

    // Quantity.
    fireEvent.change(document.querySelector('#exchange-qty')!, { target: { value: '250' } });

    // Region — first oblast.
    fireEvent.click(document.querySelector('#exchange-region')!);
    const regionOptions = await screen.findAllByRole('option');
    fireEvent.click(regionOptions[0]);

    const submit = screen.getByRole('button', { name: /create offer/i });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const [url, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/t/acme/exchange/listings');
    // Localized label chosen → submits the stable KEY (+ English label as commodity).
    expect(body).toMatchObject({ commodity: 'Wheat', commodityKey: 'WHEAT', quantityTonnes: '250', priceCurrency: 'BGN' });
    expect(typeof body.regionCode).toBe('string');
    expect((body.regionCode as string).length).toBeGreaterThan(0);
    // The label is never submitted — only the stable code.
    expect(body.regionCode).not.toMatch(/\s/);
});
