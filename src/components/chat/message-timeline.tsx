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

import { VirtualizedList } from '@/components/ui/virtualized-list';
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

export function MessageTimeline({
    messages,
    myUserId,
    firstUnreadId = null,
    senderLabel,
    onRequestReactions,
    now,
    virtualize,
    height,
    className,
}: MessageTimelineProps) {
    const rows = React.useMemo(
        () => buildTimelineRows(messages, myUserId, firstUnreadId),
        [messages, myUserId, firstUnreadId],
    );

    const threshold =
        typeof virtualize === 'object' ? virtualize.threshold : TIMELINE_VIRTUALIZE_THRESHOLD;
    const windowed = virtualize === false ? false : rows.length > threshold;

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
            <div className={cn('flex-1', className)} data-timeline-mode="virtualized">
                <VirtualizedList
                    itemCount={rows.length}
                    dynamicRowHeight={{ defaultRowHeight: ESTIMATED_ROW_PX }}
                    height={height}
                    width="100%"
                    renderItem={({ index, style }) => (
                        <div style={style} key={rows[index].key}>
                            {renderRow(rows[index])}
                        </div>
                    )}
                />
            </div>
        );
    }

    return (
        <div
            className={cn('flex flex-col px-default py-default', className)}
            data-timeline-mode="plain"
        >
            {rows.map((row) => (
                <React.Fragment key={row.key}>{renderRow(row)}</React.Fragment>
            ))}
        </div>
    );
}
