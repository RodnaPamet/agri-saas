'use client';

/**
 * `<SwipeRow>` — swipe a list row left to reveal one destructive action.
 *
 * Built for the journal list, where a farmer on a phone expects the gesture
 * every native list ships. It is deliberately a PLATFORM primitive rather than
 * a journal-local one: `MobileCardList` renders every card list in the product,
 * so a per-page implementation would have to reach inside it anyway.
 *
 * ## The revealed control is a real button, and that is the accessibility story
 *
 * A swipe is invisible to a keyboard and to a screen reader, so a swipe-only
 * delete is a delete some people cannot perform. The action here is a focusable
 * `<button>` that lives in the DOM whether or not anyone has swiped: the
 * gesture SLIDES THE CARD ASIDE to expose it, and Tab reaches it regardless.
 * The gesture is an enhancement over a control, never the control itself.
 *
 * That also decides the markup. The button sits BEHIND the card in the stacking
 * order rather than being conditionally rendered, because a control that
 * appears only after a gesture cannot be tabbed to before it.
 *
 * ## Why the gesture is coarse-pointer only
 *
 * `usePullToRefresh` attaches on `(pointer: coarse)` for the reason that a
 * mouse user has never expected to drag a row sideways, and a horizontal
 * mouse-drag is how text gets selected. Desktop reaches the same action through
 * the table's own actions column. Same split here.
 *
 * ## It commits nothing
 *
 * `onAction` fires on release past the threshold and that is all this component
 * does. The undo window, the optimistic removal and the write belong to the
 * caller — on the journal that is `useToastWithUndo`, the Epic 67 convention,
 * so a swipe is recoverable for five seconds. A primitive that deleted
 * something itself would make every future caller inherit one policy.
 */

import {
    useCallback,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';
import { haptic } from '@/lib/haptics';
import { useMediaQuery } from './hooks/use-media-query';
import { useReducedMotion } from './hooks/use-reduced-motion';

/**
 * Pixels dragged left before a release commits.
 *
 * 96px rather than a fraction of the row: a short row and a long row should
 * take the same deliberate movement, and a percentage makes a narrow card
 * dangerously easy to clear. Roughly two thumb-widths, and well past the ~10px
 * at which a vertical scroll is still the likelier intent.
 */
const COMMIT_THRESHOLD = 96;

/** How far the card can travel, so the action stays the width it reveals. */
const MAX_TRAVEL = 128;

/**
 * Horizontal movement before the gesture is treated as a swipe at all.
 *
 * Below this a touch is still a tap or the start of a vertical scroll. Claiming
 * the pointer earlier makes a list that fights the user's attempt to scroll it.
 */
const DIRECTION_LOCK = 12;

export interface SwipeRowProps {
    children: ReactNode;
    /**
     * Fired once, on release past the threshold. The caller owns what that
     * means — including the undo window.
     */
    onAction: () => void;
    /** Names the action for the button, the screen reader and the tooltip. */
    actionLabel: string;
    /** Rendered inside the revealed button; decorative. */
    actionIcon?: ReactNode;
    /** When set, the row neither swipes nor exposes a button. */
    disabled?: boolean;
    className?: string;
}

export function SwipeRow({
    children,
    onAction,
    actionLabel,
    actionIcon,
    disabled = false,
    className,
}: SwipeRowProps) {
    const { isMobile } = useMediaQuery();
    const reducedMotion = useReducedMotion();
    const [offset, setOffset] = useState(0);
    const [dragging, setDragging] = useState(false);
    const startX = useRef<number | null>(null);
    const locked = useRef(false);
    const passed = useRef(false);

    const reset = useCallback(() => {
        startX.current = null;
        locked.current = false;
        passed.current = false;
        setDragging(false);
        setOffset(0);
    }, []);

    const onPointerDown = useCallback(
        (e: ReactPointerEvent<HTMLDivElement>) => {
            // Touch only, and primary pointer only. A mouse drag on a row is a
            // text selection, and `pointerType` is the honest discriminator —
            // `isMobile` answers about the VIEWPORT, which a desktop browser
            // narrowed to a phone width also satisfies.
            if (disabled || e.pointerType === 'mouse' || !e.isPrimary) return;
            startX.current = e.clientX;
        },
        [disabled],
    );

    const onPointerMove = useCallback(
        (e: ReactPointerEvent<HTMLDivElement>) => {
            if (startX.current === null) return;
            const dx = e.clientX - startX.current;

            if (!locked.current) {
                // Only a LEFTWARD drag past the lock claims the gesture.
                // Rightward movement is left alone so a horizontal scroll
                // container inside a row keeps working.
                if (dx > -DIRECTION_LOCK) return;
                locked.current = true;
                setDragging(true);
            }

            const next = Math.max(-MAX_TRAVEL, Math.min(0, dx));
            setOffset(next);

            // One tap of feedback as the gesture becomes committal, and only
            // on the crossing — not on every pixel past it.
            if (!passed.current && next <= -COMMIT_THRESHOLD) {
                passed.current = true;
                haptic('tap');
            } else if (passed.current && next > -COMMIT_THRESHOLD) {
                passed.current = false;
            }
        },
        [],
    );

    const onPointerUp = useCallback(() => {
        if (startX.current === null) return;
        const commit = offset <= -COMMIT_THRESHOLD;
        reset();
        if (commit) onAction();
    }, [offset, onAction, reset]);

    // Desktop keeps its table actions; nothing here applies.
    if (!isMobile || disabled) {
        return <div className={className}>{children}</div>;
    }

    return (
        <div className={cn('relative overflow-hidden', className)}>
            {/* BEHIND the card and always in the DOM, so Tab reaches it with
                no gesture at all. `justify-end` keeps it under the edge the
                card slides away from. */}
            <div className="absolute inset-0 flex items-stretch justify-end">
                <button
                    type="button"
                    aria-label={actionLabel}
                    title={actionLabel}
                    onClick={onAction}
                    className="flex w-32 items-center justify-center gap-tight bg-bg-error-emphasis text-content-inverted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    {actionIcon}
                    <span className="text-xs font-medium">{actionLabel}</span>
                </button>
            </div>

            <div
                // `touch-action: pan-y` lets the browser keep vertical
                // scrolling while we take the horizontal axis. Without it the
                // list stops scrolling wherever a row is being dragged.
                className={cn(
                    'relative touch-pan-y bg-bg-default',
                    !dragging && !reducedMotion && 'transition-transform duration-150',
                )}
                style={{ transform: `translateX(${offset}px)` }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={reset}
            >
                {children}
            </div>
        </div>
    );
}
