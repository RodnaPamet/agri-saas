/**
 * `<EntityListPage>` rendered tests.
 *
 * Locks the shell's structural contract:
 *   - header (title + count + actions) renders cleanly
 *   - filter toolbar wired up when `filters` prop supplied;
 *     omitted entirely when not
 *   - DataTable receives data + columns + threaded props
 *   - children pass through (modals/sheets sit at page level)
 *   - row click + empty state work end-to-end through the shell
 */

import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

// Mock next/navigation — DataTable + FilterToolbar transitively use
// Next router hooks via the filter system's URL-sync layer.
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

import { EntityListPage } from '@/components/layout/EntityListPage';
import { createColumns } from '@/components/ui/table';
import {
    createFilterDefs,
    FilterProvider,
    useFilterContext,
} from '@/components/ui/filter';

// ─── Fixtures ─────────────────────────────────────────────────────

interface SampleRow {
    id: string;
    name: string;
    status: string;
}

const sampleRows: SampleRow[] = [
    { id: 'a', name: 'Alpha', status: 'IMPLEMENTED' },
    { id: 'b', name: 'Bravo', status: 'IN_PROGRESS' },
];

const sampleColumns = createColumns<SampleRow>([
    {
        id: 'name',
        header: 'Name',
        cell: ({ row }) => (
            <span data-testid={`row-name-${row.original.id}`}>
                {row.original.name}
            </span>
        ),
    },
    {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => row.original.status,
    },
]);

// FilterToolbar requires a FilterProvider in scope — wrap renders.
// Use the canonical `createFilterDefs` factory (same shape every prod
// page uses) so the fixture exercises the real type contract.
const { filters: sampleFilterDefs, filterKeys: sampleFilterKeys } =
    createFilterDefs({
        status: {
            label: 'Status',
            icon: CheckCircle,
            options: [
                { value: 'IMPLEMENTED', label: 'Implemented' },
                { value: 'IN_PROGRESS', label: 'In Progress' },
            ],
        },
    });

function FilterShell({ children }: { children: React.ReactNode }) {
    const ctx = useFilterContext(sampleFilterDefs, sampleFilterKeys);
    return <FilterProvider value={ctx}>{children}</FilterProvider>;
}

// ─── Tests ───────────────────────────────────────────────────────

describe('EntityListPage — header', () => {
    it('renders title + count + actions when supplied', () => {
        render(
            <FilterShell>
                <EntityListPage<SampleRow>
                    header={{
                        title: 'Practices',
                        count: '2 practices in register',
                        actions: (
                            <button type="button" data-testid="header-create">
                                + Practice
                            </button>
                        ),
                    }}
                    table={{
                        data: sampleRows,
                        columns: sampleColumns,
                        getRowId: (r) => r.id,
                    }}
                />
            </FilterShell>,
        );

        // v2-PR-5 — EntityListPage now delegates to <PageHeader>;
        // assert via the canonical page-header-* test ids.
        expect(screen.getByTestId('page-header-title').textContent).toBe(
            'Practices',
        );
        expect(
            screen.getByTestId('page-header-description').textContent,
        ).toBe('2 practices in register');
        expect(screen.getByTestId('header-create')).toBeInTheDocument();
        expect(
            screen.getByTestId('page-header-actions'),
        ).toBeInTheDocument();
    });

    it('omits the count + actions slots when not supplied', () => {
        render(
            <FilterShell>
                <EntityListPage<SampleRow>
                    header={{ title: 'Bare' }}
                    table={{
                        data: sampleRows,
                        columns: sampleColumns,
                        getRowId: (r) => r.id,
                    }}
                />
            </FilterShell>,
        );
        expect(screen.queryByTestId('page-header-description')).toBeNull();
        expect(screen.queryByTestId('page-header-actions')).toBeNull();
    });
});

describe('EntityListPage — filters', () => {
    it('renders FilterToolbar when filters prop is supplied', () => {
        render(
            <FilterShell>
                <EntityListPage<SampleRow>
                    header={{ title: 'Practices' }}
                    filters={{
                        defs: sampleFilterDefs,
                        searchId: 'sample-search',
                        searchPlaceholder: 'Search…',
                    }}
                    table={{
                        data: sampleRows,
                        columns: sampleColumns,
                        getRowId: (r) => r.id,
                    }}
                />
            </FilterShell>,
        );
        // The FilterToolbar renders its filter trigger. Search lives
        // INSIDE this dropdown (no standalone bar) — the configured
        // search input only mounts once the popover is opened.
        expect(
            document.querySelector('[data-filter-trigger]'),
        ).not.toBeNull();
        expect(document.getElementById('sample-search')).toBeNull();
    });

    it('omits FilterToolbar entirely when filters prop is not supplied', () => {
        render(
            <FilterShell>
                <EntityListPage<SampleRow>
                    header={{ title: 'No filters' }}
                    table={{
                        data: sampleRows,
                        columns: sampleColumns,
                        getRowId: (r) => r.id,
                    }}
                />
            </FilterShell>,
        );
        // No filter toolbar at all.
        expect(document.querySelector('[data-filter-trigger]')).toBeNull();
    });
});

describe('EntityListPage — table', () => {
    it('renders rows from the data prop', () => {
        render(
            <FilterShell>
                <EntityListPage<SampleRow>
                    header={{ title: 'Practices' }}
                    table={{
                        data: sampleRows,
                        columns: sampleColumns,
                        getRowId: (r) => r.id,
                        'data-testid': 'sample-table',
                    }}
                />
            </FilterShell>,
        );
        expect(screen.getByTestId('row-name-a').textContent).toBe('Alpha');
        expect(screen.getByTestId('row-name-b').textContent).toBe('Bravo');
        expect(screen.getByTestId('sample-table')).toBeInTheDocument();
    });

    it('forwards onRowClick to the underlying DataTable (fires on double-click)', () => {
        const onRowClick = jest.fn();
        render(
            <FilterShell>
                <EntityListPage<SampleRow>
                    header={{ title: 'Practices' }}
                    table={{
                        data: sampleRows,
                        columns: sampleColumns,
                        getRowId: (r) => r.id,
                        onRowClick,
                    }}
                />
            </FilterShell>,
        );
        // R13-PR2 — onRowClick fires on double-click, not single-click.
        fireEvent.doubleClick(screen.getByTestId('row-name-a'));
        expect(onRowClick).toHaveBeenCalled();
        const [row] = onRowClick.mock.calls[0];
        expect(row.original.id).toBe('a');
    });

    it('forwards emptyState when data is empty', () => {
        render(
            <FilterShell>
                <EntityListPage<SampleRow>
                    header={{ title: 'Practices' }}
                    table={{
                        data: [],
                        columns: sampleColumns,
                        getRowId: (r) => r.id,
                        emptyState: 'Nothing here yet.',
                    }}
                />
            </FilterShell>,
        );
        expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
    });
});

describe('EntityListPage — children passthrough', () => {
    it('renders children verbatim (modals/sheets sit at page level)', () => {
        render(
            <FilterShell>
                <EntityListPage<SampleRow>
                    header={{ title: 'Practices' }}
                    table={{
                        data: sampleRows,
                        columns: sampleColumns,
                        getRowId: (r) => r.id,
                    }}
                >
                    <div data-testid="page-child-modal">My Modal</div>
                </EntityListPage>
            </FilterShell>,
        );
        expect(
            screen.getByTestId('page-child-modal').textContent,
        ).toBe('My Modal');
    });
});
