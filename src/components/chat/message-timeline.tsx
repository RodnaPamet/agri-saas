'use client';

/**
 * The DM timeline — P8.3 (#2797).
 *
 * It takes messages OLDEST-FIRST (which is the order `readConversation`
 * returns after its reverse) and flattens them into a row list: day pills,
 * one «Нови съобщения» divider, and the bubbles. Flattening first is what
 * makes windowing possible at all — react-window addresses rows by index, so
 * a nested "day → messages" structure has no index to address.
 *
 * ## Three decisions worth knowing
 *
 * **`virtualize` mirrors `DataTable`, threshold and all.** Owner ruling
 * 2026-11-07: virtualize above 1000 rows. That is `DataTable`'s raised
 * threshold rather than a second number, because a farm with 1,200 messages in
 * one thread and a farm with 1,200 journal rows are the same problem, and two
 * thresholds is how one of them drifts. Below it the rows are plain DOM, which
 * keeps browser find-in-page and ⌘F working on every normal thread.
 *
 * **The divider's position comes from a cursor the CALLER holds still.**
 * `firstUnreadId` is a prop, not something derived from `lastReadAt` here — if
 * this component recomputed it, marking the thread read while the operator is
 * looking at it would make the divider vanish under their eyes, which is the
 * one thing a "new messages" marker must not do. The caller freezes it on
 * mount and releases it when the thread is left.
 *
 * **Grouping is by (sender, day), and the day half is not redundant.** Two
 * messages from the same person either side of midnight must not be grouped,
 * because a day pill is rendered between them and a grouped bubble renders
 * with no sender label and tight spacing — so it would read as a continuation
 * across a visible date boundary.
 */
import * as React from 'react';

import {
    VirtualizedList,
    type VirtualizedListHandle,
} from '@/components/ui/virtualized-list';
import { cn } from '@/lib/cn';

import { chatDayKey, DayPill } from './day-pill';
import { MessageBubble, type MessageBubbleProps } from './message-bubble';
import { NewMessagesDivider } from './new-messages-divider';

/** Mirrors `DataTable`'s raised auto-virtualization threshold. */
export const TIMELINE_VIRTUALIZE_THRESHOLD = 1000;

/**
 * Estimated row height for the windowed branch's FIRST paint only. Every row
 * is measured after mount by `dynamicRowHeight`, so this number decides
 * nothing after the first frame — it is the scrollbar's initial guess.
 */
const ESTIMATED_ROW_PX = 64;

export interface TimelineMessage {
    id: string;
    senderUserId: string;
    body: string;
    createdAt: Date | string;
    editedAt?: Date | string | null;
    deletedAt?: Date | string | null;
    reactions?: MessageBubbleProps['reactions'];
}

type Row =
    | { kind: 'day'; key: string; at: Date }
    | { kind: 'divider'; key: string }
    | {
          kind: 'message';
          key: string;
          message: TimelineMessage;
          mine: boolean;
          grouped: boolean;
      };

/**
 * Where the reader was, named by ROW rather than by pixel offset (#2826).
 *
 * A scroll offset is meaningless across a prepend: inserting a page of older
 * messages above the viewport moves every row down by a distance nobody knows
 * until the rows are measured. The row IDENTITY survives, so that is what is
 * recorded, plus how far below the top of the viewport it was sitting.
 */
export interface TimelineAnchor {
    /** The `Row.key` that was topmost in the viewport. */
    readonly key: string;
    /** Its distance below the top of the viewport, in pixels. */
    readonly offsetInViewport: number;
}

export interface MessageTimelineHandle {
    /**
     * Record the topmost visible row. Null when there is nothing to anchor to
     * — an empty timeline, or a scroll element that has not mounted.
     */
    anchor(): TimelineAnchor | null;
    /** Put that row back where it was. A no-op if it is no longer rendered. */
    restore(anchor: TimelineAnchor | null): void;
}

/**
 * The arithmetic, as a pure function, because the DOM half cannot be tested
 * where there is no layout engine.
 *
 * `rowTop` is the row's top in the SCROLL CONTENT's coordinates — which is
 * what changes across a prepend — and the result is the `scrollTop` that puts
 * it back at `offsetInViewport` below the viewport's top edge. Clamped at 0:
 * a prepend can leave the anchor nearer the top than it was (the reader was
 * already at the very top and asked for more), and a negative `scrollTop` is
 * silently coerced by the browser, which would make a wrong answer look right.
 */
export function anchoredScrollTop(rowTop: number, offsetInViewport: number): number {
    return Math.max(0, rowTop - offsetInViewport);
}

/**
 * A row's top in scroll-content coordinates.
 *
 * `offsetTop` in the PLAIN branch, where rows are laid out by flow. The
 * windowed branch absolute-positions rows from an inline `style.top`, and
 * reads that in preference — not as a jsdom accommodation but because it is
 * the authority there: react-window writes the position it decided, while
 * `offsetTop` is the browser's reading of it and is 0 before layout.
 */
export function rowTopOf(el: HTMLElement): number {
    const inline = el.style.top;
    if (inline && inline.endsWith('px')) {
        const parsed = Number.parseFloat(inline);
        if (Number.isFinite(parsed)) return parsed;
    }
    return el.offsetTop;
}

export interface MessageTimelineProps {
    /** Oldest-first. */
    messages: readonly TimelineMessage[];
    /** The reading user; decides which side each bubble sits on. */
    myUserId: string;
    /**
     * Id of the first message the reader has not seen, or null for none. Held
     * still by the caller — see the header.
     */
    firstUnreadId?: string | null;
    /** Resolves a sender id to a display name for a non-grouped bubble. */
    senderLabel?: (senderUserId: string) => string | undefined;
    /**
     * Open the reaction picker for one message. Passed per-message to the
     * bubble, which owns both the long-press gesture and the focusable control
     * that must accompany it. Omitted ⇒ neither renders.
     */
    onRequestReactions?: (messageId: string) => void;
    /** Clock for "today"/"yesterday". Injected so a test can fix it. */
    now?: Date;
    /** `false` forces plain DOM, `{ threshold }` overrides the default. */
    virtualize?: boolean | { threshold: number };
    /** Forwarded to the windowed list; jsdom has no layout engine. */
    height?: number;
    className?: string;
}

function asDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
}

/**
 * Exported for the rendered test, which asserts the row SHAPE rather than
 * re-deriving it: the grouping and divider rules are the deliverable here, and
 * asserting them through the DOM alone cannot tell "grouped" from "the label
 * happened to be undefined".
 */
export function buildTimelineRows(
    messages: readonly TimelineMessage[],
    myUserId: string,
    firstUnreadId?: string | null,
): Row[] {
    const rows: Row[] = [];
    let previousDayKey: string | null = null;
    let previousSender: string | null = null;

    for (const message of messages) {
        const at = asDate(message.createdAt);
        const dayKey = chatDayKey(at);

        if (dayKey !== previousDayKey) {
            rows.push({ kind: 'day', key: `day:${dayKey}`, at });
            // A day pill breaks a run: the next bubble shows its sender again.
            previousSender = null;
            previousDayKey = dayKey;
        }

        if (firstUnreadId && message.id === firstUnreadId) {
            rows.push({ kind: 'divider', key: 'divider' });
            // So does the divider — a bubble immediately under it must carry
            // its sender, or the first unread message reads as a continuation
            // of something the reader has already seen.
            previousSender = null;
        }

        rows.push({
            kind: 'message',
            key: message.id,
            message,
            mine: message.senderUserId === myUserId,
            grouped: previousSender === message.senderUserId,
        });
        previousSender = message.senderUserId;
    }

    return rows;
}

export const MessageTimeline = React.forwardRef<
    MessageTimelineHandle,
    MessageTimelineProps
>(function MessageTimeline({
    messages,
    myUserId,
    firstUnreadId = null,
    senderLabel,
    onRequestReactions,
    now,
    virtualize,
    height,
    className,
}: MessageTimelineProps, ref) {
    const rows = React.useMemo(
        () => buildTimelineRows(messages, myUserId, firstUnreadId),
        [messages, myUserId, firstUnreadId],
    );

    const threshold =
        typeof virtualize === 'object' ? virtualize.threshold : TIMELINE_VIRTUALIZE_THRESHOLD;
    const windowed = virtualize === false ? false : rows.length > threshold;

    /**
     * THE SCROLL ELEMENT, owned here in BOTH branches — which is the seam
     * #2826 had to move.
     *
     * The page used to wrap this component in its own `overflow-y-auto`, which
     * worked only because nothing paged up: the windowed branch scrolls
     * ITSELF, so with both branches live there were two scrollers and a
     * prepend had to be anchored in whichever one happened to be real. One
     * element, one answer.
     *
     * In the plain branch this div IS the scroller. In the windowed branch it
     * is a static wrapper and `scrollerRef` is pointed at react-window's own
     * element instead, through the imperative handle below.
     */
    const plainScroller = React.useRef<HTMLDivElement | null>(null);
    const listRef = React.useRef<VirtualizedListHandle | null>(null);
    const windowedWrapper = React.useRef<HTMLDivElement | null>(null);

    /** Whichever element actually scrolls, for the branch that is rendered. */
    const scrollElement = React.useCallback((): HTMLElement | null => {
        if (!windowed) return plainScroller.current;
        // react-window's list element is the scroller in this branch. It is
        // reached through the DOM rather than a second imperative hop, because
        // `VirtualizedListHandle` deliberately exposes only `scrollToItem` /
        // `scrollTo` and widening it would make a windowing-engine swap a
        // bigger change (Epic 68's two-seam rule).
        const wrapper = windowedWrapper.current;
        if (!wrapper) return null;
        return wrapper.querySelector<HTMLElement>('[data-virtualized-viewport]')
            ?? (wrapper.firstElementChild as HTMLElement | null);
    }, [windowed]);

    React.useImperativeHandle(ref, () => ({
        anchor(): TimelineAnchor | null {
            const scroller = scrollElement();
            if (!scroller) return null;
            const top = scroller.scrollTop;
            // The TOPMOST row whose bottom is still below the viewport's top
            // edge — the one the reader is looking at. A row scrolled just
            // past is the wrong anchor: restoring to it would scroll the
            // reader backwards by its height.
            const candidates = scroller.querySelectorAll<HTMLElement>('[data-row-key]');
            for (const el of candidates) {
                const rowTop = rowTopOf(el);
                if (rowTop + el.offsetHeight > top) {
                    return { key: el.dataset.rowKey!, offsetInViewport: rowTop - top };
                }
            }
            return null;
        },
        restore(anchor: TimelineAnchor | null): void {
            if (!anchor) return;
            const scroller = scrollElement();
            if (!scroller) return;
            const el = scroller.querySelector<HTMLElement>(
                `[data-row-key="${CSS.escape(anchor.key)}"]`,
            );
            // No-op when the anchor row is no longer rendered. In the windowed
            // branch a prepend keeps it rendered — it was visible — and in the
            // plain branch every row is in the DOM. A missing element means
            // the row was deleted between the two calls, and guessing a
            // position for it would be worse than leaving the reader put.
            if (!el) return;
            scroller.scrollTop = anchoredScrollTop(rowTopOf(el), anchor.offsetInViewport);
        },
    }), [scrollElement]);

    const renderRow = React.useCallback(
        (row: Row) => {
            if (row.kind === 'day') return <DayPill at={row.at} now={now} />;
            if (row.kind === 'divider') return <NewMessagesDivider />;
            return (
                <MessageBubble
                    body={row.message.body}
                    createdAt={asDate(row.message.createdAt)}
                    editedAt={row.message.editedAt ? asDate(row.message.editedAt) : null}
                    deletedAt={row.message.deletedAt ? asDate(row.message.deletedAt) : null}
                    mine={row.mine}
                    grouped={row.grouped}
                    senderLabel={
                        row.mine || row.grouped ? undefined : senderLabel?.(row.message.senderUserId)
                    }
                    reactions={row.message.reactions}
                    onRequestReactions={
                        onRequestReactions
                            ? () => onRequestReactions(row.message.id)
                            : undefined
                    }
                />
            );
        },
        [now, senderLabel, onRequestReactions],
    );

    if (windowed) {
        return (
            <div
                ref={windowedWrapper}
                className={cn('min-h-0 flex-1', className)}
                data-timeline-mode="virtualized"
            >
                <VirtualizedList
                    ref={listRef}
                    itemCount={rows.length}
                    dynamicRowHeight={{ defaultRowHeight: ESTIMATED_ROW_PX }}
                    height={height}
                    width="100%"
                    renderItem={({ index, style }) => (
                        // `data-row-key` is what `anchor()` / `restore()` look
                        // rows up by. It is the row's own key rather than an
                        // index because an index is exactly what a prepend
                        // invalidates — which is the whole defect.
                        <div style={style} key={rows[index].key} data-row-key={rows[index].key}>
                            {renderRow(rows[index])}
                        </div>
                    )}
                />
            </div>
        );
    }

    return (
        <div
            ref={plainScroller}
            className={cn(
                'min-h-0 flex-1 overflow-y-auto px-default py-default',
                'flex flex-col',
                className,
            )}
            data-timeline-mode="plain"
        >
            {rows.map((row) => (
                <div key={row.key} data-row-key={row.key}>
                    {renderRow(row)}
                </div>
            ))}
        </div>
    );
});
