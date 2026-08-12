/**
 * The lease's view of the cost register.
 *
 * The panel exists to REFLECT, and the properties worth pinning are the
 * ones that stop it drifting into a second register:
 *
 *   • it offers NO create affordance — a cost belongs to at most one
 *     domain, and creating from every domain page is how the same invoice
 *     ends up filed twice under two parents;
 *   • it prints the RECORDED currency, because entries against one lease
 *     can still be in different currencies and this repo has no FX table;
 *   • a failed read renders an ERROR, never an empty list — "no costs" in
 *     response to a crash is a confident claim of zero, and on a money
 *     surface that is the claim most likely to be believed.
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '../../messages/en.json';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
}));

// The project's SWR seam, NOT the `swr` package. The panel used to carry a
// private `useSWR` + `fetch`, and mocking the package meant this suite was
// the only place it could be driven — so mounting the panel anywhere else
// dragged an unmockable fetch into that page's tests. When the panel moved
// to `useTenantSWR`, a stale `jest.mock('swr', …)` here kept every case
// GREEN while driving nothing, which is why the mock target is named in
// this comment rather than left to be inferred.
const mockSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockSWR(...args),
}));

import { DomainCostEntriesPanel } from '@/components/agro/DomainCostEntriesPanel';

const COPY = enMessages.grain.costs;

function renderPanel(over: Partial<React.ComponentProps<typeof DomainCostEntriesPanel>> = {}) {
    return render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
            <DomainCostEntriesPanel
                link="leaseId"
                id="lease-1"
                titleKey="leasePanelTitle"
                emptyKey="leasePanelEmpty"
                noteKey="leasePanelNote"
                registerHref="/grain/costs?category=RENT"
                {...over}
            />
        </NextIntlClientProvider>,
    );
}

function line(over: Record<string, unknown> = {}) {
    return {
        id: 'ce-1',
        category: 'RENT',
        amount: 1200,
        currency: 'BGN',
        incurredOn: '2026-03-01T00:00:00.000Z',
        supplier: 'Ivanov',
        invoiceFileId: null,
        ...over,
    };
}

beforeEach(() => jest.clearAllMocks());

describe('DomainCostEntriesPanel — the lease surface', () => {
    it('asks for THIS lease only', () => {
        mockSWR.mockReturnValue({ data: { rows: [] }, error: undefined, isLoading: false });
        renderPanel();
        // The filter is what makes this a reflection rather than a second
        // copy of the register.
        expect(mockSWR.mock.calls[0][0]).toContain('leaseId=lease-1');
    });

    it('lists an entry with its recorded currency, not a tenant symbol', () => {
        mockSWR.mockReturnValue({ data: { rows: [line()] }, error: undefined, isLoading: false });
        renderPanel();

        expect(screen.getByText('1,200 BGN')).toBeVisible();
        expect(screen.getByText('Ivanov')).toBeVisible();
        expect(screen.queryByText(/€/)).not.toBeInTheDocument();
    });

    it('offers NO way to create a cost from here', () => {
        mockSWR.mockReturnValue({ data: { rows: [line()] }, error: undefined, isLoading: false });
        renderPanel();

        // Only the register link — no add/new button. Creating from a
        // domain page is how one invoice gets filed under two parents.
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(screen.getByText(COPY.panelOpenRegister)).toBeVisible();
    });

    it('says the two panels are not to be added', () => {
        mockSWR.mockReturnValue({ data: { rows: [line()] }, error: undefined, isLoading: false });
        renderPanel();
        // The settlement log sits directly above. Without this note a
        // reader could reasonably sum both and double the rent.
        expect(screen.getByText(/not added together/)).toBeVisible();
    });

    it('renders an ERROR on a failed read, never an empty list', () => {
        mockSWR.mockReturnValue({ data: undefined, error: new Error('boom'), isLoading: false });
        renderPanel();

        expect(screen.getByText(COPY.loadFailed)).toBeVisible();
        expect(screen.queryByText(COPY.leasePanelEmpty)).not.toBeInTheDocument();
    });

    it('distinguishes empty from loading', () => {
        mockSWR.mockReturnValue({ data: undefined, error: undefined, isLoading: true });
        const { unmount } = renderPanel();
        expect(screen.getByText(COPY.panelLoading)).toBeVisible();
        unmount();

        mockSWR.mockReturnValue({ data: { rows: [] }, error: undefined, isLoading: false });
        renderPanel();
        expect(screen.getByText(COPY.leasePanelEmpty)).toBeVisible();
    });

    it('drives the tenant-scoped SWR seam, not a private fetch', () => {
        // If the panel ever regains its own fetcher, the mock stops being
        // called and this fails — rather than every case above passing while
        // a real `fetch` runs unmocked inside whichever page mounted it.
        mockSWR.mockReturnValue({ data: { rows: [] }, error: undefined, isLoading: false });
        renderPanel();
        expect(mockSWR).toHaveBeenCalledTimes(1);
        // A tenant-RELATIVE path — `useTenantSWR` prefixes it. A absolute
        // `/api/t/<slug>/…` here would mean the prefix got applied twice.
        expect(mockSWR.mock.calls[0][0]).not.toContain('/api/t/');
    });

    it('marks an entry that carries an invoice', () => {
        mockSWR.mockReturnValue({
            data: { rows: [line({ invoiceFileId: 'f-1' })] },
            error: undefined,
            isLoading: false,
        });
        renderPanel();
        expect(screen.getByLabelText(COPY.hasInvoice)).toBeInTheDocument();
    });
});

describe('DomainCostEntriesPanel — a second surface', () => {
    const PRODUCT = {
        link: 'itemId',
        id: 'item-1',
        titleKey: 'itemPanelTitle',
        emptyKey: 'itemPanelEmpty',
        noteKey: 'itemPanelNote',
        registerHref: '/grain/costs?itemId=item-1',
    } as const;

    it('asks for THIS product only', () => {
        mockSWR.mockReturnValue({ data: { rows: [] }, error: undefined, isLoading: false });
        renderPanel(PRODUCT);
        expect(mockSWR.mock.calls[0][0]).toContain('itemId=item-1');
    });

    it('says PRODUCT in its empty state, not lease', () => {
        // The regression this guards is the whole reason `emptyKey` is a
        // required prop: the copy used to be hard-coded to the lease, so the
        // second surface to mount the panel would have told a farmer looking
        // at a product that no costs were recorded "against this lease".
        mockSWR.mockReturnValue({ data: { rows: [] }, error: undefined, isLoading: false });
        renderPanel(PRODUCT);
        expect(screen.getByText(COPY.itemPanelEmpty)).toBeVisible();
        expect(screen.queryByText(COPY.leasePanelEmpty)).not.toBeInTheDocument();
    });

    it('omits the footnote when the surface has no neighbouring money list', () => {
        // The lease note explains why two lists must not be summed. A
        // surface with nothing to sum against should not inherit it.
        mockSWR.mockReturnValue({ data: { rows: [] }, error: undefined, isLoading: false });
        renderPanel({ ...PRODUCT, noteKey: undefined });
        expect(screen.queryByText(/not added together/)).not.toBeInTheDocument();
    });
});
