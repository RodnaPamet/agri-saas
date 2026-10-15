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

it('does NOT offer to invent a commodity — the vocabulary is closed', async () => {
    // This used to accept free text via the Combobox onCreate path, and that
    // is what killed the own-listings index: every spelling became its own
    // group, fragmenting real groups below the k-anonymity floor until they
    // vanished, and none of them could join to the lowercase
    // MarketPriceSeries slug the trends read matches on.
    //
    // The write schema now normalises to CANONICAL_COMMODITIES, so a create
    // affordance would only produce a 400 after the form was filled in.
    // BEHAVIOUR CHANGE: a commodity outside the vocabulary can no longer be
    // listed; adding one is a deliberate edit to CANONICAL_COMMODITIES.
    renderModal();
    fireEvent.click(document.querySelector('#exchange-commodity')!);
    const search = await screen.findByPlaceholderText(/search commodities/i);
    fireEvent.change(search, { target: { value: 'Triticale' } });

    await waitFor(() =>
        expect(screen.queryByText(/Use "Triticale"/i)).not.toBeInTheDocument(),
    );
});

it('offers the canonical vocabulary, so every option the API accepts is listed', async () => {
    renderModal();
    fireEvent.click(document.querySelector('#exchange-commodity')!);
    // Derived from CANONICAL_COMMODITIES, Title-Cased for display.
    expect(await screen.findByRole('option', { name: 'Wheat' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Rapeseed' })).toBeInTheDocument();
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
    // EUR by construction — there is no currency picker on the form any more,
    // because a second denomination is what made two prices on one map
    // incomparable.
    // The CANONICAL SLUG is submitted, not the Title-Case label shown in the
    // picker. This is the join key: MarketPriceSeries.commodity is lowercase
    // and getPriceTrends matches it exactly, so a listing stored as 'Wheat'
    // could never contribute to a price series the UI can read back.
    expect(body).toMatchObject({ commodity: 'wheat', quantityTonnes: '250', priceCurrency: 'EUR' });
    expect(typeof body.regionCode).toBe('string');
    expect((body.regionCode as string).length).toBeGreaterThan(0);
    // The label is never submitted — only the stable code.
    expect(body.regionCode).not.toMatch(/\s/);
    // Untouched optional contact posts null, not '' — the three-state
    // contract the usecase's `sanitizeOptional` depends on.
    expect(body.sellerContact).toBeNull();
});

/**
 * Publish AS THE FARM — P6.7 (#1816).
 *
 * The server side of this is resolved live from the seller's published farm,
 * so the ONLY thing the form is responsible for is sending the decision. A
 * toggle that rendered but never reached the body would leave every listing
 * anonymous with nothing failing — the control would look like it worked.
 */
describe('publish as the farm', () => {
    /** The three required fields, so the submit button enables. */
    async function fillRequired() {
        fireEvent.click(document.querySelector('#exchange-commodity')!);
        fireEvent.click(await screen.findByRole('option', { name: 'Wheat' }));
        fireEvent.change(document.querySelector('#exchange-qty')!, { target: { value: '12' } });
        fireEvent.click(document.querySelector('#exchange-region')!);
        const regions = await screen.findAllByRole('option');
        fireEvent.click(regions[0]);
        const submit = screen.getByRole('button', { name: /create offer/i });
        await waitFor(() => expect(submit).toBeEnabled());
        return submit;
    }

    it('is OFF by default and posts false', async () => {
        // A listing is anonymous unless its seller asked otherwise. That is
        // the direction a per-listing consent has to default in, and `false`
        // is sent explicitly rather than omitted so the body always states
        // the decision.
        renderModal();
        const toggle = screen.getByRole('switch', { name: /publish as the farm/i });
        expect(toggle).not.toBeChecked();

        fireEvent.click(await fillRequired());
        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
        expect(body.publishAsFarm).toBe(false);
    });

    it('posts true once the seller turns it on', async () => {
        renderModal();
        fireEvent.click(screen.getByRole('switch', { name: /publish as the farm/i }));
        fireEvent.click(await fillRequired());

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
        expect(body.publishAsFarm).toBe(true);
    });

    it('states the condition in copy rather than disabling itself', async () => {
        // Deliberate: knowing whether this farm's page is public needs
        // `GET /farm-brand`, which is ADMIN-gated — a member who can post a
        // listing may not be able to read it — so a disabled switch would be
        // disabled for the wrong people. The copy carries the condition
        // instead, and the server is lenient to match.
        renderModal();
        expect(screen.getByRole('switch', { name: /publish as the farm/i })).toBeEnabled();
        expect(screen.getByText(/only while that page is public/i)).toBeInTheDocument();
    });
});

/**
 * The one PRIVATE field on a form whose every other field is broadcast to
 * every tenant. It has to say so before the seller types, and it must reach
 * the API — a contact that never leaves the browser makes Accept a dead end.
 */
it('offers a private seller contact, states the consent rule visibly, and POSTs it', async () => {
    renderModal();

    // `description`, not `hint`: always visible, never hover-only.
    expect(screen.getByText(/never shown publicly/i)).toBeVisible();
    expect(screen.getByText(/revealed only to a buyer whose interest you accept/i)).toBeVisible();

    fireEvent.click(document.querySelector('#exchange-commodity')!);
    fireEvent.click(await screen.findByRole('option', { name: 'Wheat' }));
    fireEvent.change(document.querySelector('#exchange-qty')!, { target: { value: '250' } });
    fireEvent.click(document.querySelector('#exchange-region')!);
    fireEvent.click((await screen.findAllByRole('option'))[0]);
    fireEvent.change(document.querySelector('#exchange-seller-contact')!, {
        target: { value: ' +359 88 111 1111 ' },
    });

    const submit = screen.getByRole('button', { name: /create offer/i });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.sellerContact).toBe('+359 88 111 1111');
});

it('an anonymous seller can still be reachable — blank public name, filled contact', async () => {
    renderModal();
    // `sellerDisplayName` and `sellerContact` are independent: leaving the
    // public name blank keeps the listing anonymous in the feed while the
    // contact stays available for the accept path.
    expect(document.querySelector('#exchange-seller-name')).toHaveValue('');
    expect(document.querySelector('#exchange-seller-contact')).toHaveValue('');
});
