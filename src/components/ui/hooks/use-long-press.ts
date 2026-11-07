'use client';

/**
 * `useLongPress` — press and hold on a touch device to reach a secondary
 * action (#2797, P8.3).
 *
 * ## It is COARSE-POINTER ONLY, like its two neighbours
 *
 * `usePullToRefresh` and `<SwipeRow>` both attach on a coarse pointer, for the
 * reason that a mouse user has never expected to hold a button down to reveal
 * something — and on a fine pointer the hold would compete with text
 * selection and with the native context menu. Desktop reaches the same action
 * through a real control. Same split here, using the SAME query string as
 * `tooltip.tsx` (`(hover: none), (pointer: coarse)`), so one answer governs
 * every touch affordance in the product rather than two that can disagree.
 *
 * ## The gesture is an ENHANCEMENT over a control, never the control
 *
 * `<SwipeRow>`'s docblock states the rule and this hook inherits it: a gesture
 * is invisible to a keyboard and to a screen reader, so a gesture-only action
 * is an action some people cannot perform. Every caller must also render a
 * focusable control for the same thing. This hook cannot enforce that; the
 * caller's rendered test is where it shows.
 *
 * ## It never calls `preventDefault()`
 *
 * #449 put `preventDefault()` on a tooltip trigger's `onPointerDown` and made
 * every wrapped `<Link>` and `<a download>` inert on touch — a whole class of
 * controls silently stopped working while the tooltip itself looked fine. So
 * nothing here suppresses a default action: a long press that lands on a link
 * still follows the link on release if the press was short, and the hold path
 * simply fires a callback alongside. The consequence to accept is that a long
 * press may also raise the platform's own context menu on some browsers; the
 * alternative cost is the #449 class, which is worse.
 *
 * ## A press that MOVES is a scroll
 *
 * A chat timeline scrolls under the thumb, so a hold that drifts past
 * `moveTolerancePx` cancels. So does a scroll event, a release, and a pointer
 * cancel — four exits, matching the four dismissal paths `tooltip.tsx` is
 * required to keep.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * 500ms. Long enough that a tap cannot reach it (a deliberate tap is ~100ms)
 * and short enough not to feel broken; it is also iOS's own threshold for a
 * text-selection long press, so the two do not fight.
 */
export const LONG_PRESS_MS = 500;

/** Past this much drift the hold is a scroll, not a press. */
const DEFAULT_MOVE_TOLERANCE_PX = 10;

/**
 * Subscribed, not read once: a tablet with a detachable keyboard or a paired
 * mouse flips this at RUNTIME, and a stale value would leave the user on the
 * wrong gesture until remount. `useSyncExternalStore` also answers during
 * render rather than after an effect, so there is no first-frame flash — and
 * it is what keeps this hook off `react-hooks/set-state-in-effect`, which the
 * `useState` + `useEffect` first draft tripped (the lint gate is a CEILING, so
 * a new warning is a real cost).
 *
 * This is the SECOND copy of this detector in the repo — `tooltip.tsx` has a
 * module-private `useCoarsePointer` using the identical query string. Two
 * spellings of one policy is how two answers diverge, so extracting it is
 * tracked on #2828 rather than left unsaid; it is not done HERE because
 * editing `tooltip.tsx` pulls two shape guards into a P8.3 diff.
 */
function useCoarsePointer(): boolean {
    const subscribe = useCallback((onChange: () => void) => {
        if (typeof window === 'undefined' || !window.matchMedia) return () => {};
        const mq = window.matchMedia('(hover: none), (pointer: coarse)');
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
            typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(hover: none), (pointer: coarse)').matches,
        () => false,
    );
}

export interface UseLongPressOptions {
    onLongPress: () => void;
    delayMs?: number;
    moveTolerancePx?: number;
    /** Turn the gesture off without unmounting. Defaults to `true`. */
    enabled?: boolean;
}

export interface UseLongPressResult {
    /** Spread onto the element that should respond to the hold. */
    handlers: {
        onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
        onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
        onPointerUp: () => void;
        onPointerCancel: () => void;
    };
    /** True while a hold is in progress — for a press-state affordance. */
    pressing: boolean;
    /** Whether the gesture is attached at all on this device. */
    coarse: boolean;
}

export function useLongPress({
    onLongPress,
    delayMs = LONG_PRESS_MS,
    moveTolerancePx = DEFAULT_MOVE_TOLERANCE_PX,
    enabled = true,
}: UseLongPressOptions): UseLongPressResult {
    const coarse = useCoarsePointer();
    const [pressing, setPressing] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const origin = useRef<{ x: number; y: number } | null>(null);

    const cancel = useCallback(() => {
        if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
        origin.current = null;
        setPressing(false);
    }, []);

    // A scroll anywhere cancels. The pointer may not move relative to the
    // SCREEN while the content moves under it, so the move tolerance alone
    // does not catch a flick that the browser turned into a scroll.
    useEffect(() => {
        if (!pressing) return;
        const onScroll = () => cancel();
        window.addEventListener('scroll', onScroll, true);
        return () => window.removeEventListener('scroll', onScroll, true);
    }, [pressing, cancel]);

    useEffect(() => cancel, [cancel]);

    const active = coarse && enabled;

    const onPointerDown = useCallback(
        (event: ReactPointerEvent<HTMLElement>) => {
            if (!active) return;
            origin.current = { x: event.clientX, y: event.clientY };
            setPressing(true);
            timer.current = setTimeout(() => {
                timer.current = null;
                origin.current = null;
                setPressing(false);
                onLongPress();
            }, delayMs);
        },
        [active, delayMs, onLongPress],
    );

    const onPointerMove = useCallback(
        (event: ReactPointerEvent<HTMLElement>) => {
            const from = origin.current;
            if (!from) return;
            const drifted =
                Math.abs(event.clientX - from.x) > moveTolerancePx ||
                Math.abs(event.clientY - from.y) > moveTolerancePx;
            if (drifted) cancel();
        },
        [cancel, moveTolerancePx],
    );

    return {
        handlers: { onPointerDown, onPointerMove, onPointerUp: cancel, onPointerCancel: cancel },
        pressing,
        coarse,
    };
}
