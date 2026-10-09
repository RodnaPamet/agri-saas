/**
 * Regression — the row action survives a re-render between the two clicks
 * (#1076).
 *
 * ## The bug
 *
 * With selection on, a single click toggles selection and the row ACTION
 * (navigate to the detail page) was wired to `onDoubleClick` ALONE. The
 * browser fires `dblclick` only when both clicks resolve to the same
 * target, and dispatches it on their nearest common ancestor when they do
 * not — so a React re-render between the clicks, which selection itself
 * causes, can lift the event off the row and the handler never runs.
 *
 * Measured from the Playwright trace of a 3-of-3 retry failure:
 *
 *     performing dblclick action
 *     dblclick action done
 *     waiting for scheduled navigations to finish
 *       navigations have finished        <- immediately: nothing scheduled
 *
 * and in the same failure the row's selection ended at ZERO, so the toggle
 * had fired an EVEN number of times: **both clicks reached `onClick`, and
 * only `dblclick` went missing.** That is why the fix reads the click's own
 * count and why no amount of waiting would have helped.
 *
 * It had taken all three retries twice in one day and blocked three
 * unrelated PRs, and it is an operator-facing bug rather than a test
 * artefact: a farmer double-clicks a row and nothing opens.
 *
 * ## What these tests pin
 *
 * The first is the mechanism and FAILS without the fix — it dispatches the
 * two clicks and NO `dblclick`, which is precisely the state the trace
 * recorded. The rest hold the surrounding contract so the fix cannot buy
 * robustness by firing twice, or by breaking the single-click path.
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

/** 150 rows, enough for the virtualized renderer. */
const manyRows: RowT[] = Array.from({ length: 150 }, (_, i) => ({
    id: `r${i}`,
    name: `Row ${i}`,
}));

function setup(onRowClick: jest.Mock) {
    const { container } = render(
        <DataTable<RowT>
            data={data}
            columns={columns}
            getRowId={(r) => r.id}
            selectionEnabled
            onRowClick={onRowClick}
        />,
    );
    const tr = container.querySelector('tbody tr') as HTMLElement;
    return { tr };
}

describe('<DataTable> row activation (#1076)', () => {
    it('activates from the two CLICKS alone, with no dblclick event at all', () => {
        // The #1076 state verbatim: both clicks land on the row, the
        // browser never synthesises `dblclick`. Before the fix this row
        // toggled twice and did nothing else.
        const onRowClick = jest.fn();
        const { tr } = setup(onRowClick);
        expect(tr.getAttribute('data-selected')).toBe('false');

        fireEvent.click(tr, { detail: 1 });
        expect(onRowClick).not.toHaveBeenCalled();
        expect(tr.getAttribute('data-selected')).toBe('true');

        fireEvent.click(tr, { detail: 2 });

        expect(onRowClick).toHaveBeenCalledTimes(1);
        expect(onRowClick.mock.calls[0][0].original.id).toBe('a');
        // Selection ends where it started — the contract table.tsx has
        // always documented, and the half a naive fix would drop.
        expect(tr.getAttribute('data-selected')).toBe('false');
    });

    it('a full gesture — both clicks AND the dblclick — activates exactly ONCE', () => {
        // The dedupe. Two routes to one action must not mean two actions:
        // a doubled `router.push` is a doubled history entry, and on a
        // destructive row action it would be worse.
        const onRowClick = jest.fn();
        const { tr } = setup(onRowClick);

        fireEvent.click(tr, { detail: 1 });
        fireEvent.click(tr, { detail: 2 });
        fireEvent.doubleClick(tr);

        expect(onRowClick).toHaveBeenCalledTimes(1);
    });

    it('still activates from a bare dblclick with no preceding clicks', () => {
        // `fireEvent.doubleClick` dispatches ONLY `dblclick`, which is why
        // `onDoubleClick` stays wired rather than being replaced. A caller
        // doing this is not exercising a real gesture, but it is what
        // tests/rendered/entity-list-page.test.ts does and it must keep
        // working.
        const onRowClick = jest.fn();
        const { tr } = setup(onRowClick);

        fireEvent.doubleClick(tr);

        expect(onRowClick).toHaveBeenCalledTimes(1);
        // No click preceded it, so nothing toggled and nothing un-toggled.
        expect(tr.getAttribute('data-selected')).toBe('false');
    });

    it('a single click still only selects — it does NOT activate', () => {
        // The other direction, and the one a `detail`-based fix could
        // plausibly break: if the threshold were wrong, every single click
        // would navigate, which is the behaviour selection was given the
        // single click to prevent.
        const onRowClick = jest.fn();
        const { tr } = setup(onRowClick);

        fireEvent.click(tr, { detail: 1 });

        expect(onRowClick).not.toHaveBeenCalled();
        expect(tr.getAttribute('data-selected')).toBe('true');
    });

    it('a click with no detail at all is treated as a single click', () => {
        // `element.click()` and some synthetic dispatches leave `detail` at
        // 0. That must read as one click, never as a gesture.
        const onRowClick = jest.fn();
        const { tr } = setup(onRowClick);

        fireEvent.click(tr);

        expect(onRowClick).not.toHaveBeenCalled();
        expect(tr.getAttribute('data-selected')).toBe('true');
    });

    it('a click on the select cell activates nothing', () => {
        // `isClickOnInteractiveChild` must still short-circuit both paths;
        // the checkbox owns its own click.
        const onRowClick = jest.fn();
        const { tr } = setup(onRowClick);
        const cell = tr.querySelector('[title="Select"]') as HTMLElement;

        fireEvent.click(cell, { detail: 2 });

        expect(onRowClick).not.toHaveBeenCalled();
    });

    describe('the VIRTUALIZED renderer carries the same fix', () => {
        // `virtual-table-body.tsx` holds its own copy of these handlers, so
        // the non-virtual tests above say nothing about it. Worth covering
        // explicitly: this change touched THREE row renderers and I wired two
        // of them on the first pass, which CI caught — the population of row
        // paths is exactly the thing easy to under-count here.
        //
        // `data-table-virtualize.test.tsx` does click a virtual row, but with
        // `selectionEnabled={false}`, which takes the single-click branch.
        // The branch this fix changed is the selection-enabled one.
        function setupVirtual(onRowClick: jest.Mock) {
            const { container } = render(
                <DataTable<RowT>
                    data={manyRows}
                    columns={columns}
                    getRowId={(r) => r.id}
                    selectionEnabled
                    virtualize
                    virtualHeight={600}
                    onRowClick={onRowClick}
                />,
            );
            const row = container.querySelector(
                '[data-virtual-row-index="0"]',
            ) as HTMLElement;
            return { row };
        }

        it('activates from the two clicks alone, with no dblclick', () => {
            const onRowClick = jest.fn();
            const { row } = setupVirtual(onRowClick);
            expect(row).toBeTruthy();

            fireEvent.click(row, { detail: 1 });
            expect(onRowClick).not.toHaveBeenCalled();

            fireEvent.click(row, { detail: 2 });

            expect(onRowClick).toHaveBeenCalledTimes(1);
            expect(onRowClick.mock.calls[0][0].original.id).toBe('r0');
        });

        it('a full gesture activates exactly ONCE', () => {
            const onRowClick = jest.fn();
            const { row } = setupVirtual(onRowClick);

            fireEvent.click(row, { detail: 1 });
            fireEvent.click(row, { detail: 2 });
            fireEvent.doubleClick(row);

            expect(onRowClick).toHaveBeenCalledTimes(1);
        });

        it('a single click still only selects', () => {
            const onRowClick = jest.fn();
            const { row } = setupVirtual(onRowClick);

            fireEvent.click(row, { detail: 1 });

            expect(onRowClick).not.toHaveBeenCalled();
        });
    });

    // The THIRD renderer, `ResizableTableRow`, is NOT covered here and that is
    // stated rather than glossed: it is selected by
    // `applyFixedLayout = enableColumnResizing && sizingFrozen`, and
    // `sizingFrozen` is set from a `useLayoutEffect` measurement that jsdom
    // reports as zero-width, so reaching it in a rendered test is unreliable
    // rather than merely verbose. Its handlers are byte-identical in shape to
    // the non-resizable branch above and share `table-utils`' gesture flag, so
    // the risk is a wiring slip rather than a logic one — which is precisely
    // what caught me once already, so: if you touch row activation, grep for
    // every `onDoubleClick` in `src/components/ui/table/` and count them
    // against the three renderers before trusting a green run.
});
