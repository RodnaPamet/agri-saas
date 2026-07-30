/**
 * Grain contracts list — a failed read must NOT look like "no results".
 *
 * The defect this file locks: `ContractsClient` did
 * `contractsQuery.data ?? []` and never passed `error` to
 * `EntityListPage`, so a 500 / 403 / offline fetch rendered the table's
 * EMPTY state — "No contracts match your filters" — which is a
 * confident claim of zero matching rows in response to a crash. An
 * operator reads that as "I have no contracts", not "the request
 * failed".
 *
 * Paired with the multi-select fix, this was the visible half of one
 * bug: selecting two statuses sent `?status=DRAFT,ACTIVE`, the route
 * cast that raw string into a Prisma enum, Prisma threw, and the UI
 * calmly reported no results.
 *
 * Covered here:
 *   1. a failed list read renders the error copy, NOT the empty state;
 *   2. a successful read renders rows and no error;
 *   3. stale rows survive a failed BACKGROUND refetch (the error is
 *      gated on having nothing to show — `<DataTable>` renders `error`
 *      INSTEAD of the table, so raising it unconditionally would blank
 *      good data);
 *   4. the request carries the comma-joined multi-select facet the
 *      server now parses — the client half of the 500.
 *
 * Copy comes from the REAL `messages/en.json` via the project-wide
 * next-intl mock in `tests/rendered/setup.ts`, so these assertions are
 * byte-identical to production output.
 *
 * ── Which DataTable branch these exercise ───────────────────────────
 *
 * `ContractsClient` is a `<DataTable mobileFallback="card">` and the
 * jsdom default viewport is a PHONE (see `./viewport`), so the
 * unpinned tests below assert against `<MobileCardList>`'s error /
 * empty / row branches — NOT the `<table>`'s. That matters here
 * because the whole point of the file is "error INSTEAD of empty", and
 * `MobileCardList` and `Table` implement that choice in two separate
 * places: a fix applied to one is not a fix applied to the other. Each
 * test therefore names its viewport, and the error-not-empty invariant
 * — the actual regression — is asserted at BOTH.
 */

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import enMessages from '../../messages/en.json';

import { restoreViewport, setViewport } from './viewport';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/grain/contracts',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantName: 'Acme Farms',
        tenantSlug: 'acme',
        currencySymbol: '€',
    }),
}));

import { ContractsClient, type ContractRow } from '@/app/t/[tenantSlug]/(app)/grain/contracts/ContractsClient';

const COPY = enMessages.grain.contracts;

function row(over: Partial<ContractRow> = {}): ContractRow {
    return {
        id: 'c-1',
        seasonId: null,
        key: null,
        counterparty: 'Acme Grain Co',
        commodity: 'Wheat',
        type: 'SALE',
        status: 'ACTIVE',
        volumeTonnes: '500',
        pricePerTonne: '210',
        priceCurrency: 'EUR',
        deliveryStart: '2026-08-01T00:00:00.000Z',
        deliveryEnd: '2026-09-01T00:00:00.000Z',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        season: null,
        ...over,
    };
}

/** Point jsdom at a URL so `useFilterContext` seeds from the query
 *  string (it reads `window.location.search` directly). */
function setUrl(search: string) {
    window.history.replaceState({}, '', `/t/acme/grain/contracts${search}`);
}

// This jsdom env ships neither `fetch` nor `Response` (probe:
// `typeof Response === 'undefined'`), so the stubs below hand back the
// minimal shape `ContractsClient`'s queryFn actually reads — `ok` and
// `json()`. Using `new Response(...)` here would throw a ReferenceError
// instead, which reaches the component as a rejected promise: the error
// tests would then pass without ever exercising the `!res.ok` branch.
const okJson = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const httpStatus = (status: number) =>
    ({
        ok: false,
        status,
        json: async () => ({ error: 'upstream failure' }),
    }) as unknown as Response;

function mount(initialContracts: ContractRow[] = []) {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const utils = render(
        <QueryClientProvider client={client}>
            <ContractsClient
                initialContracts={initialContracts}
                initialTotals={[]}
                tenantSlug="acme"
                permissions={{ canWrite: false }}
            />
        </QueryClientProvider>,
    );
    return { ...utils, client };
}

const originalFetch = global.fetch;

afterEach(() => {
    global.fetch = originalFetch;
    setUrl('');
    restoreViewport();
    jest.clearAllMocks();
});

describe('grain contracts — failed read', () => {
    // `MobileCardList` (phone) and `Table` (desktop) each carry their own
    // error / empty branch, so the regression is asserted at both. Before
    // this was parameterised only the phone branch ran.
    it.each(['mobile', 'desktop'] as const)(
        'renders the error copy, not the empty state, when the list read fails (%s)',
        async (viewport) => {
        // An ACTIVE facet means no SSR hydration (`initialData` is
        // undefined when a facet is on), so the query really runs.
        setViewport(viewport);
        setUrl('?status=DRAFT,ACTIVE');
        global.fetch = jest.fn(async () => httpStatus(500)) as unknown as typeof fetch;

        mount();

        expect(await screen.findByText(COPY.loadFailed)).toBeInTheDocument();

        // The regression: neither empty-state message may appear. Both
        // assert zero rows, which is not what happened.
        expect(screen.queryByText(COPY.emptyNoResultsTitle)).not.toBeInTheDocument();
        expect(screen.queryByText(COPY.emptyTitle)).not.toBeInTheDocument();
        // …and the error replaced the data surface rather than sitting
        // above a table/card list that still claims zero rows.
        expect(screen.queryByRole('table')).toBeNull();
        expect(document.getElementById('mobile-card-list')).toBeNull();
    },
    );

    it('renders rows as real table rows on a desktop', async () => {
        // The successful-read branch at the viewport the other tests miss:
        // proves the desktop `<table>` renders the row, with the column
        // headers the card branch has no equivalent for.
        setViewport('desktop');
        setUrl('?status=ACTIVE');
        global.fetch = jest.fn(async () =>
            okJson({ rows: [row()], totals: [] }),
        ) as unknown as typeof fetch;

        mount();

        expect(await screen.findByText('Acme Grain Co')).toBeInTheDocument();
        expect(screen.getByRole('table')).toBeInTheDocument();
        expect(document.getElementById('mobile-card-list')).toBeNull();
        expect(screen.getByText('Acme Grain Co').closest('tr')).not.toBeNull();
        expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    });

    it('surfaces the error for a network failure too, not just an HTTP error', async () => {
        setUrl('?status=ACTIVE');
        global.fetch = jest.fn(async () => {
            throw new TypeError('Failed to fetch');
        }) as unknown as typeof fetch;

        mount();

        expect(await screen.findByText(COPY.loadFailed)).toBeInTheDocument();
        expect(screen.queryByText(COPY.emptyNoResultsTitle)).not.toBeInTheDocument();
    });

    it('renders rows and no error on a successful read', async () => {
        setUrl('?status=ACTIVE');
        global.fetch = jest.fn(async () =>
            okJson({ rows: [row()], totals: [] }),
        ) as unknown as typeof fetch;

        mount();

        expect(await screen.findByText('Acme Grain Co')).toBeInTheDocument();
        expect(screen.queryByText(COPY.loadFailed)).not.toBeInTheDocument();
    });

    it('keeps already-loaded rows when a BACKGROUND refetch fails', async () => {
        // No facet ⇒ the SSR slice hydrates the query. A later failure
        // must not blank rows the operator can already see: `error`
        // replaces the whole table, so it is gated on having no rows.
        setUrl('');
        global.fetch = jest.fn(async () => {
            throw new TypeError('Failed to fetch');
        }) as unknown as typeof fetch;

        const { client } = mount([row({ counterparty: 'Hydrated Co' })]);

        expect(await screen.findByText('Hydrated Co')).toBeInTheDocument();

        await client.refetchQueries({ queryKey: ['grain-contracts', 'acme'] });

        await waitFor(() => {
            expect(screen.getByText('Hydrated Co')).toBeInTheDocument();
        });
        expect(screen.queryByText(COPY.loadFailed)).not.toBeInTheDocument();
    });

    it('sends the comma-joined multi-select facet the route parses', async () => {
        setUrl('?status=DRAFT,ACTIVE&type=SALE,PURCHASE');
        const fetchMock = jest.fn(
            async (_input: RequestInfo | URL, _init?: RequestInit) =>
                okJson({ rows: [], totals: [] }),
        );
        global.fetch = fetchMock as unknown as typeof fetch;

        mount();

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const url = String(fetchMock.mock.calls[0][0]);
        const qs = new URLSearchParams(url.split('?')[1] ?? '');
        // ONE param per facet, comma-joined — the wire shape
        // `parseCsvEnumParam` is built to accept. (Repeated `status=`
        // params would be a different contract and would silently drop
        // all but one value server-side.)
        expect(qs.getAll('status')).toEqual(['DRAFT,ACTIVE']);
        expect(qs.getAll('type')).toEqual(['SALE,PURCHASE']);
    });
});
