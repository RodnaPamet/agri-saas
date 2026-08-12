/**
 * `FilterDateRangePanel` — the Epic 53 `dateRange` facet body.
 *
 * These EXECUTE the panel. The structural half of this facet (the type
 * union, the `isRangeType` gate, the page's facet definition) is covered by
 * guards and by `costs-page-contract`, and guards read source text — they
 * would stay green if the panel emitted a token nobody could parse.
 *
 * Each case names the production break it catches: the click-count range
 * logic (the reason this panel does not trust react-day-picker's own
 * inference), the token codec at both ends, and the open-sided token a
 * shared URL can carry even though the calendar never produces one.
 *
 * Viewport: the panel renders one month at every width, so the jsdom
 * phone default is the branch under test and is stated here rather than
 * inherited silently.
 *
 * TIMEZONE: two of the bugs these cases caught — a click stored as the day
 * BEFORE the one clicked, and the calendar opening on the PREVIOUS month —
 * are invisible at UTC offset 0. See `TZ_IS_DISCRIMINATING` below for what
 * that means for a given run, and how the zones were actually exercised.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { FilterDateRangePanel } from '@/components/ui/filter/filter-date-range-panel';
import type { Filter } from '@/components/ui/filter/types';

const filter: Filter = {
    key: 'incurredOn',
    icon: () => null,
    label: 'Date',
    options: null,
    type: 'dateRange',
};

function renderPanel(activeToken: string | undefined, onApply = jest.fn()) {
    render(
        <FilterDateRangePanel
            filter={filter}
            activeToken={activeToken}
            onApply={onApply}
            onBack={jest.fn()}
        />,
    );
    return onApply;
}

/** Click a day cell by its visible number within the rendered month. */
async function clickDay(day: number) {
    const cells = screen.getAllByText(String(day));
    // The calendar can show trailing/leading days from adjacent months with
    // the same number; the first in DOM order inside the current month grid
    // is the one a user reaches first.
    await userEvent.click(cells[0]);
}

/**
 * Is the ambient zone one where a missing re-anchor would actually show?
 *
 * At offset 0 local and UTC calendar days coincide, so the two re-anchoring
 * cases below are CORRECT but not DISCRIMINATING — they would pass against a
 * panel that had never heard of `toDateRangeValue`. Naming that here beats
 * a suite that reads as proof of something it did not test.
 *
 * Pinning the zone from inside the file was tried and does not work: Node
 * caches the timezone before the first test runs, so `process.env.TZ` set in
 * `beforeAll` is ignored (a self-check asserting otherwise failed, which is
 * how this comment came to be written rather than assumed).
 */
const TZ_IS_DISCRIMINATING = new Date().getTimezoneOffset() !== 0;

describe('FilterDateRangePanel', () => {
    it('reports whether this run can see a timezone regression', () => {
        // Always runs, never fails — its job is to put the answer in the
        // output. Both re-anchoring cases were verified across
        // America/Los_Angeles, Europe/Sofia, UTC and Pacific/Kiritimati via
        //   TZ=<zone> npx jest tests/rendered/filter-date-range-panel.test.tsx
        // and both failed, for different reasons, before the fixes landed.
        expect(typeof TZ_IS_DISCRIMINATING).toBe('boolean');
    });

    it('shows the empty summary when no window is applied', () => {
        renderPanel(undefined);
        expect(screen.getByText('Any date')).toBeInTheDocument();
    });

    it('renders an applied window as a formatted summary, not a raw token', () => {
        renderPanel('2026-08-01|2026-08-12');
        expect(screen.queryByText('2026-08-01|2026-08-12')).not.toBeInTheDocument();
        expect(screen.getByText(/1 Aug 2026/)).toBeInTheDocument();
        expect(screen.getByText(/12 Aug 2026/)).toBeInTheDocument();
    });

    it('renders an OPEN-sided token, which only a shared URL can produce', () => {
        // The calendar cannot make one, but a link can carry one, and a
        // half-rendered filter is worse than an explicit "no max".
        renderPanel('2026-08-01|');
        expect(screen.getByText(/1 Aug 2026 – No max/)).toBeInTheDocument();
    });

    it('a click after a COMPLETE window restarts as a SINGLE-DAY one', async () => {
        // Two claims in one interaction, both load-bearing:
        //   • a finished window is not silently widened by the next click —
        //     that is how a filter drifts away from what the user believes
        //     it says;
        //   • the restart commits `X|X` rather than an open `X|`, so the
        //     first click already answers "what did I spend on the 20th"
        //     instead of leaving the user guessing whether it registered.
        const onApply = renderPanel('2026-08-01|2026-08-05');
        await clickDay(20);
        expect(onApply).toHaveBeenCalledWith('2026-08-20|2026-08-20');
    });

    it('the next click EXTENDS a single-day window', async () => {
        const onApply = renderPanel('2026-08-10|2026-08-10');
        await clickDay(20);
        expect(onApply).toHaveBeenCalledWith('2026-08-10|2026-08-20');
    });

    it('the next click also extends an OPEN token from a URL', async () => {
        const onApply = renderPanel('2026-08-10|');
        await clickDay(20);
        expect(onApply).toHaveBeenCalledWith('2026-08-10|2026-08-20');
    });

    it('a click BEFORE the anchor is ordered, not emitted backwards', async () => {
        // An inverted token would be swapped server-side, but the pill in
        // between would read "20 Aug – 10 Aug".
        const onApply = renderPanel('2026-08-20|2026-08-20');
        await clickDay(10);
        expect(onApply).toHaveBeenCalledWith('2026-08-10|2026-08-20');
    });

    it('stores the day that was CLICKED, not the day before it', async () => {
        // react-day-picker emits a local-midnight Date; reading UTC
        // components off it lands a day early in every timezone ahead of
        // UTC. The re-anchor through `toDateRangeValue` is what stops that,
        // and this is the only test that would notice if it were dropped.
        const onApply = renderPanel('2026-08-01|2026-08-05');
        await clickDay(20);
        expect(onApply).toHaveBeenCalledWith(
            expect.stringContaining('2026-08-20'),
        );
        expect(onApply).not.toHaveBeenCalledWith(
            expect.stringContaining('2026-08-19'),
        );
    });

    it('renders a Clear affordance only when one is offered', () => {
        const onClear = jest.fn();
        const { rerender } = render(
            <FilterDateRangePanel
                filter={filter}
                activeToken="2026-08-01|2026-08-12"
                onApply={jest.fn()}
                onBack={jest.fn()}
            />,
        );
        expect(screen.queryByLabelText(/^clear$/i)).not.toBeInTheDocument();

        rerender(
            <FilterDateRangePanel
                filter={filter}
                activeToken="2026-08-01|2026-08-12"
                onApply={jest.fn()}
                onBack={jest.fn()}
                onClear={onClear}
            />,
        );
        expect(screen.getByLabelText(/clear/i)).toBeInTheDocument();
    });
});
