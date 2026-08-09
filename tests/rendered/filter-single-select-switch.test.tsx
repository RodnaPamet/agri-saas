/**
 * `<FilterToolbar>` — single-select value switching from the active pill.
 *
 * Regression lock: a single-select filter (no `multiple`, e.g. the
 * practices "Applicability" filter) must be switchable to a different
 * value by clicking the alternative in the ACTIVE PILL's value dropdown.
 *
 * The bug: FilterToolbar wired `onSelect` into the `FilterUI.Select`
 * (the "+ Filter" dropdown) but NOT into `FilterUI.List` (the active
 * pills). So clicking a different value on the pill called an undefined
 * `onSelect` and did nothing — the filter could never be switched once
 * set. This test renders an active single-select value, clicks the
 * other option on the pill, and asserts the state replaced it.
 */
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), back: jest.fn(),
        forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(),
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

// Single-select filter — NO `multiple`, like practices applicability.
const { filters: defs, filterKeys } = createFilterDefs({
    applicability: {
        label: 'Applicability',
        icon: CheckCircle,
        options: [
            { value: 'APPLICABLE', label: 'Applicable' },
            { value: 'NOT_APPLICABLE', label: 'Not Applicable' },
        ],
    },
});

function StateProbe() {
    const { state } = useFilters();
    return (
        <output data-testid="applicability-state">
            {JSON.stringify(state.applicability ?? [])}
        </output>
    );
}

function Seed() {
    const { set } = useFilters();
    React.useEffect(() => {
        set('applicability', 'APPLICABLE');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
}

function Shell() {
    const ctx = useFilterContext(defs, filterKeys);
    return (
        <FilterProvider value={ctx}>
            <Seed />
            <FilterToolbar filters={defs} />
            <StateProbe />
        </FilterProvider>
    );
}

describe('FilterToolbar — single-select pill value switch', () => {
    it('switches Applicable → Not Applicable from the active pill', async () => {
        render(<Shell />);

        // Seed effect commits the initial single-select value.
        await waitFor(() =>
            expect(screen.getByTestId('applicability-state').textContent).toBe(
                JSON.stringify(['APPLICABLE']),
            ),
        );

        // Open the active pill's value dropdown (the button rendering the
        // current value), then click the OTHER option.
        const pill = await screen.findByText('Applicable');
        act(() => {
            fireEvent.click(pill);
        });

        const other = await screen.findByText('Not Applicable');
        act(() => {
            fireEvent.click(other);
        });

        // The single-select value must be REPLACED — not appended, not
        // left unchanged.
        await waitFor(() =>
            expect(screen.getByTestId('applicability-state').textContent).toBe(
                JSON.stringify(['NOT_APPLICABLE']),
            ),
        );
    });
});
