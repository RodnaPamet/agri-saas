'use client';

/**
 * `useSwipeAction` — drag a row sideways and release to reach ONE
 * non-destructive action (#2829, P8.3's second gesture).
 *
 * ## Why not `<SwipeRow>`
 *
 * `<SwipeRow>` reveals a destructive button on a left swipe and waits for a
 * second deliberate tap on it. That shape is right for a delete and wrong for
 * a reply, in three ways at once: a reply is non-destructive, it fires on
 * RELEASE with no button to press, and either direction should work. Bending
 * the existing primitive to cover both would make its one load-bearing
 * property — *a destructive action needs a second, deliberate press* —
 * configurable, and a configurable confirmation is one somebody switches off.
 *
 * So this is a narrow sibling rather than a generalisation. It is a HOOK and
 * not a component because the caller already owns the element: the chat bubble
 * spreads `useLongPress`'s handlers on the same node, and wrapping it in
 * another component would put a second element between the bubble and its
 * press target.
 *
 * ## COMPOSING with `useLongPress` on one element is the caller's job
 *
 * Both hooks return `onPointerDown` / `onPointerMove` / `onPointerUp` /
 * `onPointerCancel`. Spreading `{...a.handlers} {...b.handlers}` silently
 * keeps only the second set — a plain object spread, no composition, no
 * warning — so the first gesture stops working and nothing says so.
 * `composeHandlers` below is the supported way to merge them, and the chat
 * bubble's rendered test asserts BOTH gestures still fire from one element.
 *
 * The two do not fight once composed: a horizontal drag past
 * `useLongPress`'s own move tolerance cancels the hold, so hold means
 * reactions and drag means reply without either needing to know about the
 * other.
 *
 * ## A VERTICAL drag is a scroll, and that is this hook's own rule
 *
 * `useLongPress` cancels on drift in ANY direction, which is all it needs. A
 * swipe cannot: the gesture IS a drift. So the discriminator is dominance —
 * past `thresholdPx` of horizontal travel the gesture fires only if the
 * horizontal component exceeds the vertical one. Without that, flicking the
 * timeline to scroll would file a reply, which is the false-alarm direction
 * and the one a user cannot undo without noticing.
 *
 * ## It fires on RELEASE, so the gesture is abortable
 *
 * Firing at the threshold would make the action unstoppable the moment the
 * thumb crossed a line it cannot see. On release, dragging back under the
 * threshold cancels — which is what makes a gesture with no confirmation step
 * acceptable for a non-destructive action.
 *
 * ## It is COARSE-POINTER ONLY, and never calls `preventDefault()`
 *
 * Both inherited from `useLongPress`, same query string (`useCoarsePointer`),
 * for the same reasons: a mouse user has never expected to drag a message
 * sideways, and #449 put `preventDefault()` on a tooltip trigger's
 * `onPointerDown` and made every wrapped link inert on touch.
 *
 * ## The gesture is an ENHANCEMENT over a control, never the control
 *
 * `<SwipeRow>`'s rule, which this hook inherits and cannot enforce: a gesture
 * is invisible to a keyboard and to a screen reader, so every caller also
 * renders a focusable control for the same action. The caller's rendered test
 * is where that shows.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { PointerEvent as ReactPointerEvent } from 'react';

import { useCoarsePointer } from './use-coarse-pointer';

/**
 * How far sideways before a release counts. 56px is a deliberate thumb
 * movement rather than a wobble, and comfortably past `useLongPress`'s 10px
 * cancel tolerance — so by the time this can fire, the hold has already let go.
 */
export const SWIPE_ACTION_THRESHOLD_PX = 56;

/** How far the row is allowed to follow the thumb, so the drag has a limit. */
export const SWIPE_ACTION_MAX_OFFSET_PX = 72;

export interface UseSwipeActionOptions {
    /** Fired once, on release, when the gesture completed. */
    onSwipe: () => void;
    thresholdPx?: number;
    maxOffsetPx?: number;
    /** Turn the gesture off without unmounting. Defaults to `true`. */
    enabled?: boolean;
}

export interface SwipePointerHandlers {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
}

export interface UseSwipeActionResult {
    handlers: SwipePointerHandlers;
    /**
     * Signed horizontal travel, clamped to `maxOffsetPx`. Negative is a drag
     * to the left. Zero whenever no drag is in progress, so a caller can use
     * it directly as a transform without tracking a separate flag.
     */
    offsetPx: number;
    /** True once the current drag has passed the threshold — for an affordance. */
    armed: boolean;
    /** Whether the gesture is attached at all on this device. */
    coarse: boolean;
}

/**
 * Merge two or more pointer-handler sets so every one of them runs.
 *
 * Exported because the alternative at the call site is an object spread, which
 * keeps only the last set and fails SILENTLY — the first gesture simply stops
 * working. See the docblock above.
 */
export function composeHandlers(...sets: Partial<SwipePointerHandlers>[]): SwipePointerHandlers {
    const call = <K extends keyof SwipePointerHandlers>(key: K) =>
        ((...args: unknown[]) => {
            for (const set of sets) {
                const fn = set[key] as ((...a: unknown[]) => void) | undefined;
                fn?.(...args);
            }
        }) as SwipePointerHandlers[K];
    return {
        onPointerDown: call('onPointerDown'),
        onPointerMove: call('onPointerMove'),
        onPointerUp: call('onPointerUp'),
        onPointerCancel: call('onPointerCancel'),
    };
}

export function useSwipeAction({
    onSwipe,
    thresholdPx = SWIPE_ACTION_THRESHOLD_PX,
    maxOffsetPx = SWIPE_ACTION_MAX_OFFSET_PX,
    enabled = true,
}: UseSwipeActionOptions): UseSwipeActionResult {
    const coarse = useCoarsePointer();
    const [offsetPx, setOffsetPx] = useState(0);
    const origin = useRef<{ x: number; y: number } | null>(null);
    // Read at RELEASE, so the decision is made from the whole gesture rather
    // than from whichever frame the pointer happened to be in. Kept in a ref
    // and not in state because `onPointerUp` must see the latest value in the
    // same tick, and a state update is not visible until the next render.
    const completed = useRef(false);

    const reset = useCallback(() => {
        origin.current = null;
        completed.current = false;
        setOffsetPx(0);
    }, []);

    // A scroll cancels, exactly as it does for a hold. The pointer may not
    // move relative to the SCREEN while the content moves under it, so
    // dominance alone does not catch a flick the browser turned into a scroll.
    useEffect(() => {
        if (offsetPx === 0) return;
        const onScroll = () => reset();
        window.addEventListener('scroll', onScroll, true);
        return () => window.removeEventListener('scroll', onScroll, true);
    }, [offsetPx, reset]);

    useEffect(() => reset, [reset]);

    const active = coarse && enabled;

    const onPointerDown = useCallback(
        (event: ReactPointerEvent<HTMLElement>) => {
            if (!active) return;
            origin.current = { x: event.clientX, y: event.clientY };
            completed.current = false;
        },
        [active],
    );

    const onPointerMove = useCallback(
        (event: ReactPointerEvent<HTMLElement>) => {
            const from = origin.current;
            if (!from) return;
            const dx = event.clientX - from.x;
            const dy = event.clientY - from.y;

            // VERTICAL DOMINANCE ENDS THE GESTURE, and ends it for good rather
            // than merely withholding this frame: a drag that starts as a
            // scroll and curves sideways is a scroll. Withholding per frame
            // would let it complete on the last few pixels.
            if (Math.abs(dy) > Math.abs(dx)) {
                reset();
                return;
            }

            const clamped = Math.max(-maxOffsetPx, Math.min(maxOffsetPx, dx));
            setOffsetPx(clamped);
            // Sticky once armed, so a thumb that overshoots and eases back a
            // few pixels still fires — but dragging back UNDER the threshold
            // clears it, which is what makes the gesture abortable.
            completed.current = Math.abs(dx) >= thresholdPx;
        },
        [maxOffsetPx, reset, thresholdPx],
    );

    const onPointerUp = useCallback(() => {
        const fire = completed.current;
        reset();
        if (fire) onSwipe();
    }, [onSwipe, reset]);

    return {
        handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: reset },
        offsetPx,
        armed: Math.abs(offsetPx) >= thresholdPx,
        coarse,
    };
}
