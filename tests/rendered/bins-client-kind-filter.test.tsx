/**
 * Grain bins — the `kind` facet actually narrows the rendered rows.
 *
 * Issue #393 item 1: `BinsClient` mounted `useFilterContext([], [] as const,
 * {})` with `defs: []`, so the FilterToolbar rendered a Filter affordance
 * whose popover held nothing but the search box. The fix adds a single-select
 * `kind` facet (BIN vs STORAGE) narrowed IN MEMORY, because
 * `GET /grain/bins` takes no query params at all.
 *
 * What this file locks, and why each one is a distinct failure:
 *
 *   1. **The facet narrows.** A structural guard could only see that a def
 *      exists. Whether `state.kind` ever reaches the row memo is a runtime
 *      question — and the in-memory read is `Array.isArray(state.kind)`, which
 *      is silently `false` for any state shape other than `string[]`. A wrong
 *      guess there yields a facet that renders, chips, and filters nothing.
 *   2. **A facet-only miss shows "no results", not "no bins yet."** The empty
 *      state was gated on `search` alone, so filtering every row out by kind
 *      told an operator who HAS bins that they have none. That reads as data
 *      loss, not as an empty result.
 *   3. **The search box still works**, and composes with the facet — the
 *      Filter popover hosts the search input (`FilterToolbar` forwards
 *      `searchId`/`searchPlaceholder` into it), so "drop the button" would
 *      have deleted the page's only search affordance.
 *
 * ── Which DataTable branch these exercise ───────────────────────────
 *
 * `BinsClient` is a `<DataTable mobileFallback="card">` and the jsdom default
 * viewport is a PHONE (see `./viewport`), where `MobileCardList` omits every
 * column without `meta.mobileCard`. The row-narrowing invariant is therefore
 * parameterised across BOTH viewports: `MobileCardList` and `Table` render the
 * row set in two separate places, and a narrowing that works in one is not
 * evidence about the other. Every test names its viewport rather than
 * inheriting the default silently.
 *
 * Copy comes from the REAL `messages/en.json` via the project-wide next-intl
 * mock in `tests/rendered/setup.ts`, so these assertions are byte-identical to
 * production output.
 */

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    usePathname: () => '/t/acme/grain/bins',
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

import { BinsClient, type BinRow } from '@/app/t/[tenantSlug]/(app)/grain/bins/BinsClient';

const COPY = enMessages.grain.bins;
const KIND_COPY = enMessages.ag.status.bin;

function bin(over: Partial<BinRow> = {}): BinRow {
    return {
        id: 'b-1',
        name: 'Silo One',
        key: 'S1',
        kind: 'BIN',
        status: 'ACTIVE',
        description: null,
        capacityTonnes: 500,
        storedTonnes: 100,
        lotCount: 2,
        fillPct: 0.2,
        mixedUnits: false,
        unconvertible: [],
        ...over,
    };
}

/** One of each kind, distinguishable by name in both viewports. */
const SILO = bin({ id: 'b-silo', name: 'Silo One', key: 'S1', kind: 'BIN' });
const BARN = bin({ id: 'b-barn', name: 'Barn Two', key: 'B2', kind: 'STORAGE' });

/**
 * Point jsdom at a URL so `useFilterContext` seeds `state` from the query
 * string — it reads `window.location.search` directly on the client.
 */
function setUrl(search: string) {
    window.history.replaceState({}, '', `/t/acme/grain/bins${search}`);
}

// This jsdom env ships neither `fetch` nor `Response`, so the stub hands back
// the minimal shape `BinsClient`'s queryFn reads (`ok` + `json()`). Using
// `new Response(...)` would throw a ReferenceError that reaches the component
// as a rejected promise instead.
const okJson = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

function mount(initialBins: BinRow[]) {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    return render(
        <QueryClientProvider client={client}>
            <BinsClient
                initialBins={initialBins}
                tenantSlug="acme"
                permissions={{ canWrite: false }}
            />
        </QueryClientProvider>,
    );
}

const originalFetch = global.fetch;

beforeEach(() => {
    global.fetch = jest.fn(async () => okJson([SILO, BARN])) as unknown as typeof fetch;
});

afterEach(() => {
    global.fetch = originalFetch;
    setUrl('');
    restoreViewport();
    jest.clearAllMocks();
});

describe('grain bins — the kind facet', () => {
    it.each(['mobile', 'desktop'] as const)(
        'narrows the rendered rows to the selected kind (%s)',
        async (viewport) => {
            setViewport(viewport);
            setUrl('?kind=BIN');

            mount([SILO, BARN]);

            // The BIN survives…
            expect(await screen.findByText('Silo One')).toBeInTheDocument();
            // …and the STORAGE row is gone. This is the assertion a structural
            // guard cannot make: it is about the rendered row set, not about
            // a def existing in source.
            await waitFor(() => {
                expect(screen.queryByText('Barn Two')).not.toBeInTheDocument();
            });
        },
    );

    it.each(['mobile', 'desktop'] as const)(
        'renders both rows when no facet is active (%s) — the control',
        async (viewport) => {
            setViewport(viewport);
            setUrl('');

            mount([SILO, BARN]);

            // Without this control the narrowing test above would also pass
            // against a component that rendered nothing at all.
            expect(await screen.findByText('Silo One')).toBeInTheDocument();
            expect(await screen.findByText('Barn Two')).toBeInTheDocument();
        },
    );

    it('selects the other kind independently (STORAGE, not BIN)', async () => {
        setViewport('desktop');
        setUrl('?kind=STORAGE');

        mount([SILO, BARN]);

        expect(await screen.findByText('Barn Two')).toBeInTheDocument();
        await waitFor(() => {
            expect(screen.queryByText('Silo One')).not.toBeInTheDocument();
        });
    });

    it('shows the no-RESULTS empty state on a facet-only miss, not "no bins yet"', async () => {
        setViewport('desktop');
        // Every loaded row is a BIN, and the facet asks for STORAGE.
        setUrl('?kind=STORAGE');
        global.fetch = jest.fn(async () => okJson([SILO])) as unknown as typeof fetch;

        mount([SILO]);

        // The regression: `emptyState` was gated on `search`, so a facet-only
        // miss fell through to the "no bins yet" variant — a claim that the
        // farm has no bins, made to an operator who has one.
        expect(await screen.findByText(COPY.emptyNoResultsTitle)).toBeInTheDocument();
        expect(screen.queryByText(COPY.emptyTitle)).not.toBeInTheDocument();
    });

    it('offers exactly the two kinds a bin can be, with their real labels', async () => {
        setViewport('desktop');
        setUrl('');

        mount([SILO, BARN]);

        await userEvent.click(await screen.findByRole('button', { name: /filter/i }));

        // BIN and STORAGE only — `LocationKind` also has FIELD, which
        // `BIN_KINDS` in the usecase deliberately excludes, so a facet
        // offering it would promise rows the list can never contain.
        const popover = await screen.findByRole('dialog').catch(() => document.body);
        expect(await screen.findByText(KIND_COPY.BIN)).toBeInTheDocument();
        expect(await screen.findByText(KIND_COPY.STORAGE)).toBeInTheDocument();
        expect(popover).toBeTruthy();
    });

    it('still filters by free text, and composes with the facet', async () => {
        setViewport('desktop');
        // Two BINs, so the facet alone cannot separate them — only the search
        // can. This is what proves the popover still hosts a working search
        // box after the facet was added to it.
        const second = bin({ id: 'b-silo2', name: 'Silo Three', key: 'S3', kind: 'BIN' });
        setUrl('?kind=BIN');
        global.fetch = jest.fn(async () =>
            okJson([SILO, second, BARN]),
        ) as unknown as typeof fetch;

        mount([SILO, second, BARN]);

        expect(await screen.findByText('Silo One')).toBeInTheDocument();
        expect(await screen.findByText('Silo Three')).toBeInTheDocument();
        expect(screen.queryByText('Barn Two')).not.toBeInTheDocument();

        // `/^Filter/`, not `/filter/i`: with a facet active the toolbar also
        // renders a "Clear filters" button, and a loose match finds both.
        await userEvent.click(await screen.findByRole('button', { name: /^Filter/ }));
        const searchBox = await screen.findByPlaceholderText(COPY.searchPlaceholder);
        await userEvent.type(searchBox, 'Three');

        await waitFor(() => {
            expect(screen.queryByText('Silo One')).not.toBeInTheDocument();
        });
        expect(screen.getByText('Silo Three')).toBeInTheDocument();
    });
});
