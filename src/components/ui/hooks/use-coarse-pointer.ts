'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * The media query, in ONE place.
 *
 * An OR: `(hover: none)` catches a device that cannot hover at all, and
 * `(pointer: coarse)` catches one whose primary pointer is a finger. Either is
 * enough to mean "a touch affordance belongs here" — a stylus tablet reports a
 * FINE pointer and still cannot hover, and a touch laptop hovers with a
 * trackpad while a finger is the pointer in use.
 *
 * Exported so a test can install a stub against the exact string the hook
 * asks for. jsdom's `matchMedia` is a project-wide stub answering
 * `matches: false` to every query, so a test meaning the touch branch has to
 * override it, and a test that spelled the query itself would drift from this
 * one silently.
 */
export const COARSE_POINTER_QUERY = '(hover: none), (pointer: coarse)';

/**
 * Is this a touch device? ONE answer, for every consumer.
 *
 * ## Why this is a module and not three copies (#2828)
 *
 * It was three. `tooltip.tsx` had a module-private copy, P8.3 added a
 * byte-for-byte equivalent inside `use-long-press.ts`, and `<SwipeRow>` asked
 * `useMediaQuery().isMobile` — a VIEWPORT width question — while its own
 * docblock argued for a coarse pointer. Two spellings of one policy is how two
 * answers diverge, and the concrete risk was never the query string drifting:
 * it is the next consumer importing whichever copy it happens to find, and a
 * later fix landing on only one of them.
 *
 * ## `useSyncExternalStore`, not `useState` + `useEffect`
 *
 * The media-query list IS an external store, and reading it through this hook
 * gives the right value on the FIRST render rather than after an effect — so
 * there is no first-frame flash of the desktop branch on a phone. It also
 * keeps every consumer off `react-hooks/set-state-in-effect`, which the
 * `useState` + `useEffect` shape trips, and the lint gate is a CEILING so a
 * new warning is a real cost.
 *
 * The server snapshot is `false`. A missing answer must read as "not a touch
 * device", because every touch affordance in this product is an ENHANCEMENT
 * over a control that is in the DOM regardless — so a wrong `false` costs a
 * gesture and a wrong `true` would hide the control behind one.
 *
 * ## What does NOT use this, deliberately
 *
 * `usePullToRefresh` and `src/lib/view-transitions` both check
 * `(pointer: coarse)` ALONE, one-shot, inside an effect or a predicate. That
 * is a NARROWER query and a different question — "attach this gesture / run
 * this transition on this device right now" rather than "render a touch
 * affordance" — and folding them in here would WIDEN both to include a
 * no-hover device reporting a fine pointer. #2828's own table called all the
 * copies identical; measured, they are two policies, and unifying them is a
 * behaviour change nobody has asked for.
 * `tests/guards/one-coarse-pointer-detector.test.ts` records those two sites
 * with that reason, so the distinction is a written decision rather than an
 * omission.
 */
export function useCoarsePointer(): boolean {
    const subscribe = useCallback((onChange: () => void) => {
        if (typeof window === 'undefined' || !window.matchMedia) return () => {};
        const mq = window.matchMedia(COARSE_POINTER_QUERY);
        // Safari < 14 only has the deprecated listener API.
        if (mq.addEventListener) {
            mq.addEventListener('change', onChange);
            return () => mq.removeEventListener('change', onChange);
        }
        mq.addListener(onChange);
        return () => mq.removeListener(onChange);
    }, []);

    return useSyncExternalStore(
        subscribe,
        () =>
            typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia(COARSE_POINTER_QUERY).matches,
        () => false,
    );
}
