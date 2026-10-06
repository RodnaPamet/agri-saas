'use client';

/**
 * Drag-to-dismiss for the mobile nav drawer (P2.5).
 *
 * The drawer already closed on Escape, on a backdrop tap, and on route change.
 * What it did not do is the gesture every native sheet has: push it back off
 * the edge it came from. On a phone held one-handed the backdrop is the part of
 * the screen a thumb reaches LAST, so "tap outside to close" is the most
 * awkward affordance available.
 *
 * ── the two things that make this feel wrong if you skip them ──
 *
 * 1. **Axis commitment.** The drawer scrolls vertically. If every touch moved
 *    the panel, a flick down the nav list would drag the whole sheet sideways.
 *    So the first `slop` pixels decide: whichever axis moved more wins, and a
 *    vertical decision makes this hook stand down for the rest of the gesture.
 *    Deciding per-move instead of once would let a diagonal scroll oscillate.
 *
 * 2. **Transition suppression.** The panel carries a 300ms CSS transition for
 *    open/close. Left on during a drag it lags the finger by exactly that, and
 *    reads as lag rather than as a slow animation. `dragging` is for the caller
 *    to disable the transition while a finger is down and restore it on release
 *    so the snap-back and the close still animate.
 *
 * ── why a velocity term as well as a distance term ──
 *
 * Distance alone means a quick flick that travels 40px does nothing, which
 * feels broken because the gesture was decisive. Velocity alone means a slow,
 * deliberate push most of the way across does nothing, which feels worse. Both,
 * with either sufficient, is what the platform sheets do.
 *
 * Touch only, deliberately: a mouse has the backdrop and Escape, and claiming
 * mousedown here would fight text selection and drag-and-drop for no gain.
 */
import { useCallback, useRef, useState } from 'react';

export interface SwipeToCloseOptions {
    /** Only while the sheet is open. A closed sheet must not track touches. */
    enabled: boolean;
    onClose: () => void;
    /**
     * Which way the sheet leaves. The nav drawer enters from the left, so it
     * dismisses leftward and a rightward pull must not drag it off its hinge.
     */
    direction?: 'left' | 'right';
    /** Pixels before the gesture commits to an axis. */
    slop?: number;
    /** Fraction of the panel's width past which release dismisses. */
    closeRatio?: number;
    /** px/ms that dismisses regardless of distance. */
    flickVelocity?: number;
}

export interface SwipeToClose {
    /** Spread onto the panel. */
    handlers: {
        onTouchStart: (e: React.TouchEvent) => void;
        onTouchMove: (e: React.TouchEvent) => void;
        onTouchEnd: () => void;
        onTouchCancel: () => void;
    };
    /** Current offset in px — `0`, or negative/positive per `direction`. */
    dragX: number;
    /** A finger is down and has committed to the horizontal axis. */
    dragging: boolean;
}

export function useSwipeToClose({
    enabled,
    onClose,
    direction = 'left',
    slop = 8,
    closeRatio = 0.4,
    flickVelocity = 0.5,
}: SwipeToCloseOptions): SwipeToClose {
    const [dragX, setDragX] = useState(0);
    const [dragging, setDragging] = useState(false);

    // A ref, not state: these change on every touchmove and nothing renders
    // from them, so state here would be a re-render per frame for no pixels.
    const g = useRef<{
        x0: number;
        y0: number;
        t0: number;
        axis: 'undecided' | 'horizontal' | 'vertical';
        width: number;
        dx: number;
    } | null>(null);

    const reset = useCallback(() => {
        g.current = null;
        setDragX(0);
        setDragging(false);
    }, []);

    const onTouchStart = useCallback(
        (e: React.TouchEvent) => {
            if (!enabled) return;
            const touch = e.touches[0];
            if (!touch) return;
            g.current = {
                x0: touch.clientX,
                y0: touch.clientY,
                // `performance.now()` at BOTH ends of the gesture. `e.timeStamp`
                // reads more naturally here, but it is only guaranteed to share
                // an origin with performance.now() in the browser — under jsdom
                // it can be 0 — and a velocity computed across two clocks is
                // arbitrary. One clock, measured twice.
                t0: performance.now(),
                axis: 'undecided',
                width: (e.currentTarget as HTMLElement).offsetWidth || 1,
                dx: 0,
            };
        },
        [enabled],
    );

    const onTouchMove = useCallback(
        (e: React.TouchEvent) => {
            const s = g.current;
            const touch = e.touches[0];
            if (!enabled || !s || !touch) return;

            const dx = touch.clientX - s.x0;
            const dy = touch.clientY - s.y0;

            if (s.axis === 'undecided') {
                if (Math.abs(dx) < slop && Math.abs(dy) < slop) return;
                // Committed for the rest of the gesture. A vertical commit
                // leaves the list free to scroll normally.
                s.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
                if (s.axis === 'horizontal') setDragging(true);
            }
            if (s.axis !== 'horizontal') return;

            // Only toward the edge the sheet came from. Clamping at 0 rather
            // than allowing a rubber-band keeps the panel on its hinge.
            const toward = direction === 'left' ? Math.min(0, dx) : Math.max(0, dx);
            s.dx = toward;
            setDragX(toward);
        },
        [direction, enabled, slop],
    );

    const onTouchEnd = useCallback(() => {
        const s = g.current;
        if (!enabled || !s) return reset();
        if (s.axis !== 'horizontal') return reset();

        const travelled = Math.abs(s.dx);
        // Guard the divisor: a panel measured at 0 width (jsdom, or a sheet
        // mid-mount) would make every gesture a dismissal.
        const far = travelled >= Math.max(1, s.width) * closeRatio;
        const elapsed = Math.max(1, performance.now() - s.t0);
        const fast = travelled / elapsed >= flickVelocity;

        reset();
        if (far || fast) onClose();
    }, [closeRatio, enabled, flickVelocity, onClose, reset]);

    return {
        handlers: {
            onTouchStart,
            onTouchMove,
            onTouchEnd,
            onTouchCancel: reset,
        },
        dragX,
        dragging,
    };
}
