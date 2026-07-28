/**
 * Coverage wave 14 — `FilterRangePanel` (Epic 53 range filter).
 *
 * The panel shipped with zero executing tests: eight `tests/guards/*`
 * specs reference it, but those scan the file as TEXT and never mount
 * it, so every decision point below was unprotected.
 *
 * These are behavioural, not coverage-shaped. Each case names the
 * production break it catches — the keyboard contract (step, clamp,
 * field-to-field caret movement, Escape scoping), the commit contract
 * (Enter / blur / empty / rejected parse), and the normalisation
 * contract (an inverted range must be swapped, never emitted
 * backwards). The mobile-keyboard case guards `inputMode`, which is
 * load-bearing for a product used one-handed in a field.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
    FilterRangePanel,
    type FilterRangePanelProps,
} from '@/components/ui/filter/filter-range-panel';
import type { Filter } from '@/components/ui/filter/types';

function makeFilter(overrides: Partial<Filter> = {}): Filter {
    return {
        key: 'amount',
        icon: () => null,
        label: 'Amount',
        options: null,
        type: 'range',
        ...overrides,
    };
}

function renderPanel(props: Partial<FilterRangePanelProps> = {}) {
    const onApply = jest.fn();
    const onBack = jest.fn();
    const onCloseOuter = jest.fn();

    const view = render(
        <FilterRangePanel
            filter={makeFilter()}
            activeToken={undefined}
            onApply={onApply}
            onBack={onBack}
            onCloseOuter={onCloseOuter}
            {...props}
        />,
    );

    return { onApply, onBack, onCloseOuter, ...view };
}

const minInput = () =>
    screen.getByLabelText('Minimum value') as HTMLInputElement;
const maxInput = () =>
    screen.getByLabelText('Maximum value') as HTMLInputElement;

describe('FilterRangePanel — commit contract', () => {
    it('commits a typed minimum as a range token on Enter', async () => {
        // Break: Enter no longer wired to commitDraft — typing a bound
        // and hitting Enter would silently apply nothing.
        const user = userEvent.setup();
        const { onApply } = renderPanel();

        await user.click(minInput());
        await user.keyboard('500{Enter}');

        expect(onApply).toHaveBeenCalledWith('500|');
    });

    it('commits a typed maximum when the field loses focus', async () => {
        // Break: dropping onBlur — a user who clicks straight from the
        // input to another filter loses the bound they just typed.
        const user = userEvent.setup();
        const { onApply } = renderPanel();

        await user.click(maxInput());
        await user.keyboard('250');
        await user.tab();

        expect(onApply).toHaveBeenCalledWith('|250');
    });

    it('emits a token without the bound when an applied bound is cleared', async () => {
        // Break: the `raw === ""` -> onCommit(undefined) path. Without
        // it, clearing the min field cannot widen an applied range.
        const user = userEvent.setup();
        const { onApply } = renderPanel({ activeToken: '100|500' });

        expect(minInput()).toHaveValue('100');

        await user.clear(minInput());
        await user.tab();

        expect(onApply).toHaveBeenCalledWith('|500');
    });

    it('swaps an inverted range instead of emitting it backwards', async () => {
        // Break: dropping normalizeRangeBounds' swap. A user typing
        // min=500 against an applied max=100 would emit "500|100",
        // which matches no rows at all.
        const user = userEvent.setup();
        const { onApply } = renderPanel({ activeToken: '|100' });

        await user.click(minInput());
        await user.keyboard('500{Enter}');

        expect(onApply).toHaveBeenCalledWith('100|500');
    });

    it('applies nothing and restores the previous value when the parser rejects the input', async () => {
        // Break: dropping the Number.isFinite guard would emit a token
        // built from NaN, poisoning the URL filter state.
        const user = userEvent.setup();
        const { onApply } = renderPanel({
            activeToken: '100|',
            filter: makeFilter({ parseRangeInput: () => Number.NaN }),
        });

        await user.clear(minInput());
        await user.keyboard('7{Enter}');

        expect(onApply).not.toHaveBeenCalled();
        expect(minInput()).toHaveValue('100');
    });
});

describe('FilterRangePanel — keyboard stepping', () => {
    it('raises the bound one step on ArrowUp and lowers it on ArrowDown', async () => {
        // Break: an inverted delta sign — ArrowUp would decrement.
        const user = userEvent.setup();
        renderPanel();

        await user.click(minInput());
        await user.keyboard('{ArrowUp}');
        expect(minInput()).toHaveValue('1');

        await user.keyboard('{ArrowDown}');
        expect(minInput()).toHaveValue('0');
    });

    it('never steps a bound below zero', async () => {
        // Break: dropping Math.max(0, ...) would produce "-1", a
        // negative bound no amount/area filter can mean.
        const user = userEvent.setup();
        renderPanel();

        await user.click(minInput());
        await user.keyboard('{ArrowDown}');

        expect(minInput()).toHaveValue('0');
    });

    it('steps a decimal-scaled filter by hundredths', async () => {
        // Break: integer stepping on a money filter (storage in cents)
        // would jump a whole unit per keypress.
        const user = userEvent.setup();
        renderPanel({ filter: makeFilter({ rangeDisplayScale: 100 }) });

        await user.click(minInput());
        await user.keyboard('{ArrowUp}');

        expect(minInput()).toHaveValue('0.01');
    });

    it('honours an explicit rangeNumberStep over the scale default', async () => {
        // Break: ignoring the filter's declared step.
        const user = userEvent.setup();
        renderPanel({ filter: makeFilter({ rangeNumberStep: 25 }) });

        await user.click(minInput());
        await user.keyboard('{ArrowUp}');

        expect(minInput()).toHaveValue('25');
    });
});

describe('FilterRangePanel — navigation contract', () => {
    it('returns to the filter list when Backspace is pressed in an empty min field', async () => {
        // Break: dropping onEmptyMinBackspace — the keyboard-only path
        // back to the filter list disappears.
        const user = userEvent.setup();
        const { onBack } = renderPanel();

        await user.click(minInput());
        await user.keyboard('{Backspace}');

        expect(onBack).toHaveBeenCalled();
    });

    it('edits rather than navigating when Backspace is pressed in a non-empty min field', async () => {
        // Break: dropping the `draft === ""` guard would eject the user
        // out of the panel mid-edit on every deletion.
        const user = userEvent.setup();
        const { onBack } = renderPanel();

        await user.click(minInput());
        await user.keyboard('500{Backspace}');

        expect(onBack).not.toHaveBeenCalled();
        expect(minInput()).toHaveValue('50');
    });

    it('moves focus to the max field on ArrowRight at the end of the min field', async () => {
        // Break: dropping onFocusNextField / the caret check — the two
        // bounds stop behaving as one continuous control.
        const user = userEvent.setup();
        renderPanel();

        await user.click(minInput());
        await user.keyboard('500{ArrowRight}');

        expect(maxInput()).toHaveFocus();
    });

    it('moves focus back to the min field on ArrowLeft at the start of the max field', async () => {
        // Break: dropping onFocusPreviousField — no way back leftward.
        const user = userEvent.setup();
        renderPanel();

        await user.click(maxInput());
        await user.keyboard('{ArrowLeft}');

        expect(minInput()).toHaveFocus();
    });

    it('returns to the filter list on Backspace outside the inputs', () => {
        // Break: dropping the capture handler entirely. Dispatched
        // directly at the separator so the event ORIGINATES outside an
        // input — the panel auto-focuses the min field on mount, so a
        // user-event keystroke would be swallowed by that field and
        // never reach the branch under test.
        const { onBack } = renderPanel();

        fireEvent.keyDown(screen.getByText('to'), { key: 'Backspace' });

        expect(onBack).toHaveBeenCalled();
    });

    it('ignores Delete pressed inside an input rather than navigating away', () => {
        // Break: dropping the capture handler's `closest("input, ...")`
        // bail-out would hijack every in-field deletion and eject the
        // user out of the panel mid-edit.
        const { onBack } = renderPanel({ activeToken: '100|500' });

        fireEvent.keyDown(minInput(), { key: 'Delete' });

        expect(onBack).not.toHaveBeenCalled();
    });
});

describe('FilterRangePanel — Escape scoping', () => {
    it('closes the whole filter on Escape once both bounds are applied', async () => {
        // Break: dropping the rangeFullyApplied conditional would leave
        // a finished range one extra keystroke from dismissal.
        const user = userEvent.setup();
        const { onCloseOuter } = renderPanel({ activeToken: '100|500' });

        await user.click(minInput());
        await user.keyboard('{Escape}');

        expect(onCloseOuter).toHaveBeenCalled();
    });

    it('leaves the filter open on Escape while the range is incomplete', async () => {
        // Break: always passing onCloseFilter would dismiss the panel
        // while the user is still half-way through entering a range.
        const user = userEvent.setup();
        const { onCloseOuter } = renderPanel({ activeToken: '100|' });

        await user.click(minInput());
        await user.keyboard('{Escape}');

        expect(onCloseOuter).not.toHaveBeenCalled();
    });
});

describe('FilterRangePanel — chrome', () => {
    it('offers Clear only when the caller supplies a clear handler', async () => {
        // Break: rendering an inert Clear button on a filter that has
        // nothing to clear.
        const user = userEvent.setup();
        const onClear = jest.fn();

        const { unmount } = renderPanel();
        expect(
            screen.queryByRole('button', { name: 'Clear' }),
        ).not.toBeInTheDocument();
        unmount();

        renderPanel({ onClear });
        await user.click(screen.getByRole('button', { name: 'Clear' }));
        expect(onClear).toHaveBeenCalled();
    });

    it('requests a numeric keypad for whole-number filters and a decimal one for scaled filters', () => {
        // Break: a mobile user gets the wrong on-screen keyboard and
        // cannot type a decimal amount at all.
        const { unmount } = renderPanel();
        expect(minInput()).toHaveAttribute('inputMode', 'numeric');
        unmount();

        renderPanel({ filter: makeFilter({ rangeDisplayScale: 100 }) });
        expect(minInput()).toHaveAttribute('inputMode', 'decimal');
    });

    it('returns to the filter list from the header back button', async () => {
        // Break: the pointer-user path back to the list.
        const user = userEvent.setup();
        const { onBack } = renderPanel();

        await user.click(
            screen.getByRole('button', { name: 'Back to filter list' }),
        );

        expect(onBack).toHaveBeenCalled();
    });
});
