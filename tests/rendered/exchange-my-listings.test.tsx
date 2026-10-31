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
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
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
const apiPut = jest.fn().mockResolvedValue({});
const apiPost = jest.fn().mockResolvedValue({});
// All THREE verbs, because this is a whole-module double and the seller
// row now mounts the offer form, which imports `apiPut` (edit) and
// `apiPost` (create). A factory naming only `apiPatch` leaves the others
// `undefined` — the repo's partial-barrel-mock trap, and it fails at the
// call rather than at import, so it would surface as a confusing
// 'not a function' inside a submit handler.
jest.mock('@/lib/api-client', () => ({
    apiPatch: (...a: unknown[]) => apiPatch(...a),
    apiPut: (...a: unknown[]) => apiPut(...a),
    apiPost: (...a: unknown[]) => apiPost(...a),
}));

// Capture the error toasts — the whole point of the catch blocks is that a
// failure becomes visible rather than an unhandled rejection.
const toastError = jest.fn();
const toastSuccess = jest.fn();

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
            success: (...a: unknown[]) => toastSuccess(...a),
            info: jest.fn(), warning: jest.fn(), dismiss: jest.fn(),
        }),
    };
});

import { MyListingsClient } from '@/app/t/[tenantSlug]/(app)/exchange/my-listings/MyListingsClient';

const BUYER_CONTACT = 'buyer@farm.test';

function inquiry(over: Record<string, unknown> = {}) {
    return {
        id: 'inq-1', message: 'Interested in 50t', quantityTonnes: '50',
        status: 'PENDING', createdAt: '2026-07-20T09:30:00.000Z',
        counterpartyContact: null, contactSharedAt: null,
        ...over,
    };
}

/**
 * The seller's own editable values, as `/exchange/my-listings` sends them.
 *
 * It DISAGREES with the public row above on `sellerDisplayName`, and that is
 * the whole point: the public field is the RESOLVED attribution (null here,
 * because this fixture does not publish as the farm) while `edit` carries the
 * seller's TYPED alias. A form seeded from the row shows an empty name; one
 * seeded from `edit` shows the alias. Without the disagreement, "the form
 * filled in" passes whichever source it read — the defect being guarded
 * against is specifically that echoing a resolved farm name into a
 * full-replacement PUT writes it into the alias column as literal text.
 *
 * `commodity` is lowercase here and Title-Case on the row for the same reason
 * it is in production: `CommodityField` normalises to a canonical slug, and the
 * Combobox matches options by VALUE.
 */
function editOf(over: Record<string, unknown> = {}) {
    return {
        side: 'SELL', kind: 'CULTURE', commodity: 'wheat',
        quantityTonnes: '100', pricePerTonne: '320', priceCurrency: 'EUR',
        regionCode: 'BG-16', description: null,
        sellerDisplayName: 'Иван, лично',
        publishAsFarm: false,
        sellerContact: '+359 888 123456',
        expiresAt: null,
        updatedAt: '2026-10-31T12:00:00.000Z',
        ...over,
    };
}

function listing(over: Record<string, unknown> = {}) {
    return {
        id: 'lst-1', side: 'SELL', commodity: 'Wheat', quantityTonnes: '100',
        pricePerTonne: '320', priceCurrency: 'EUR', regionCode: 'BG-16', regionName: 'Plovdiv',
        lat: 42, lon: 24, description: null, sellerDisplayName: null, status: 'ACTIVE',
        createdAt: '', expiresAt: null, isOwn: true,
        inquiries: [inquiry()],
        edit: editOf(),
        ...over,
    };
}

function renderWith(props: { exchangeEnabled?: boolean } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <TooltipProvider>
                <main><MyListingsClient publicProfileEnabled {...props} /></main>
            </TooltipProvider>
        </QueryClientProvider>,
    );
}

function renderClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <TooltipProvider>
                <main><MyListingsClient publicProfileEnabled /></main>
            </TooltipProvider>
        </QueryClientProvider>,
    );
}

beforeEach(() => {
    mutate.mockClear();
    apiPatch.mockReset();
    apiPatch.mockResolvedValue({});
    toastError.mockClear();
    toastSuccess.mockClear();
    apiPut.mockReset();
    apiPut.mockResolvedValue({});
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
    // No accept/decline practices remain on an answered inquiry.
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

/**
 * Accept and Reject sit side by side and mean opposite things. They used to
 * share ONE busy id (`busy === iq.id`), so clicking either put a spinner on
 * both — the one pair of buttons on which "which one did I press?" actually
 * matters.
 */
it('spins only the button that was pressed', async () => {
    // Hold the request open so the in-flight state is observable.
    let release: (() => void) | undefined;
    apiPatch.mockImplementationOnce(
        () => new Promise<void>((resolve) => { release = () => resolve(); }),
    );

    renderClient();
    const accept = screen.getByRole('button', { name: /^Accept$/i });
    const reject = screen.getByRole('button', { name: /^Reject$/i });

    fireEvent.click(accept);

    // `loading` renders as `disabled` on the Button primitive.
    await waitFor(() => expect(accept).toBeDisabled());
    expect(reject).not.toBeDisabled();

    await act(async () => { release?.(); });
});

/**
 * This page is deliberately reachable with the EXCHANGE module OFF — it is
 * custody of rows the tenant already published, and the only place they can be
 * withdrawn. What it must not do is look like business as usual while every
 * offer on it is hidden from buyers.
 */
it('says so when the module is off, and drops Fulfil while keeping Withdraw', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={client}>
            <TooltipProvider>
                <main><MyListingsClient exchangeEnabled={false} publicProfileEnabled /></main>
            </TooltipProvider>
        </QueryClientProvider>,
    );

    expect(screen.getByText(/hidden from other farms/i)).toBeInTheDocument();
    // Withdraw is how you clean up — it stays.
    expect(screen.getByRole('button', { name: /withdraw/i })).toBeInTheDocument();
    // Fulfil claims a sale in a market this tenant has left — it does not.
    expect(screen.queryByRole('button', { name: /mark fulfilled/i })).not.toBeInTheDocument();
});

// ── the edit form — #2543 ──────────────────────────────────────────────────

it('the pencil seeds the form from `edit`, not from the public row', async () => {
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    const dialog = await screen.findByRole('dialog');

    // THE discriminating assertion: the row says null, `edit` says the alias.
    // A form reading the row would leave this blank and still "work".
    expect(dialog.querySelector<HTMLInputElement>('#exchange-seller-name')?.value)
        .toBe('Иван, лично');
    // The private field is on the seller's OWN read, so it prefills too —
    // without it, saving would silently clear the contact a seller set, since
    // this is a full replacement and an empty input means null.
    expect(dialog.querySelector<HTMLInputElement>('#exchange-seller-contact')?.value)
        .toBe('+359 888 123456');
    expect(dialog.querySelector<HTMLInputElement>('#exchange-qty')?.value).toBe('100');
    expect(dialog.querySelector<HTMLInputElement>('#exchange-price')?.value).toBe('320');
});

it('saving PUTs every field and echoes `updatedAt` verbatim', async () => {
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.change(dialog.querySelector('#exchange-qty')!, { target: { value: '80' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    const [url, body] = apiPut.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/t/acme/exchange/listings/lst-1');
    expect(body.quantityTonnes).toBe('80');
    // The PRECONDITION, round-tripped unchanged. A client that recomputed or
    // omitted it would turn the optimistic lock into a silent overwrite.
    expect(body.updatedAt).toBe('2026-10-31T12:00:00.000Z');
    // A full replacement: every editable field present, including the ones the
    // operator did not touch and the nullable ones. Under a patch, "leave the
    // description" and "clear the description" would be the same JSON.
    for (const k of [
        'side', 'kind', 'commodity', 'quantityTonnes', 'pricePerTonne', 'priceCurrency',
        'regionCode', 'description', 'sellerDisplayName', 'publishAsFarm',
        'sellerContact', 'expiresAt',
    ]) {
        expect(Object.keys(body)).toContain(k);
    }
    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalled();
});

it('an untouched expiry goes back as the STORED string, past date and all', async () => {
    // The reactivation case. The stored form here is deliberately NOT what
    // `toISOString()` produces, and that is what gives this test teeth: for a
    // canonical `…Z` string the round-trip is LOSSLESS, so
    // `expiresAt.toISOString()` would pass an assertion written against one
    // and the "send it verbatim" rule would be untested. An equal instant in
    // a different notation separates the two. `ExchangeListingEdit.expiresAt`
    // is typed `string` and nothing narrows it to a canonical form.
    //
    // The behaviour being protected: the server refuses a CHANGED past expiry
    // and accepts an unchanged one, so sending back the stored string is what
    // lets a seller edit a listing on its last day.
    const past = '2026-01-05T10:15:30.123+02:00';
    swrData = [listing({ status: 'EXPIRED', edit: editOf({ expiresAt: past }) })];
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(dialog.querySelector('#exchange-qty')!, { target: { value: '90' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    const [, body] = apiPut.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.expiresAt).toBe(past);
});

it('an EXPIRED listing offers edit and withdraw, but NOT mark fulfilled', () => {
    // EXPIRED is not TERMINAL — `[FULFILLED, WITHDRAWN]` is — and the usecase
    // allows EXPIRED → WITHDRAWN on purpose. This row used to offer nothing at
    // all, so a lapsed listing could not be tidied up from the only screen for
    // it. Fulfil stays absent because the server refuses FULFILLED from any
    // status but ACTIVE: offering it would be a button whose only outcome is a
    // refusal.
    swrData = [listing({ status: 'EXPIRED' })];
    renderClient();
    expect(screen.getByRole('button', { name: /^Edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Withdraw$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark fulfilled/i })).toBeNull();
});

it('a WITHDRAWN listing offers nothing — terminal is still terminal', () => {
    // The control for the widening above. Without it, "EXPIRED now has
    // buttons" is satisfied by a change that gave EVERY status buttons,
    // including the two the server refuses outright.
    swrData = [listing({ status: 'WITHDRAWN' })];
    renderClient();
    expect(screen.queryByRole('button', { name: /^Edit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Withdraw$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /mark fulfilled/i })).toBeNull();
});

it('no pencil with the module off, though withdraw survives', () => {
    // PUT asserts EXCHANGE; withdraw is exempt, because the toggle governs
    // participation in the marketplace rather than custody of rows already
    // posted. Absent rather than disabled — the page banner already says the
    // Exchange is off and that withdrawing is what remains.
    renderWith({ exchangeEnabled: false });
    expect(screen.queryByRole('button', { name: /^Edit$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^Withdraw$/i })).toBeInTheDocument();
});
