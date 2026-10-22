/**
 * `MobileCardList`'s `swipeAction` seam, and the control it exposes (#2175).
 *
 * The gesture itself is pointer physics and jsdom has no touch, so what is
 * asserted here is the half that matters for correctness and for people who
 * never swipe: whether a revealed, focusable button exists, whether it fires,
 * and whether a row the caller refuses gets no control at all.
 *
 * ## A swipe-only delete is a delete some people cannot perform
 *
 * `<SwipeRow>` keeps the action in the DOM as a real `<button>` whether or not
 * anyone has swiped — the gesture slides the card aside to expose it. That is
 * the accessibility story and it is also what makes it testable without
 * synthesising pointer events: if the button were conditionally rendered on a
 * gesture, neither a keyboard nor this suite could reach it.
 *
 * ## Two blocks rather than one parametrisation
 *
 * The first draft ran every case over both viewports and asserted the button
 * on each. The desktop halves failed, and they were right to: `DataTable`
 * renders the TABLE above the breakpoint, and `<SwipeRow>` is coarse-pointer
 * only because a horizontal mouse-drag is how text gets selected. So desktop
 * gets its own block asserting the absence, which states the split instead of
 * pretending the two presentations answer alike.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { setViewport, restoreViewport, type Viewport } from './viewport';

import { DataTable, createColumns } from '@/components/ui/table';

interface Row {
    id: string;
    title: string;
    locked?: boolean;
}

const DATA: Row[] = [
    { id: 'a', title: 'Пръскане — блок А' },
    { id: 'b', title: 'Торене — блок Б', locked: true },
];

const columns = createColumns<Row>([
    {
        accessorKey: 'title',
        header: 'Заглавие',
        meta: { mobileCard: { slot: 'title' } },
    },
]);

function mount(swipeAction?: Parameters<typeof DataTable<Row>>[0]['swipeAction']) {
    return render(
        <DataTable<Row>
            data={DATA}
            columns={columns}
            getRowId={(r) => r.id}
            mobileFallback="card"
            swipeAction={swipeAction}
        />,
    );
}

describe('MobileCardList swipeAction — mobile, where the gesture lives', () => {
    beforeEach(() => setViewport('mobile'));
    afterEach(() => restoreViewport());

    it('renders NO action button when swipeAction is absent', () => {
        // The default for every other card list in the product. Adding the
        // seam must not put a destructive control on surfaces that never
        // asked for one.
        mount(undefined);
        expect(screen.queryByRole('button', { name: 'Изтрий' })).toBeNull();
    });

    it('renders NO action button for a row the caller refuses with null', () => {
        mount((row) => (row.original.locked ? null : { label: 'Изтрий', onAction: jest.fn() }));
        // One eligible row, one refused — so exactly one control, not two and
        // not none. A count is what separates "the gate works" from "the seam
        // is dead".
        expect(screen.queryAllByRole('button', { name: 'Изтрий' })).toHaveLength(1);
    });

    it('exposes the action as a REAL button, reachable without any gesture', async () => {
        const onAction = jest.fn();
        mount((row) => (row.original.locked ? null : { label: 'Изтрий', onAction }));

        const button = screen.getByRole('button', { name: 'Изтрий' });
        // Focusable, which a swipe-only affordance would not be.
        button.focus();
        expect(document.activeElement).toBe(button);

        await userEvent.click(button);
        expect(onAction).toHaveBeenCalledTimes(1);
    });

    it('still renders the card content it wraps', () => {
        // The wrapper is introduced around existing markup, so the regression
        // worth guarding is a card that renders the button and loses its body.
        mount(() => ({ label: 'Изтрий', onAction: jest.fn() }));
        expect(screen.getByText('Пръскане — блок А')).toBeInTheDocument();
        expect(screen.getByText('Торене — блок Б')).toBeInTheDocument();
    });
});

describe('the DESKTOP presentation offers no swipe, deliberately', () => {
    beforeEach(() => setViewport('desktop'));
    afterEach(() => restoreViewport());

    /**
     * Two mechanisms agree on this and the test asserts the OBSERVABLE rather
     * than either one: `DataTable` renders the table instead of the card list
     * above the breakpoint, and `<SwipeRow>` is coarse-pointer only because a
     * horizontal mouse-drag is how text gets selected. Desktop reaches the
     * same action through the table's actions column.
     *
     * Written as its own block after the first draft of this suite
     * parametrised over both viewports and asserted the button on each. The
     * desktop halves failed, and they were right to.
     */
    it('renders the rows but no swipe control', () => {
        mount(() => ({ label: 'Изтрий', onAction: jest.fn() }));
        expect(screen.getByText('Пръскане — блок А')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Изтрий' })).toBeNull();
    });
});
