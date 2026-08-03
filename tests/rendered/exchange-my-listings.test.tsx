/**
 * Rendered — MyListingsClient (seller management view).
 *
 *   - Withdraw fires the Epic-67 undo toast + optimistically flips status;
 *     the deferred commit PATCHes { action: 'WITHDRAWN' }.
 *   - Mark fulfilled PATCHes { action: 'FULFILLED' }.
 *   - Accept / Reject an inquiry PATCH { action: 'ACCEPTED' | 'DECLINED' }.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('next-intl', () => require('../helpers/next-intl-en-mock'));
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/exchange/my-listings',
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

const apiPatch = jest.fn().mockResolvedValue({});
jest.mock('@/lib/api-client', () => ({ apiPatch: (...a: unknown[]) => apiPatch(...a) }));

// Capture the undo-toast config so we can drive its deferred commit.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastToast: any = null;
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return {
        ...actual,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        useToastWithUndo: () => (cfg: any) => { lastToast = cfg; },
    };
});

import { MyListingsClient } from '@/app/t/[tenantSlug]/(app)/exchange/my-listings/MyListingsClient';

function listing() {
    return {
        id: 'lst-1', side: 'SELL', commodity: 'Wheat', quantityTonnes: '100',
        pricePerTonne: '320', priceCurrency: 'BGN', regionCode: 'BG-16', regionName: 'Plovdiv',
        lat: 42, lon: 24, description: null, sellerDisplayName: null, status: 'ACTIVE',
        createdAt: '', expiresAt: null, isOwn: true,
        inquiries: [
            { id: 'inq-1', message: 'Interested in 50t', quantityTonnes: '50', status: 'PENDING', createdAt: '' },
        ],
    };
}

function renderClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <TooltipProvider>
                <main><MyListingsClient /></main>
            </TooltipProvider>
        </QueryClientProvider>,
    );
}

beforeEach(() => {
    mutate.mockClear();
    apiPatch.mockClear();
    lastToast = null;
    swrData = [listing()];
    swrError = undefined;
});

it('Withdraw fires the undo toast + optimistically flips to WITHDRAWN, then PATCHes on commit', async () => {
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /^Withdraw$/i }));

    // Optimistic flip pushed to SWR cache without revalidation.
    expect(mutate).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'lst-1', status: 'WITHDRAWN' })]),
        { revalidate: false },
    );
    // Undo toast scheduled with the Epic-67 message.
    expect(lastToast).toBeTruthy();
    expect(lastToast.message).toMatch(/withdrawn/i);

    // Driving the deferred commit issues the PATCH.
    await lastToast.action();
    expect(apiPatch).toHaveBeenCalledWith('/api/t/acme/exchange/listings/lst-1', { action: 'WITHDRAWN' });
});

it('Mark fulfilled opens a confirm, then PATCHes { action: FULFILLED }', async () => {
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /mark fulfilled/i })); // opens confirm
    const dialog = await screen.findByRole('dialog');
    // No PATCH until the user confirms in the dialog.
    expect(apiPatch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /mark fulfilled/i }));
    await waitFor(() =>
        expect(apiPatch).toHaveBeenCalledWith('/api/t/acme/exchange/listings/lst-1', { action: 'FULFILLED' }),
    );
});

it('Accept PATCHes the inquiry directly { action: ACCEPTED }', async () => {
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /^Accept$/i }));
    await waitFor(() =>
        expect(apiPatch).toHaveBeenCalledWith('/api/t/acme/exchange/inquiries/inq-1', { action: 'ACCEPTED' }),
    );
});

it('Reject opens a "Reject" confirm, then PATCHes { action: DECLINED }', async () => {
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/i })); // opens confirm
    const dialog = await screen.findByRole('dialog');
    expect(apiPatch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Reject$/i }));
    await waitFor(() =>
        expect(apiPatch).toHaveBeenCalledWith('/api/t/acme/exchange/inquiries/inq-1', { action: 'DECLINED' }),
    );
});

it('surfaces an ErrorState when the fetch fails', async () => {
    swrError = new Error('boom');
    renderClient();
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    // The list rows are not rendered under an error.
    expect(screen.queryByText('Wheat')).not.toBeInTheDocument();
});
