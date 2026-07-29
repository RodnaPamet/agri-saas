/**
 * Rendered — MyListingsClient (seller management view).
 *
 *   - Withdraw fires the Epic-67 undo toast + optimistically flips status;
 *     the deferred commit PATCHes { action: 'WITHDRAWN' }.
 *   - Mark fulfilled PATCHes { action: 'FULFILLED' }.
 *   - Accept / Reject an inquiry PATCH { action: 'ACCEPTED' | 'DECLINED' }.
 *   - A REJECTED request surfaces its message and does not wedge the confirm
 *     dialog open (the accept/reject/fulfil handlers used to have no catch).
 *   - An accepted inquiry shows the buyer's contact.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';

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

// Capture the error toasts — the whole point of the catch blocks is that a
// failure becomes visible rather than an unhandled rejection.
const toastError = jest.fn();

// Capture the undo-toast config so we can drive its deferred commit.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastToast: any = null;
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return {
        ...actual,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        useToastWithUndo: () => (cfg: any) => { lastToast = cfg; },
        useToast: () => ({
            error: (...a: unknown[]) => toastError(...a),
            success: jest.fn(), info: jest.fn(), warning: jest.fn(), dismiss: jest.fn(),
        }),
    };
});

import { MyListingsClient } from '@/app/t/[tenantSlug]/(app)/exchange/my-listings/MyListingsClient';

const BUYER_CONTACT = 'buyer@farm.test';

function inquiry(over: Record<string, unknown> = {}) {
    return {
        id: 'inq-1', message: 'Interested in 50t', quantityTonnes: '50',
        status: 'PENDING', createdAt: '',
        counterpartyContact: null, contactSharedAt: null,
        ...over,
    };
}

function listing(over: Record<string, unknown> = {}) {
    return {
        id: 'lst-1', side: 'SELL', commodity: 'Wheat', quantityTonnes: '100',
        pricePerTonne: '320', priceCurrency: 'BGN', regionCode: 'BG-16', regionName: 'Plovdiv',
        lat: 42, lon: 24, description: null, sellerDisplayName: null, status: 'ACTIVE',
        createdAt: '', expiresAt: null, isOwn: true,
        inquiries: [inquiry()],
        ...over,
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
    apiPatch.mockReset();
    apiPatch.mockResolvedValue({});
    toastError.mockClear();
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

// ── Failure surfacing ────────────────────────────────────────────────
//
// The three handlers used to be `try/finally` with no `catch`. A rejected
// PATCH became an unhandled rejection, the row looked untouched, and — when
// the action came from the confirm dialog — `Modal.Confirm` kept the dialog
// open on the throw, waiting for an error message no caller ever produced.

it('a failing Accept shows the server’s message instead of failing silently', async () => {
    apiPatch.mockRejectedValueOnce(new Error('This inquiry has already been answered'));
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /^Accept$/i }));
    await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith('This inquiry has already been answered'),
    );
});

it('a failing confirm action CLOSES the dialog and surfaces the error', async () => {
    apiPatch.mockRejectedValueOnce(
        new Error('"Wheat" has expired — withdraw it instead of marking it fulfilled'),
    );
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /mark fulfilled/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /mark fulfilled/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/has expired/)));
    // The dialog is gone: the handler resolved, so onConfirm's `setConfirm(null)`
    // ran. A re-thrown rejection would have left this dialog on screen forever.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('a failing withdraw commit rolls the optimistic flip back AND says so', async () => {
    apiPatch.mockRejectedValueOnce(new Error('listing_terminal'));
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /^Withdraw$/i }));

    await expect(lastToast.action()).rejects.toThrow(/listing_terminal/);
    // Drive the hook's own error routing the way the real hook would.
    lastToast.onError(new Error('listing_terminal'));
    expect(mutate).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'lst-1', status: 'ACTIVE' })]),
        { revalidate: false },
    );
    expect(toastError).toHaveBeenCalledWith('listing_terminal');
});

// ── The seller's half of the contact exchange ────────────────────────

it('a PENDING inquiry discloses that accepting shares contacts, and shows none yet', () => {
    renderClient();
    expect(screen.getByText(/accepting shares this listing's contact/i)).toBeInTheDocument();
    expect(screen.queryByText(BUYER_CONTACT)).not.toBeInTheDocument();
});

it('an ACCEPTED inquiry shows the buyer’s contact, copyable', () => {
    swrData = [listing({
        inquiries: [inquiry({
            status: 'ACCEPTED',
            counterpartyContact: BUYER_CONTACT,
            contactSharedAt: '2026-07-21T09:30:00.000Z',
        })],
    })];
    renderClient();
    expect(screen.getByText(/accepted — contact the buyer/i)).toBeInTheDocument();
    expect(screen.getByText(BUYER_CONTACT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy buyer contact/i })).toBeInTheDocument();
    // No accept/decline controls remain on an answered inquiry.
    expect(screen.queryByRole('button', { name: /^Accept$/i })).not.toBeInTheDocument();
});

it('a DECLINED inquiry reveals nothing', () => {
    swrData = [listing({ inquiries: [inquiry({ status: 'DECLINED' })] })];
    renderClient();
    expect(screen.queryByText(/contact the buyer/i)).not.toBeInTheDocument();
    expect(screen.queryByText(BUYER_CONTACT)).not.toBeInTheDocument();
});

it('the fulfil confirm tells the truth about what happens to waiting inquiries', async () => {
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /mark fulfilled/i }));
    const dialog = await screen.findByRole('dialog');
    // `fulfillListing` declines every still-PENDING inquiry and notifies those
    // buyers. The old copy claimed they "stay visible" and left them pending.
    // The copy renders twice (the visible <p> plus Radix's aria description).
    expect(within(dialog).getAllByText(/declines every inquiry still waiting/i).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(/those buyers are notified/i).length).toBeGreaterThan(0);
});
