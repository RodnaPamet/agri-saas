/**
 * `<FilterToolbar>` in-dropdown live-search rendered tests.
 *
 * Locks the 2026-05-30 behaviour: there is NO separate search bar. The
 * free-text search lives INSIDE the Filter dropdown — opening the Filter
 * popover and typing in its top input filters the table on a short
 * debounce (commits to the FilterProvider query), no Enter required.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

// FilterToolbar transitively uses Next router hooks via the filter
// system's URL-sync layer — mock them.
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/practices',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { CheckCircle } from 'lucide-react';

import { FilterToolbar } from '@/components/filters/FilterToolbar';
import {
    createFilterDefs,
    FilterProvider,
    useFilterContext,
    useFilters,
} from '@/components/ui/filter';

const { filters: defs, filterKeys } = createFilterDefs({
    status: {
        label: 'Status',
        icon: CheckCircle,
        options: [{ value: 'A', label: 'A' }],
    },
});

// Surfaces the COMMITTED search (the value that drives the URL + data
// fetch) so the test can assert when the debounce has propagated.
function SearchProbe() {
    const { search } = useFilters();
    return <output data-testid="committed-search">{search}</output>;
}

function Shell() {
    const ctx = useFilterContext(defs, filterKeys);
    return (
        <FilterProvider value={ctx}>
            <FilterToolbar
                filters={defs}
                searchId="probe-search"
                searchPlaceholder="Search…"
            />
            <SearchProbe />
        </FilterProvider>
    );
}

describe('FilterToolbar — search inside the filter dropdown', () => {
    it('renders NO standalone search bar in the toolbar', () => {
        const { container } = render(<Shell />);
        // The separate search input is gone — search happens within the
        // filter dropdown, which is closed by default.
        expect(container.querySelector('input[type="search"]')).toBeNull();
        expect(document.getElementById('probe-search')).toBeNull();
    });

    it('typing in the open filter dropdown live-searches the table (no Enter)', async () => {
        render(<Shell />);
        expect(screen.getByTestId('committed-search').textContent).toBe('');

        // Open the Filter dropdown.
        const trigger = document.querySelector(
            '[data-filter-trigger]',
        ) as HTMLElement;
        expect(trigger).not.toBeNull();
        fireEvent.click(trigger);

        // The content-search input now lives inside the popover, under the
        // configured search id.
        await waitFor(() => {
            expect(
                document.querySelector('#probe-search input'),
            ).not.toBeNull();
        });
        const input = document.querySelector(
            '#probe-search input',
        ) as HTMLInputElement;

        // Typing propagates to the committed query on the debounce — no
        // Enter press.
        fireEvent.change(input, { target: { value: 'iso' } });
        await waitFor(() => {
            expect(screen.getByTestId('committed-search').textContent).toBe(
                'iso',
            );
        });
    });
});
