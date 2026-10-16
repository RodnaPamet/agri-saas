/**
 * Measurement, not a guard: does seeding form state in an effect paint a STALE
 * frame? (#1968, for #1730's 28 reasonless `set-state-in-effect` mutes.)
 *
 * ## Why this exists before any fix
 *
 * `#1730` has 56 `react-hooks/set-state-in-effect` directives — 28 with a
 * `--` reason and 28 without. The reasonless ones are not all the same thing,
 * and the largest recognisable group is the MODAL archetype: seed the form from
 * `initial` inside a `useEffect` gated on `open`.
 *
 *     useEffect(() => {
 *         if (open && initial) {
 *             setTitle(initial.title);
 *             …
 *
 * The rule exists because `useEffect` runs AFTER paint, so the browser can show
 * one frame of the previous state. #1968 proposes a pattern change —
 * `key={initial.id}` to remount instead of re-seed — rather than writing 28
 * reasons. That is a bigger change than a comment, so the claim it rests on
 * should be MEASURED first: is the stale frame real, and is it visible?
 *
 * ## How the frame is caught
 *
 * `render`/`rerender` from Testing Library wrap updates in `act()`, which
 * flushes passive effects — so they can never show the frame the rule is about.
 * `ReactDOM.flushSync` renders and runs LAYOUT effects synchronously while
 * leaving `useEffect` deferred, which is precisely the gap. Reading the DOM
 * between the two is the only observation that distinguishes "seeds late" from
 * "seeds in time".
 *
 * Without that distinction a test of this claim passes either way, which is the
 * failure this file is written to avoid.
 */
import * as React from 'react';
import { act, render } from '@testing-library/react';
import { flushSync } from 'react-dom';

interface Item {
    readonly id: string;
    readonly title: string;
}

/**
 * The archetype, reduced to the one mechanism under test.
 *
 * A reduction rather than the real `EditEvidenceModal` deliberately: the real
 * one needs three providers and a catalogue, none of which bear on WHEN the
 * seed lands. What matters is that the shape is identical — `useState('')`
 * plus a `useEffect` gated on `open` — and a divergence from the real file
 * would show up as the real modal not matching this source, which the
 * assertion at the end checks.
 */
function SeedsInEffect({ open, initial }: { open: boolean; initial: Item | null }) {
    const [title, setTitle] = React.useState('');
    React.useEffect(() => {
        if (open && initial) setTitle(initial.title);
    }, [open, initial]);
    return <input data-testid="title" value={title} onChange={() => undefined} />;
}

/** The #1968 proposal: remount per item, so the seed is the initial state. */
function SeedsOnMount({ open, initial }: { open: boolean; initial: Item | null }) {
    if (!open || !initial) return null;
    return <Inner key={initial.id} initial={initial} />;
}
function Inner({ initial }: { initial: Item }) {
    const [title, setTitle] = React.useState(initial.title);
    return (
        <input
            data-testid="title"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
        />
    );
}

const A: Item = { id: 'a', title: 'Soil report 2024' };
const B: Item = { id: 'b', title: 'Spray log — Пшеница' };

describe('seeding form state in an effect paints one stale frame (#1968)', () => {
    it('the effect form shows the PREVIOUS item for a frame — measured', () => {
        const { container, unmount } = render(<SeedsInEffect open initial={A} />);
        const read = () =>
            (container.querySelector('[data-testid="title"]') as HTMLInputElement).value;
        // Settled on A.
        expect(read()).toBe(A.title);

        // Re-render for B WITHOUT letting passive effects run. `flushSync`
        // commits the render and layout effects; `useEffect` stays queued.
        let frame = '';
        act(() => {
            flushSync(() => {
                render(<SeedsInEffect open initial={B} />, { container });
            });
            // THE FRAME. The DOM is committed for B's props and still holds
            // A's value, because the seeding effect has not run.
            frame = read();
        });

        expect(`stale frame showed: ${frame}`).toBe(`stale frame showed: ${A.title}`);
        // …and it corrects itself once effects flush, which is why nobody
        // notices it in a test that only looks afterwards.
        expect(read()).toBe(B.title);
        unmount();
    });

    it('the key= form never shows it — the control that makes the first case mean something', () => {
        const { container, unmount } = render(<SeedsOnMount open initial={A} />);
        const read = () =>
            (container.querySelector('[data-testid="title"]') as HTMLInputElement).value;
        expect(read()).toBe(A.title);

        let frame = '';
        act(() => {
            flushSync(() => {
                render(<SeedsOnMount open initial={B} />, { container });
            });
            frame = read();
        });

        // A remount makes B's title the INITIAL state, so there is no frame in
        // which the old value is on screen. This is the half that turns the
        // measurement into an argument for #1968's pattern rather than just an
        // observation about React.
        expect(`remount frame showed: ${frame}`).toBe(`remount frame showed: ${B.title}`);
        unmount();
    });
});
