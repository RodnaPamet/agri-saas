/**
 * `useCoarsePointer` — ONE answer, and it is SUBSCRIBED (#2828).
 *
 * The hook replaced three mechanisms (two byte-identical copies and a viewport
 * query wearing a coarse-pointer docblock), so what it owes a test is the
 * property the extraction was for and the one the `useSyncExternalStore` shape
 * was for:
 *
 *   1. it answers the OR query, not a width probe;
 *   2. it answers on the FIRST render, with no effect-driven flash;
 *   3. it RE-ANSWERS when the device changes, because a tablet with a
 *      detachable keyboard or a paired mouse flips this at runtime and a stale
 *      value leaves the user on the wrong gesture until remount.
 *
 * Property 3 is why this is not a one-liner: a `useState` + `useEffect` draft
 * passes 1 and 2 and fails 3 silently, which is the shape that would be
 * reintroduced by somebody "simplifying" the hook.
 */
import { render, screen, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

import { useCoarsePointer, COARSE_POINTER_QUERY } from '@/components/ui/hooks/use-coarse-pointer';

import { restoreViewport } from './viewport';

function Probe() {
    const coarse = useCoarsePointer();
    return <span data-testid="answer">{coarse ? 'coarse' : 'fine'}</span>;
}

/** A controllable `matchMedia`, so the `change` listener can be fired. */
function installMatchMedia(initial: boolean) {
    const listeners = new Set<() => void>();
    let matches = initial;
    const asked: string[] = [];
    window.matchMedia = ((query: string) => {
        asked.push(query);
        return {
            get matches() { return matches; },
            media: query,
            onchange: null,
            addEventListener: (_: string, fn: () => void) => listeners.add(fn),
            removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
            addListener: (fn: () => void) => listeners.add(fn),
            removeListener: (fn: () => void) => listeners.delete(fn),
            dispatchEvent: () => true,
        } as unknown as MediaQueryList;
    }) as unknown as typeof window.matchMedia;
    return {
        asked,
        set(next: boolean) {
            matches = next;
            act(() => { listeners.forEach((fn) => fn()); });
        },
        get listenerCount() { return listeners.size; },
    };
}

afterEach(restoreViewport);

it('answers COARSE on a touch device, on the first render', () => {
    const mq = installMatchMedia(true);
    render(<Probe />);
    // No `waitFor`: the value must be right in the FIRST committed frame, or a
    // phone briefly renders the desktop branch. An effect-driven hook would
    // need a tick here, which is exactly what this asserts it does not.
    expect(screen.getByTestId('answer')).toHaveTextContent('coarse');
    expect(mq.asked).toContain(COARSE_POINTER_QUERY);
});

it('answers FINE on a mouse device', () => {
    installMatchMedia(false);
    render(<Probe />);
    // The control. Without it, "coarse" above is satisfied by a hook that
    // returns true unconditionally.
    expect(screen.getByTestId('answer')).toHaveTextContent('fine');
});

it('RE-ANSWERS when the device changes — the reason it is subscribed', () => {
    const mq = installMatchMedia(false);
    render(<Probe />);
    expect(screen.getByTestId('answer')).toHaveTextContent('fine');
    // A tablet whose keyboard was just detached. A `useState` + `useEffect`
    // draft reads once and never hears this.
    mq.set(true);
    expect(screen.getByTestId('answer')).toHaveTextContent('coarse');
    mq.set(false);
    expect(screen.getByTestId('answer')).toHaveTextContent('fine');
});

it('UNSUBSCRIBES on unmount', () => {
    const mq = installMatchMedia(true);
    const { unmount } = render(<Probe />);
    expect(mq.listenerCount).toBe(1);
    unmount();
    // A listener per mount with no teardown is a leak on every surface that
    // mounts a tooltip, which is most of them.
    expect(mq.listenerCount).toBe(0);
});

it('answers FINE on the SERVER, whatever the client would say', () => {
    // MUTATION-PROVED INTO EXISTENCE: flipping `getServerSnapshot` from
    // `() => false` to `() => true` reddened nothing, because jsdom always has
    // a `window` and the server snapshot is only read during SSR and
    // hydration. `renderToString` is the one path that reaches it.
    //
    // It must be `false` even on a device that IS coarse — the stub below says
    // `matches: true` — because the server cannot know the device, and a
    // server emitting the touch branch that then hydrates to the desktop one
    // is a hydration mismatch on every mouse user's first paint.
    installMatchMedia(true);
    expect(renderToString(<Probe />)).toContain('fine');
});

it('answers FINE when matchMedia is ABSENT, rather than throwing', () => {
    // Old Safari and any non-browser renderer. FINE is the safe direction:
    // every touch affordance in this product is an enhancement over a control
    // that is in the DOM regardless, so a wrong `false` costs a gesture while
    // a wrong `true` would hide the control behind one.
    const saved = window.matchMedia;
    // @ts-expect-error — deleting the API is the condition under test.
    delete window.matchMedia;
    try {
        render(<Probe />);
        expect(screen.getByTestId('answer')).toHaveTextContent('fine');
    } finally {
        window.matchMedia = saved;
    }
});
