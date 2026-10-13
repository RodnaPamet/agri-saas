/** @jest-environment jsdom */
/**
 * Breadcrumbs context value identity — #1471.
 *
 * `BreadcrumbsProvider` read its trail as `stack[stack.length - 1] ?? []`.
 * A non-empty stack was always stable, because `push` stores the caller's
 * array by reference and the subscript hands that same reference back. The
 * FALLBACK was the unstable half: an empty stack produced a brand-new `[]`
 * on every render, `items` is a dependency of the `api` memo, and `api` is
 * the context value — so every provider render published a new context value
 * and re-rendered every consumer.
 *
 * An empty stack is the common case, not an edge one: it is what any page
 * that never calls `useBreadcrumbs` leaves behind.
 *
 * Why identity and not render counts. A context consumer re-renders when the
 * value changes, so "how many times did this component re-render" measures
 * the same thing one level removed, and would also move for reasons that have
 * nothing to do with this fix. The array instance is the thing that was
 * wrong, so the array instance is what these assert.
 *
 * `useBreadcrumbs` documents its effect deps as "ctx is stable
 * per-provider-mount". That comment was false while the stack was empty.
 * The first test is what makes it checkable rather than aspirational.
 */
import { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import {
    BreadcrumbsProvider,
    useBreadcrumbs,
    useCurrentBreadcrumbs,
} from '@/components/layout/breadcrumbs-store';
import type { BreadcrumbItem } from '@/components/ui/breadcrumbs';

/** Records the array instance handed to a consumer on each render. */
function makeProbe(seen: ReadonlyArray<BreadcrumbItem>[]) {
    return function Probe() {
        seen.push(useCurrentBreadcrumbs());
        return null;
    };
}

describe('BreadcrumbsProvider context identity', () => {
    it('hands back the same empty trail across provider re-renders', () => {
        const seen: ReadonlyArray<BreadcrumbItem>[] = [];
        const Probe = makeProbe(seen);
        let bump!: () => void;

        function Harness() {
            const [n, setN] = useState(0);
            bump = () => setN(n + 1);
            return (
                <BreadcrumbsProvider>
                    <Probe />
                </BreadcrumbsProvider>
            );
        }

        render(<Harness />);
        const afterFirst = seen.length;
        act(() => bump());
        act(() => bump());

        // The consumer really did render again — without this the identity
        // assertion below would pass on a single sample and prove nothing.
        expect(seen.length).toBeGreaterThan(afterFirst);
        expect(new Set(seen).size).toBe(1);
    });

    it('hands back a stable empty trail with no provider mounted', () => {
        const seen: ReadonlyArray<BreadcrumbItem>[] = [];
        const Probe = makeProbe(seen);
        let bump!: () => void;

        function Harness() {
            const [n, setN] = useState(0);
            bump = () => setN(n + 1);
            return <Probe />;
        }

        render(<Harness />);
        const afterFirst = seen.length;
        act(() => bump());

        expect(seen.length).toBeGreaterThan(afterFirst);
        expect(new Set(seen).size).toBe(1);
    });

    it('still surfaces a pushed trail, and restores the empty one on unmount', () => {
        const TRAIL: BreadcrumbItem[] = [{ label: 'Fields', href: '/fields' }];

        function Pusher() {
            useBreadcrumbs(TRAIL);
            return null;
        }
        function Display() {
            const items = useCurrentBreadcrumbs();
            return <span data-testid="trail">{items.map((i) => i.label).join('>')}</span>;
        }
        function Harness({ pushing }: { pushing: boolean }) {
            return (
                <BreadcrumbsProvider>
                    {pushing ? <Pusher /> : null}
                    <Display />
                </BreadcrumbsProvider>
            );
        }

        const { rerender } = render(<Harness pushing />);
        expect(screen.getByTestId('trail')).toHaveTextContent('Fields');

        rerender(<Harness pushing={false} />);
        expect(screen.getByTestId('trail')).toBeEmptyDOMElement();
    });
});
