/**
 * A clickable table row is reachable by keyboard.
 *
 * `<tr onClick={…}>` gives no focus stop and no key handling, so every list
 * page that opens a detail sheet or navigates on row click was mouse-only.
 * On the evidence page that meant the entire review workflow, since the row is
 * how a record is opened.
 *
 * This is a RENDERED test on purpose. A guard could grep `table.tsx` for
 * `tabIndex` and pass forever while the handler did nothing — the point is
 * that pressing Enter on a focused row actually fires the row action, and only
 * executing it can show that.
 *
 * It also pins the two things that are easy to "simplify" away later: `role`
 * must NOT become `button` (that would replace the row's table semantics and
 * cost a screen-reader user the column associations), and Space must be
 * prevented before activating (otherwise the page scrolls out from under
 * whatever the row opens).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { DataTable } from '@/components/ui/table';
import { setViewport, restoreViewport } from './viewport';

interface Row { id: string; name: string }

const DATA: Row[] = [
    { id: 'r-1', name: 'Spray record, block A' },
    { id: 'r-2', name: 'Soil test 2026' },
];

const COLUMNS = [
    {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }: { row: { original: Row } }) => <span>{row.original.name}</span>,
        meta: { mobileCard: { slot: 'title' as const } },
    },
];

// The desktop <table> branch is the subject — under the project-wide jsdom
// stub the app is a PHONE and DataTable renders cards instead, so a test that
// forgot this would assert nothing about rows at all.
beforeEach(() => setViewport('desktop'));
afterEach(restoreViewport);

function renderTable(onRowClick?: (row: { original: Row }) => void) {
    return render(
        <DataTable<Row>
            data={DATA}
            columns={COLUMNS as never}
            getRowId={(r) => r.id}
            {...(onRowClick ? { onRowClick: onRowClick as never } : {})}
        />,
    );
}

function rowFor(text: string): HTMLTableRowElement {
    const cell = screen.getByText(text);
    const row = cell.closest('tr');
    if (!row) throw new Error(`no <tr> around "${text}" — the table branch did not render`);
    return row as HTMLTableRowElement;
}

describe('clickable rows are keyboard-operable', () => {
    it('a clickable row is a focus stop', () => {
        renderTable(() => {});
        expect(rowFor('Spray record, block A')).toHaveAttribute('tabindex', '0');
    });

    it('Enter fires the row action', () => {
        const onRowClick = jest.fn();
        renderTable(onRowClick);
        fireEvent.keyDown(rowFor('Spray record, block A'), { key: 'Enter' });
        expect(onRowClick).toHaveBeenCalledTimes(1);
    });

    it('Space fires the row action and does not scroll', () => {
        const onRowClick = jest.fn();
        renderTable(onRowClick);
        const row = rowFor('Soil test 2026');
        const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
        row.dispatchEvent(event);
        expect(onRowClick).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
    });

    it('ignores keys that are not activation keys', () => {
        const onRowClick = jest.fn();
        renderTable(onRowClick);
        const row = rowFor('Soil test 2026');
        for (const key of ['a', 'Tab', 'ArrowDown', 'Escape']) {
            fireEvent.keyDown(row, { key });
        }
        expect(onRowClick).not.toHaveBeenCalled();
    });

    it('is NOT a focus stop when the row has no action', () => {
        // A non-interactive row must not collect a tab stop — that would put
        // every row of a read-only table into the tab order for nothing.
        renderTable();
        expect(rowFor('Spray record, block A')).not.toHaveAttribute('tabindex');
    });

    it('keeps its table semantics — role is not overridden to button', () => {
        // `role="button"` on a <tr> replaces the row semantics, and a screen
        // reader loses the column associations that make the row readable.
        renderTable(() => {});
        expect(rowFor('Spray record, block A')).not.toHaveAttribute('role', 'button');
    });

    it('a key pressed inside a nested practice belongs to that practice', () => {
        const onRowClick = jest.fn();
        const onButton = jest.fn();
        render(
            <DataTable<Row>
                data={DATA}
                columns={[
                    ...COLUMNS,
                    {
                        id: 'act',
                        header: 'Act',
                        cell: () => <button type="button" onClick={onButton}>Approve</button>,
                    },
                ] as never}
                getRowId={(r) => r.id}
                onRowClick={onRowClick as never}
            />,
        );
        fireEvent.keyDown(screen.getAllByText('Approve')[0], { key: 'Enter' });
        expect(onRowClick).not.toHaveBeenCalled();
    });
});
