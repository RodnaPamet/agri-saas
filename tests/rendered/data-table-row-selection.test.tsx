/**
 * Regression — selecting a row highlights it + fills the checkbox.
 *
 * The memoized row used to compare `prevRow.getIsSelected() ===
 * nextRow.getIsSelected()` in its `React.memo` equality fn. Both
 * calls read the LIVE table state, so right after a toggle they were
 * always equal → the row never re-rendered → `data-selected` stayed
 * `false` and the circular checkbox stayed unchecked (the
 * "selecting a row doesn't highlight" bug, most visible on the
 * practice Tasks tab where the row highlight is the only selection
 * feedback). The fix threads an `isSelected` SNAPSHOT prop captured
 * at parent-render time and compares THAT. These tests lock it in.
 */
import * as React from 'react';
import { render, fireEvent } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn() }),
    usePathname: () => '/x',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({}),
}));

import { DataTable, createColumns } from '@/components/ui/table';
import type { Row } from '@tanstack/react-table';

interface RowT {
    id: string;
    name: string;
}
const data: RowT[] = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Bravo' },
];
const columns = createColumns<RowT>([
    {
        id: 'name',
        header: 'Name',
        accessorFn: (r) => r.name,
        cell: ({ getValue }) => <span>{getValue<string>()}</span>,
    },
]);

function selectCell(tr: HTMLElement) {
    return tr.querySelector('[title="Select"]') as HTMLElement;
}

describe('<DataTable> row selection highlight', () => {
    it('uncontrolled: clicking the select cell highlights the row + checks the box', () => {
        const { container } = render(
            <DataTable<RowT>
                data={data}
                columns={columns}
                getRowId={(r) => r.id}
                selectionEnabled
            />,
        );
        const tr = container.querySelector('tbody tr') as HTMLElement;
        expect(tr.getAttribute('data-selected')).toBe('false');

        fireEvent.click(selectCell(tr));

        expect(tr.getAttribute('data-selected')).toBe('true');
        expect(
            tr
                .querySelector('[aria-label="Select row"]')
                ?.getAttribute('data-state'),
        ).toBe('checked');
    });

    it('controlled: parent state drives the row highlight', () => {
        function Wrap() {
            const [sel, setSel] = React.useState<Record<string, boolean>>({});
            return (
                <DataTable<RowT>
                    data={data}
                    columns={columns}
                    getRowId={(r) => r.id}
                    selectionEnabled
                    selectedRows={sel}
                    onRowSelectionChange={(rows: Row<RowT>[]) =>
                        setSel(Object.fromEntries(rows.map((r) => [r.id, true])))
                    }
                />
            );
        }
        const { container } = render(<Wrap />);
        const tr = container.querySelector('tbody tr') as HTMLElement;

        fireEvent.click(selectCell(tr));

        expect(tr.getAttribute('data-selected')).toBe('true');
    });

    it('toggles back off — highlight clears on a second click', () => {
        const { container } = render(
            <DataTable<RowT>
                data={data}
                columns={columns}
                getRowId={(r) => r.id}
                selectionEnabled
            />,
        );
        const tr = container.querySelector('tbody tr') as HTMLElement;
        fireEvent.click(selectCell(tr));
        expect(tr.getAttribute('data-selected')).toBe('true');
        fireEvent.click(selectCell(tr));
        expect(tr.getAttribute('data-selected')).toBe('false');
    });
});
