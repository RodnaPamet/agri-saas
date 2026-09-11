/** @jest-environment jsdom */
/**
 * LocationsClient must not answer a FAILED LOAD with "no fields yet".
 *
 * The list fed `data ?? []` straight into the table, so an undefined `data`
 * — the shape of a request that never landed — rendered the same empty state
 * as a farm that genuinely has no fields. An operator WITH fields was told
 * they had none, and nothing on screen said a fetch had failed.
 *
 * That is #862's defect on a page that fix missed (#885). The hook already
 * returned `error`; the component simply never destructured it.
 *
 * Deliberately NOT asserted: that `data` is empty. `[]` is what BOTH the
 * healthy and the broken path put in the table, so a test on the row count
 * could not fail. The discriminator is which BRANCH renders.
 */
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn(), prefetch: jest.fn() }) }));
jest.mock('next/link', () => ({
    __esModule: true,
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', permissions: {}, appPermissions: {}, availableModules: [] }),
}));

const swr = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...a: unknown[]) => swr(...a),
    usePrefetchTenant: () => () => {},
}));

import { LocationsClient } from '@/app/t/[tenantSlug]/(app)/locations/LocationsClient';

const ROWS = [{ id: 'loc-1', name: 'Home Farm', kind: 'FIELD', areaHa: 12 }];

beforeEach(() => swr.mockReset());

describe('a failed load is not an empty farm', () => {
    it('renders the FAILURE branch, not the no-records empty state', () => {
        swr.mockReturnValue({ data: undefined, error: new Error('boom'), isLoading: false, mutate: jest.fn() });
        render(<LocationsClient tenantSlug="acme" />);

        // The table is absent entirely — AsyncState owns the branch.
        expect(screen.queryByTestId('locations-table')).not.toBeInTheDocument();
        // And the "you have no fields" copy must NOT be what a failure says.
        expect(screen.queryByText('emptyTitle')).not.toBeInTheDocument();
    });

    it('CONTROL: a genuinely empty farm still gets the empty state', () => {
        // Without this, the assertion above holds for a build that renders the
        // failure branch unconditionally — which would tell every operator
        // their fields failed to load.
        swr.mockReturnValue({ data: [], error: undefined, isLoading: false, mutate: jest.fn() });
        render(<LocationsClient tenantSlug="acme" />);

        expect(screen.getByTestId('locations-table')).toBeInTheDocument();
        expect(screen.getByText('emptyTitle')).toBeInTheDocument();
    });

    it('CONTROL: rows render when the load succeeds', () => {
        swr.mockReturnValue({ data: ROWS, error: undefined, isLoading: false, mutate: jest.fn() });
        render(<LocationsClient tenantSlug="acme" />);

        expect(screen.getByTestId('locations-table')).toBeInTheDocument();
        expect(screen.getByText('Home Farm')).toBeInTheDocument();
    });

    it('a failed BACKGROUND revalidation keeps the rows on screen', () => {
        // keepPreviousData means a stale-but-real list is better than a blank
        // page. AsyncState checks `data !== undefined` FIRST, so an error
        // alongside data must not blank good rows.
        swr.mockReturnValue({ data: ROWS, error: new Error('revalidate failed'), isLoading: false, mutate: jest.fn() });
        render(<LocationsClient tenantSlug="acme" />);

        expect(screen.getByText('Home Farm')).toBeInTheDocument();
    });

    it('an error ARRIVING WHILE LOADING shows the failure, not a spinner', () => {
        // This is the only case that proves `error` is wired at all. AsyncState
        // treats "no data and not loading" as a failure REGARDLESS of `error`
        // (async-state.tsx), so with isLoading false the failure branch renders
        // either way — passing `error={undefined}` there is indistinguishable
        // from passing the real one. I know because the mutation that removes
        // it passed green until this case existed.
        //
        // With isLoading TRUE the two states separate: no error -> skeleton,
        // error -> failure. SWR holds isLoading true across its retry window,
        // so without this an operator watches a spinner spin over a request
        // that already failed.
        swr.mockReturnValue({ data: undefined, error: new Error('boom'), isLoading: true, mutate: jest.fn() });
        render(<LocationsClient tenantSlug="acme" />);

        expect(screen.queryByTestId('locations-table-skeleton')).not.toBeInTheDocument();
    });

    it('shows the skeleton while loading, not the empty state', () => {
        swr.mockReturnValue({ data: undefined, error: undefined, isLoading: true, mutate: jest.fn() });
        render(<LocationsClient tenantSlug="acme" />);

        expect(screen.getByTestId('locations-table-skeleton')).toBeInTheDocument();
        expect(screen.queryByText('emptyTitle')).not.toBeInTheDocument();
    });
});
