/**
 * `<InventoryClient>` — behavioural lock on the stock register.
 *
 * The page is the only surface that writes lots and stock movements, and the
 * parts that matter are invisible in a snapshot:
 *
 *   - a hand-rolled cursor accumulator (`useInventoryCursor`) that has to
 *     APPEND page 2 rather than replace page 1, and has to keep "Load more"
 *     alive when a page fetch fails;
 *   - one dual-mode product modal that must PATCH on edit and POST on create;
 *   - a movement form whose two modes hit two different endpoints with two
 *     different bodies, gated on two different rules;
 *   - a lot move that PATCHes position without touching quantity;
 *   - `?lotId` deep-link entry, which is what the printed QR codes rely on.
 *
 * Every `it()` below names the production break it catches.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { restoreViewport, setViewport } from './viewport';

let searchParams = new URLSearchParams();
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/inventory',
    useSearchParams: () => searchParams,
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p}`;
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => (p: string) => `/t/acme${p}`,
    };
});

const apiGet = jest.fn();
const apiPost = jest.fn();
const apiPatch = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiGet: (...a: unknown[]) => apiGet(...a),
    apiPost: (...a: unknown[]) => apiPost(...a),
    apiPatch: (...a: unknown[]) => apiPatch(...a),
    apiDelete: jest.fn(),
}));

// ─── SWR fixtures (per-key, with distinct mutate spies) ──────────────

type Any = Record<string, unknown>;
let lotPage: Any | undefined;
let itemsData: Any[] | undefined;
let lotDetailData: Any | undefined;
let traceData: Any | undefined;
let traceLoading = false;
const mutateLots = jest.fn(async () => undefined);
const mutateItems = jest.fn(async () => undefined);
const mutateLot = jest.fn(async () => undefined);

jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => {
        if (key === null) return { data: undefined, isLoading: false, mutate: jest.fn() };
        if (key.includes('/trace')) {
            return { data: traceData, isLoading: traceLoading, mutate: jest.fn() };
        }
        if (key.startsWith('/inventory/lots?')) {
            return { data: lotPage, isLoading: false, mutate: mutateLots };
        }
        if (key.startsWith('/inventory/lots/')) {
            return { data: lotDetailData, isLoading: false, mutate: mutateLot };
        }
        if (key === '/items') return { data: itemsData, isLoading: false, mutate: mutateItems };
        if (key === '/units') {
            return {
                data: [{ id: 'u-l', name: 'Litre', symbol: 'L', measure: 'VOLUME' }],
                isLoading: false,
                mutate: jest.fn(),
            };
        }
        if (key.startsWith('/locations')) {
            return {
                data: [
                    { id: 'bin-1', name: 'Silo 1', kind: 'BIN' },
                    { id: 'bin-2', name: 'Silo 2', kind: 'BIN' },
                ],
                isLoading: false,
                mutate: jest.fn(),
            };
        }
        return { data: undefined, isLoading: false, mutate: jest.fn() };
    },
}));

import { InventoryClient } from '@/app/t/[tenantSlug]/(app)/inventory/InventoryClient';

// ─── Fixtures ────────────────────────────────────────────────────────

const LOT_A = {
    id: 'lot-a',
    lotCode: 'BATCH-A',
    item: { id: 'item-1', name: 'Roundup', category: 'PESTICIDE' },
    unit: { id: 'u-l', symbol: 'L' },
    location: { id: 'bin-1', name: 'Silo 1' },
    quantityOnHand: 40,
    expiresAt: '2027-04-01T00:00:00.000Z',
    lowStock: true,
};
const LOT_B = {
    id: 'lot-b',
    lotCode: 'BATCH-B',
    item: { id: 'item-1', name: 'Roundup', category: 'PESTICIDE' },
    unit: { id: 'u-l', symbol: 'L' },
    location: null,
    quantityOnHand: 900,
    expiresAt: null,
    lowStock: false,
};

const LOT_DETAIL = {
    ...LOT_A,
    ledger: [],
};

const ITEM_DETAIL = {
    id: 'item-1',
    name: 'Roundup',
    category: 'PESTICIDE',
    defaultUnitId: 'u-l',
    sku: null,
    reorderLevel: 5,
    quarantinePeriodDays: 30,
    activeIngredient: 'glyphosate 480 g/L',
    pppRegistrationNo: 'PPP-1',
};

const page = (items: unknown[], nextCursor: string | null = null) => ({
    items,
    pageInfo: { nextCursor, hasNextPage: nextCursor != null },
});

const user = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 });

// ─── Viewport practice ────────────────────────────────────────────────
//
// The default jsdom viewport reads as a PHONE, so the desktop
// `<DataTable>` branch is unreachable unless a test says otherwise. The
// mechanism (and why the phone default is the right one for this
// product) is documented in `./viewport`, which also carries the
// executing test for the helper itself.
afterEach(restoreViewport);

function renderPage() {
    return render(
        <TooltipProvider>
            <main>
                <InventoryClient tenantSlug="acme" />
            </main>
        </TooltipProvider>,
    );
}

/** Resolve a Combobox trigger by its FormField label (aria-label is not forwarded). */
function comboboxFor(label: string, root: ParentNode = document): HTMLElement {
    const field = Array.from(
        root.querySelectorAll<HTMLElement>('[data-form-field="true"]'),
    ).find(
        (el) => el.querySelector('label')?.textContent?.replace(/\*/g, '').trim() === label,
    );
    if (!field) throw new Error(`No form field labelled "${label}"`);
    const trigger = field.querySelector<HTMLElement>('[role="combobox"]');
    if (!trigger) throw new Error(`Form field "${label}" has no combobox trigger`);
    return trigger;
}

async function pick(u: ReturnType<typeof user>, label: string, option: string | RegExp) {
    await u.click(comboboxFor(label));
    await u.click(await screen.findByRole('option', { name: option }));
}

/** Open the lot-detail modal by clicking its row in the lots table. */
async function openLot(u: ReturnType<typeof user>, lotCode: string) {
    await u.click(screen.getByText(lotCode));
    await waitFor(() => expect(document.getElementById('movement-form')).not.toBeNull());
}

beforeEach(() => {
    jest.clearAllMocks();
    searchParams = new URLSearchParams();
    lotPage = page([LOT_A, LOT_B]);
    itemsData = [{ id: 'item-1', name: 'Roundup', category: 'PESTICIDE' }];
    lotDetailData = LOT_DETAIL;
    traceData = undefined;
    traceLoading = false;
    apiGet.mockImplementation(async (url: string) => {
        if (url.includes('/ledger')) return page([]);
        if (url.includes('/items/')) return ITEM_DETAIL;
        if (url.includes('/inventory/lots?')) return page([]);
        throw new Error(`unexpected GET ${url}`);
    });
    apiPost.mockResolvedValue({});
    apiPatch.mockResolvedValue({});
});

// ─── Lot table ───────────────────────────────────────────────────────

describe('InventoryClient — lot table', () => {
    it('badges only the lots that are actually low, and dashes the blanks (desktop)', async () => {
        // Break: dropping the `row.original.lowStock &&` guard paints "Low"
        // on every lot, and rendering `expiresAt`/`location` unguarded prints
        // "null" for a lot with no expiry or no bin.
        setViewport('desktop');
        renderPage();
        await waitFor(() => expect(screen.getByText('BATCH-A')).toBeInTheDocument());

        expect(screen.getAllByText('Low')).toHaveLength(1);
        const rowB = screen.getByText('BATCH-B').closest('tr')!;
        expect(rowB).not.toBeNull();
        expect(within(rowB).queryByText('Low')).toBeNull();
        expect(within(rowB).getAllByText('—')).toHaveLength(2); // expiry + location
    });

    it('swaps the table for cards on a phone, keeping the on-hand + Low pill', async () => {
        // Break: dropping `mobileFallback="card"` (or the per-column
        // `meta.mobileCard` slots) leaves the field operator scrolling a
        // five-column table sideways on a 375px screen. This is the branch
        // the app actually ships to the people who use it most — pinned
        // explicitly rather than inherited from the jsdom default, so the
        // test keeps testing a phone if that default ever changes.
        setViewport('mobile');
        renderPage();
        await waitFor(() => expect(screen.getByText('BATCH-A')).toBeInTheDocument());

        expect(document.querySelector('table')).toBeNull();
        expect(screen.getAllByText('Low')).toHaveLength(1);
        // The key/value meta rows carry their column headers as labels.
        expect(screen.getAllByText('On hand').length).toBeGreaterThan(0);
    });

    it('shows the empty state, not a blank table, for a tenant with no lots', async () => {
        // Break: an empty-state regression leaves a brand-new tenant with no
        // route into the create-product flow.
        lotPage = page([]);
        renderPage();
        expect(await screen.findByText('No stock yet')).toBeInTheDocument();
    });
});

// ─── Cursor accumulator ──────────────────────────────────────────────

describe('InventoryClient — "Load more" accumulator', () => {
    it('appends page 2 instead of replacing page 1', async () => {
        // Break: `setRows(page.items)` in `loadMore` drops every row already
        // on screen — the table appears to shrink as the operator pages.
        const u = user();
        lotPage = page([LOT_A], 'cursor-1');
        apiGet.mockImplementation(async (url: string) => {
            if (url.includes('/inventory/lots?')) return page([LOT_B]);
            if (url.includes('/ledger')) return page([]);
            throw new Error(`unexpected GET ${url}`);
        });
        renderPage();
        await waitFor(() => expect(screen.getByText('BATCH-A')).toBeInTheDocument());

        await u.click(screen.getByRole('button', { name: 'Load more' }));

        await waitFor(() => expect(screen.getByText('BATCH-B')).toBeInTheDocument());
        expect(screen.getByText('BATCH-A')).toBeInTheDocument();
        expect(apiGet.mock.calls[0][0]).toBe(
            '/api/t/acme/inventory/lots?limit=50&cursor=cursor-1',
        );
        // page 2 carried no cursor → the affordance retires.
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull(),
        );
    });

    it('keeps "Load more" on screen when the page fetch fails', async () => {
        // Break: clearing `hasMore` in the catch (or letting the rejection
        // escape) strands the operator on page 1 after one flaky read, with
        // no way to retry.
        const u = user();
        lotPage = page([LOT_A], 'cursor-1');
        apiGet.mockImplementation(async (url: string) => {
            if (url.includes('/inventory/lots?')) throw new Error('offline');
            if (url.includes('/ledger')) return page([]);
            throw new Error(`unexpected GET ${url}`);
        });
        renderPage();
        await u.click(await screen.findByRole('button', { name: 'Load more' }));

        await waitFor(() => expect(apiGet).toHaveBeenCalled());
        expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
        expect(screen.getByText('BATCH-A')).toBeInTheDocument();
    });

    it('hides "Load more" when the first page is already the last', async () => {
        // Break: rendering the button off `rows.length` instead of
        // `hasNextPage` offers a page that does not exist.
        renderPage();
        await waitFor(() => expect(screen.getByText('BATCH-A')).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    });
});

// ─── Deep link ───────────────────────────────────────────────────────

describe('InventoryClient — QR deep link', () => {
    it('opens the lot detail straight from ?lotId', async () => {
        // Break: dropping the mount effect makes every printed QR code land
        // on a plain inventory list — the operator has to hunt for the lot.
        searchParams = new URLSearchParams('lotId=lot-a');
        renderPage();
        await waitFor(() => expect(document.getElementById('movement-form')).not.toBeNull());
        expect(screen.getByText('Roundup — BATCH-A')).toBeInTheDocument();
        // The ledger for the deep-linked lot is fetched, not left stale.
        await waitFor(() =>
            expect(apiGet).toHaveBeenCalledWith(
                '/api/t/acme/inventory/lots/lot-a/ledger?limit=50',
            ),
        );
    });

    it('stays on the list when there is no ?lotId', async () => {
        renderPage();
        await waitFor(() => expect(screen.getByText('BATCH-A')).toBeInTheDocument());
        expect(document.getElementById('movement-form')).toBeNull();
    });
});

// ─── Product modal (dual mode) ───────────────────────────────────────

describe('InventoryClient — product modal', () => {
    it('keeps create disabled until a name AND a unit are chosen', async () => {
        // Break: dropping either conjunct posts a product the API rejects.
        const u = user();
        renderPage();
        await u.click(screen.getAllByRole('button', { name: 'New product' })[0]);

        const submit = await screen.findByRole('button', { name: 'Create product' });
        expect(submit).toBeDisabled();

        fireEvent.change(screen.getByPlaceholderText('e.g. Roundup PowerMAX'), {
            target: { value: 'Urea' },
        });
        expect(submit).toBeDisabled(); // unit still unset

        await pick(u, 'Default unit', /Litre/);
        await waitFor(() => expect(submit).not.toBeDisabled());
    });

    it('POSTs a new product with the untouched optional fields as null', async () => {
        // Break: sending `''` (or `0`) for a blank reorder level makes every
        // new product look permanently low-stock.
        const u = user();
        renderPage();
        await u.click(screen.getAllByRole('button', { name: 'New product' })[0]);
        fireEvent.change(screen.getByPlaceholderText('e.g. Roundup PowerMAX'), {
            target: { value: 'Urea' },
        });
        await pick(u, 'Default unit', /Litre/);
        await u.click(screen.getByRole('button', { name: 'Create product' }));

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        const [url, body] = apiPost.mock.calls[0];
        expect(url).toBe('/api/t/acme/items');
        expect(body).toEqual({
            name: 'Urea',
            category: 'PESTICIDE',
            defaultUnitId: 'u-l',
            reorderLevel: null,
            quarantinePeriodDays: null,
            activeIngredient: null,
            pppRegistrationNo: null,
        });
        expect(apiPatch).not.toHaveBeenCalled();
        expect(mutateItems).toHaveBeenCalled();
    });

    it('prefills from GET /items/{id} and PATCHes on edit', async () => {
        // Break: leaving `editItemId` null (or always calling apiPost) turns
        // every product edit into a duplicate product.
        const u = user();
        renderPage();
        await openLot(u, 'BATCH-A');
        await u.click(screen.getByRole('button', { name: 'Edit product' }));

        await waitFor(() =>
            expect(screen.getByPlaceholderText('e.g. Roundup PowerMAX')).toHaveValue('Roundup'),
        );
        expect(apiGet).toHaveBeenCalledWith('/api/t/acme/items/item-1');
        expect(screen.getByPlaceholderText('e.g. 5')).toHaveValue('5');
        expect(screen.getByPlaceholderText('e.g. 30')).toHaveValue('30');
        expect(screen.getByPlaceholderText('e.g. glyphosate 480 g/L')).toHaveValue(
            'glyphosate 480 g/L',
        );

        await u.click(screen.getByRole('button', { name: 'Save product' }));
        await waitFor(() => expect(apiPatch).toHaveBeenCalled());
        expect(apiPatch.mock.calls[0][0]).toBe('/api/t/acme/items/item-1');
        expect(apiPatch.mock.calls[0][1]).toMatchObject({ reorderLevel: 5, name: 'Roundup' });
        expect(apiPost).not.toHaveBeenCalled();
        // An edit changes the name + the Low badge on the lots table, so the
        // list read is revalidated too — not just the /items catalogue.
        // Break: dropping the `if (editItemId) await mutate()` leaves a
        // renamed product (and a stale Low pill) on the table until reload.
        await waitFor(() => expect(mutateItems).toHaveBeenCalled());
        expect(mutateLots).toHaveBeenCalled();
    });

    it('surfaces a failed product load instead of opening a blank edit form', async () => {
        // Break: opening the modal regardless leaves the operator editing an
        // empty form that would overwrite the product with blanks.
        const u = user();
        apiGet.mockImplementation(async (url: string) => {
            if (url.includes('/items/')) throw new Error('Product not found');
            if (url.includes('/ledger')) return page([]);
            throw new Error(`unexpected GET ${url}`);
        });
        renderPage();
        await openLot(u, 'BATCH-A');
        await u.click(screen.getByRole('button', { name: 'Edit product' }));

        expect(await screen.findByText('Product not found')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Save product' })).toBeNull();
    });

    it('starts the create form clean after an edit', async () => {
        // Break: not calling `resetProductForm` in `openNewProduct` reopens
        // the modal in edit mode — "New product" would then PATCH the last
        // edited item.
        const u = user();
        renderPage();
        await openLot(u, 'BATCH-A');
        await u.click(screen.getByRole('button', { name: 'Edit product' }));
        await waitFor(() =>
            expect(screen.getByPlaceholderText('e.g. Roundup PowerMAX')).toHaveValue('Roundup'),
        );
        await u.click(screen.getByRole('button', { name: 'Cancel' }));

        await u.click(screen.getAllByRole('button', { name: 'New product' })[0]);
        await waitFor(() =>
            expect(screen.getByPlaceholderText('e.g. Roundup PowerMAX')).toHaveValue(''),
        );
        expect(screen.getByRole('button', { name: 'Create product' })).toBeInTheDocument();
    });
});

// ─── New lot ─────────────────────────────────────────────────────────

describe('InventoryClient — new lot', () => {
    it('sends a blank quantity + expiry as null, not "" ', async () => {
        // Break: posting `''` for `initialQuantity` creates an opening
        // RECEIPT of NaN; posting `''` for `expiresAt` fails date parsing.
        const u = user();
        renderPage();
        await u.click(screen.getByRole('button', { name: 'New lot' }));
        await pick(u, 'Product', 'Roundup');
        fireEvent.change(screen.getByPlaceholderText('e.g. BATCH-2027-04'), {
            target: { value: 'BATCH-C' },
        });
        await u.click(screen.getByRole('button', { name: 'Create lot' }));

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        expect(apiPost.mock.calls[0][0]).toBe('/api/t/acme/inventory/lots');
        expect(apiPost.mock.calls[0][1]).toEqual({
            itemId: 'item-1',
            lotCode: 'BATCH-C',
            initialQuantity: null,
            expiresAt: null,
            locationId: null,
        });
        expect(mutateLots).toHaveBeenCalled();
    });

    it('attaches the chosen bin and the opening quantity', async () => {
        // Break: dropping `locationId` from the body makes stock invisible to
        // every bin view — the lot exists but no silo shows it.
        const u = user();
        renderPage();
        await u.click(screen.getByRole('button', { name: 'New lot' }));
        await pick(u, 'Product', 'Roundup');
        fireEvent.change(screen.getByPlaceholderText('e.g. BATCH-2027-04'), {
            target: { value: 'BATCH-C' },
        });
        fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '250' } });
        await pick(u, 'Storage location', 'Silo 2');
        await u.click(screen.getByRole('button', { name: 'Create lot' }));

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        expect(apiPost.mock.calls[0][1]).toMatchObject({
            initialQuantity: 250,
            locationId: 'bin-2',
        });
    });

    it('keeps create disabled until a product and a lot code are given', async () => {
        const u = user();
        renderPage();
        await u.click(screen.getByRole('button', { name: 'New lot' }));
        const submit = await screen.findByRole('button', { name: 'Create lot' });
        expect(submit).toBeDisabled();

        await pick(u, 'Product', 'Roundup');
        expect(submit).toBeDisabled(); // no lot code yet
        fireEvent.change(screen.getByPlaceholderText('e.g. BATCH-2027-04'), {
            target: { value: 'BATCH-C' },
        });
        await waitFor(() => expect(submit).not.toBeDisabled());
    });

    it('refuses the New lot action while the tenant has no products', async () => {
        // Break: an enabled New lot with no products opens a modal whose
        // required Product picker can never be satisfied.
        itemsData = [];
        renderPage();
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'New lot' })).toBeDisabled(),
        );
    });
});

// ─── Move lot ────────────────────────────────────────────────────────

describe('InventoryClient — moving a lot', () => {
    it('keeps Move disabled until a DIFFERENT bin is chosen', async () => {
        // Break: gating only on `moving` fires a PATCH that moves the lot to
        // where it already is — a no-op write in the operator's audit trail.
        const u = user();
        renderPage();
        await openLot(u, 'BATCH-A');

        // Untouched: `moveLocationId` is null, so the picker falls back to the
        // lot's own bin and there is nothing to commit.
        expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled();

        await pick(u, 'Storage location', 'Silo 2');
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Move' })).not.toBeDisabled(),
        );

        // Changing back to the lot's current bin makes it a no-op again.
        await pick(u, 'Storage location', 'Silo 1');
        await waitFor(() => expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled());
    });

    it('PATCHes only the position and refreshes both reads', async () => {
        // Break: sending quantity here (or POSTing a movement) turns a shelf
        // move into ledger activity and corrupts on-hand.
        const u = user();
        renderPage();
        await openLot(u, 'BATCH-A');
        await pick(u, 'Storage location', 'Silo 2');
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Move' })).not.toBeDisabled(),
        );
        await u.click(screen.getByRole('button', { name: 'Move' }));

        await waitFor(() => expect(apiPatch).toHaveBeenCalled());
        expect(apiPatch.mock.calls[0]).toEqual([
            '/api/t/acme/inventory/lots/lot-a',
            { locationId: 'bin-2' },
        ]);
        expect(apiPost).not.toHaveBeenCalled();
        await waitFor(() => expect(mutateLot).toHaveBeenCalled());
        expect(mutateLots).toHaveBeenCalled();
    });

    it('surfaces a rejected move', async () => {
        const u = user();
        apiPatch.mockRejectedValueOnce(new Error('Silo 2 is full'));
        renderPage();
        await openLot(u, 'BATCH-A');
        await pick(u, 'Storage location', 'Silo 2');
        await u.click(screen.getByRole('button', { name: 'Move' }));

        expect(await screen.findByText('Silo 2 is full')).toBeInTheDocument();
    });
});

// ─── Movement form ───────────────────────────────────────────────────

describe('InventoryClient — stock movements', () => {
    const qtyBox = () => screen.getByPlaceholderText('0');

    it('receives against /receive with a bare quantity', async () => {
        // Break: sending `delta` (or hitting /adjust) on the receive tab
        // records the wrong movement type in the ledger.
        const u = user();
        renderPage();
        await openLot(u, 'BATCH-A');
        fireEvent.change(qtyBox(), { target: { value: '12' } });
        await u.click(screen.getByRole('button', { name: 'Post' }));

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        expect(apiPost.mock.calls[0]).toEqual([
            '/api/t/acme/inventory/lots/lot-a/receive',
            { quantity: 12 },
        ]);
        // The ledger is re-read after a movement, not left stale.
        await waitFor(() =>
            expect(apiGet).toHaveBeenCalledWith(
                '/api/t/acme/inventory/lots/lot-a/ledger?limit=50',
            ),
        );
    });

    it('refuses a non-positive receive', async () => {
        // Break: gating on `!mvQty` alone lets "-3" through as a RECEIPT,
        // which is a disguised adjustment with no reason recorded.
        const u = user();
        renderPage();
        await openLot(u, 'BATCH-A');
        fireEvent.change(qtyBox(), { target: { value: '-3' } });
        expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();

        fireEvent.change(qtyBox(), { target: { value: '3' } });
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Post' })).not.toBeDisabled(),
        );
    });

    it('adjusts against /adjust with a signed delta and a mandatory reason', async () => {
        // Break: dropping the reason requirement writes an unexplained
        // adjustment — the one movement type an auditor always asks about.
        const u = user();
        renderPage();
        await openLot(u, 'BATCH-A');
        await u.click(screen.getByRole('radio', { name: 'Adjust' }));

        fireEvent.change(await screen.findByPlaceholderText('e.g. -2.5'), {
            target: { value: '-2.5' },
        });
        expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled(); // no reason

        fireEvent.change(screen.getByPlaceholderText('e.g. stock count correction'), {
            target: { value: 'spillage' },
        });
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Post' })).not.toBeDisabled(),
        );
        await u.click(screen.getByRole('button', { name: 'Post' }));

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        expect(apiPost.mock.calls[0]).toEqual([
            '/api/t/acme/inventory/lots/lot-a/adjust',
            { delta: -2.5, reason: 'spillage' },
        ]);
    });

    it('surfaces a rejected movement and keeps the modal open', async () => {
        const u = user();
        apiPost.mockRejectedValueOnce(new Error('Would take the lot negative'));
        renderPage();
        await openLot(u, 'BATCH-A');
        fireEvent.change(qtyBox(), { target: { value: '12' } });
        await u.click(screen.getByRole('button', { name: 'Post' }));

        expect(await screen.findByText('Would take the lot negative')).toBeInTheDocument();
        expect(document.getElementById('movement-form')).not.toBeNull();
    });
});

// ─── Ledger rendering ────────────────────────────────────────────────

describe('InventoryClient — ledger', () => {
    const entry = (over: Any) => ({
        id: 'e1',
        type: 'RECEIPT',
        quantityDelta: 10,
        unitSymbol: 'L',
        occurredAt: '2027-01-05T00:00:00.000Z',
        reason: null,
        actor: null,
        ...over,
    });

    it('humanizes known movement types and falls back to the raw enum', async () => {
        // Break: a `t()` on a dynamic key throws for an enum member the
        // catalogue has not caught up with; the fallback keeps the row
        // readable instead of blanking the ledger.
        const u = user();
        apiGet.mockImplementation(async (url: string) => {
            if (url.includes('/ledger')) {
                return page([
                    entry({ id: 'e1', type: 'RECEIPT', quantityDelta: 10 }),
                    entry({ id: 'e2', type: 'SOMETHING_NEW', quantityDelta: -4 }),
                ]);
            }
            throw new Error(`unexpected GET ${url}`);
        });
        renderPage();
        await openLot(u, 'BATCH-A');

        expect(await screen.findByText('Receipt')).toBeInTheDocument();
        expect(screen.getByText('SOMETHING_NEW')).toBeInTheDocument();
    });

    it('signs the delta so an outflow can never read as an inflow', async () => {
        // Break: dropping the `> 0 ? '+' : ''` prefix renders "10 L" for both
        // a receipt and a consumption of 10.
        const u = user();
        apiGet.mockImplementation(async (url: string) => {
            if (url.includes('/ledger')) {
                return page([
                    entry({ id: 'e1', quantityDelta: 10 }),
                    entry({ id: 'e2', type: 'CONSUMPTION', quantityDelta: -4, reason: 'spray' }),
                ]);
            }
            throw new Error(`unexpected GET ${url}`);
        });
        renderPage();
        await openLot(u, 'BATCH-A');

        expect(await screen.findByText(/\+\s*10\s*L/)).toBeInTheDocument();
        expect(screen.getByText(/-\s*4\s*L/)).toBeInTheDocument();
        expect(screen.getByText('· spray')).toBeInTheDocument();
    });

    it('says the ledger is empty rather than rendering nothing', async () => {
        const u = user();
        renderPage();
        await openLot(u, 'BATCH-A');
        expect(await screen.findByText('No movements yet.')).toBeInTheDocument();
    });

    it('falls back to an empty ledger when the read fails', async () => {
        // Break: an unhandled rejection here would leave the PREVIOUS lot's
        // ledger on screen under the new lot's header.
        const u = user();
        apiGet.mockImplementation(async (url: string) => {
            if (url.includes('/ledger')) throw new Error('offline');
            throw new Error(`unexpected GET ${url}`);
        });
        renderPage();
        await openLot(u, 'BATCH-A');
        expect(await screen.findByText('No movements yet.')).toBeInTheDocument();
    });
});

// ─── Traceability ────────────────────────────────────────────────────

describe('InventoryClient — lot genealogy', () => {
    const node = (over: Any) => ({
        id: 'n1',
        lotCode: 'BATCH-A',
        item: { id: 'item-1', name: 'Roundup', category: 'PESTICIDE' },
        unitSymbol: 'L',
        quantityOnHand: 40,
        fields: [],
        ...over,
    });

    it('does not fetch the genealogy until it is asked for', async () => {
        // Break: fetching eagerly costs a recall-graph walk on every lot the
        // operator merely glances at.
        const u = user();
        traceData = { root: node({}), ancestors: [], descendants: [] };
        renderPage();
        await openLot(u, 'BATCH-A');
        expect(screen.getByRole('button', { name: 'Show genealogy' })).toHaveAttribute(
            'aria-expanded',
            'false',
        );
        expect(screen.queryByText('Derived from')).toBeNull();
    });

    it('renders the three groups with the parcels each lot touched', async () => {
        // Break: collapsing ancestors and descendants into one list destroys
        // the direction of a recall — upstream and downstream are not the
        // same question.
        const u = user();
        traceData = {
            root: node({ id: 'n-root', lotCode: 'BATCH-A' }),
            ancestors: [
                node({
                    id: 'n-anc',
                    lotCode: 'SEED-1',
                    item: { id: 'i2', name: 'Wheat seed', category: 'SEED' },
                    fields: [{ id: 'f1', name: 'Нива 1' }],
                }),
            ],
            descendants: [node({ id: 'n-desc', lotCode: 'FLOUR-1' })],
        };
        renderPage();
        await openLot(u, 'BATCH-A');
        await u.click(screen.getByRole('button', { name: 'Show genealogy' }));

        expect(await screen.findByText('Derived from')).toBeInTheDocument();
        expect(screen.getByText('This lot')).toBeInTheDocument();
        expect(screen.getByText('Produced')).toBeInTheDocument();
        expect(screen.getByText('SEED-1')).toBeInTheDocument();
        expect(screen.getByText('FLOUR-1')).toBeInTheDocument();
        expect(screen.getByText('Seed')).toBeInTheDocument(); // humanized category
        expect(screen.getByText('Fields: Нива 1')).toBeInTheDocument();
        // Toggling back hides it again.
        await u.click(screen.getByRole('button', { name: 'Hide genealogy' }));
        expect(screen.queryByText('Derived from')).toBeNull();
    });

    it('says a lot has no genealogy rather than showing three empty groups', async () => {
        // Break: rendering the groups regardless implies a recall graph that
        // does not exist.
        const u = user();
        traceData = { root: node({}), ancestors: [], descendants: [] };
        renderPage();
        await openLot(u, 'BATCH-A');
        await u.click(screen.getByRole('button', { name: 'Show genealogy' }));

        expect(
            await screen.findByText('No genealogy recorded for this lot yet.'),
        ).toBeInTheDocument();
    });

    it('shows a loading line while the genealogy is in flight', async () => {
        const u = user();
        traceData = undefined;
        traceLoading = true;
        renderPage();
        await openLot(u, 'BATCH-A');
        await u.click(screen.getByRole('button', { name: 'Show genealogy' }));

        expect(await screen.findByText('Loading genealogy…')).toBeInTheDocument();
    });
});
