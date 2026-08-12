/**
 * `/grain/costs` — the cost-ENTRY register, executed.
 *
 * The page's structural contract lives in `tests/unit/costs-page-contract`
 * and `tests/unit/costs-list-shell-adoption`; both read source TEXT and
 * contribute no runtime coverage. This file renders the thing.
 *
 * ── Which viewport, and why it matters here ─────────────────────────
 *
 * `tests/rendered/setup.ts` answers `matches: false` to every media
 * query, so the jsdom default is a PHONE — and this page passes
 * `mobileFallback: 'card'`, which means `MobileCardList` renders and
 * DROPS every column without `meta.mobileCard`. The table assertions
 * therefore pin `setViewport('desktop')` explicitly; the phone block
 * pins `mobile` rather than inheriting it, so a future change to the
 * global stub cannot silently move which branch these tests exercise.
 */

import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
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
    usePathname: () => '/t/acme/grain/costs',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantCurrencySymbol: () => '€',
    useTenantContext: () => ({ tenantName: 'Acme', tenantSlug: 'acme', currencySymbol: '€' }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { CostsClient, type CostRow } from '@/app/t/[tenantSlug]/(app)/grain/costs/CostsClient';

const COPY = enMessages.grain.costs;
const CATS = enMessages.grainEnums.costCategory;

function costRow(over: Partial<CostRow> = {}): CostRow {
    return {
        id: 'ce-1',
        category: 'FUEL',
        amount: 340.5,
        currency: 'BGN',
        incurredOn: '2026-08-01T00:00:00.000Z',
        supplier: 'Petrol AD',
        invoiceFileId: null,
        plantingId: null,
        seasonId: null,
        locationId: null,
        parcelId: null,
        leaseId: null,
        itemId: null,
        planting: null,
        season: null,
        location: null,
        parcel: null,
        item: null,
        invoiceFile: null,
        ...over,
    };
}

function renderPage(rows: CostRow[] = [costRow()], canWrite = true, truncated = false) {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    return render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
            <QueryClientProvider client={qc}>
                <TooltipProvider>
                <CostsClient
                    tenantSlug="acme"
                    initialRows={rows}
                    initialTotalCount={truncated ? 900 : rows.length}
                    initialTruncated={truncated}
                    permissions={{ canWrite }}
                />
                </TooltipProvider>
            </QueryClientProvider>
        </NextIntlClientProvider>,
    );
}

beforeEach(() => {
    global.fetch = jest.fn(() =>
        Promise.resolve({ ok: true, json: async () => ({ rows: [], totalCount: 0, truncated: false }) }),
    ) as unknown as typeof fetch;
});

afterEach(restoreViewport);

describe('grain costs — the register renders (DESKTOP)', () => {
    it('shows an entry with its category, supplier and RECORDED currency', () => {
        setViewport('desktop');
        renderPage();

        const table = screen.getByRole('table');
        expect(within(table).getByText(CATS.FUEL)).toBeVisible();
        expect(within(table).getByText('Petrol AD')).toBeVisible();
        // The recorded code, never a tenant symbol: entries in different
        // currencies share one list and there is no FX table in this repo,
        // so one symbol over all of them would be a claim the data cannot
        // support.
        expect(within(table).getByText('340.5 BGN')).toBeVisible();
        expect(within(table).queryByText(/€/)).not.toBeInTheDocument();
    });

    it('states the attribution, or an em-dash when there is none', () => {
        setViewport('desktop');
        renderPage([
            costRow({ id: 'a', seasonId: 's-1', season: { id: 's-1', name: '2026 Main' } }),
            costRow({ id: 'b' }),
        ]);

        const table = screen.getByRole('table');
        expect(within(table).getByText('2026 Main')).toBeVisible();
        expect(within(table).getAllByText('—').length).toBeGreaterThan(0);
    });

    it('marks which entries carry an invoice', () => {
        setViewport('desktop');
        renderPage([
            costRow({ id: 'a', invoiceFileId: 'f-1', invoiceFile: { id: 'f-1', originalName: 'inv.pdf' } }),
            costRow({ id: 'b' }),
        ]);

        expect(screen.getAllByLabelText(COPY.hasInvoice).length).toBe(1);
    });

    it('discloses a truncated page instead of presenting it as the total', () => {
        setViewport('desktop');
        renderPage([costRow()], true, true);
        // A capped page shown as a total is a wrong answer delivered
        // confidently — the notice is the difference.
        expect(screen.getByRole('status')).toHaveTextContent(/Showing 1 of 900/);
    });
});

describe('grain costs — the create affordance (PHONE)', () => {
    it('offers the create button to a writer, as a bare noun', () => {
        setViewport('mobile');
        renderPage();

        const btn = screen.getByRole('button', { name: COPY.addCost });
        expect(btn).toBeVisible();
        // Bare entity noun — the Plus glyph carries the verb.
        expect(btn).toHaveTextContent(/^Cost$/);
    });

    it('hides the create button from a reader', () => {
        setViewport('mobile');
        renderPage([costRow()], false);
        expect(screen.queryByRole('button', { name: COPY.addCost })).not.toBeInTheDocument();
    });

    it('opens the create modal, and its confirm keeps the VERB', () => {
        setViewport('mobile');
        renderPage();

        const user = userEvent.setup();
        return user.click(screen.getByRole('button', { name: COPY.addCost })).then(async () => {
            // The header button is a bare noun; the modal's confirm is
            // verbed, because a confirmation surface has to declare the
            // action rather than name the subject.
            // The Modal renders its title in both the dialog label and
            // the visible header, so this is legitimately more than one node.
            expect((await screen.findAllByText(COPY.form.newTitle)).length).toBeGreaterThan(0);
            expect(
                screen.getByRole('button', { name: COPY.form.createCost }),
            ).toBeVisible();
        });
    });
});

describe('grain costs — the category facet (PHONE)', () => {
    it('offers every category, not only the ones already used', async () => {
        setViewport('mobile');
        // The list holds ONE fuel entry. A facet derived from loaded rows
        // would offer only FUEL — and the category someone opens the
        // filter to check is precisely the one nothing was filed under.
        renderPage([costRow({ category: 'FUEL' })]);

        const user = userEvent.setup();
        const filterBtn = screen
            .getAllByRole('button')
            .find((b) => /filter/i.test(b.textContent ?? ''));
        expect(filterBtn).toBeDefined();
        await user.click(filterBtn!);

        // Open the Category facet itself — the popover lists facets first.
        const facetEntry = await screen.findByText(enMessages.grainEnums.costCategoryFacet);
        await user.click(facetEntry);

        // Every category, including ones no row uses. Awaited individually
        // because the panel renders its options after the facet opens.
        // findAll: a chosen facet can echo its label in the active-filter
        // chip as well as the option list, which is not a defect.
        expect((await screen.findAllByText(CATS.PAYROLL)).length).toBeGreaterThan(0);
        expect((await screen.findAllByText(CATS.RENT)).length).toBeGreaterThan(0);
        expect((await screen.findAllByText(CATS.PESTICIDE)).length).toBeGreaterThan(0);
    });
});

describe('grain costs — the empty state', () => {
    it('invites a first entry rather than just reporting emptiness', () => {
        setViewport('mobile');
        renderPage([]);

        expect(screen.getByText(COPY.emptyTitle)).toBeVisible();
        expect(
            screen.getAllByRole('button', { name: COPY.addCost }).length,
        ).toBeGreaterThan(0);
    });
});
