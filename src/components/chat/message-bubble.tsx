'use client';

/**
 * One message in a conversation — P8.3 (#2797).
 *
 * ## Grouping is a PROP, not something this component works out
 *
 * `grouped` means "the message above this one is from the same sender, close
 * in time" — so this bubble drops the sender line and tightens its top
 * margin. The decision needs the PREVIOUS message, which a single bubble does
 * not have, so the timeline makes it. A component that tried would need the
 * whole list and would re-render all of it on any change.
 *
 * ## A deleted message keeps its place
 *
 * `body` arrives null for a deleted message and the row still renders, with a
 * stated absence. Removing it would renumber the conversation under the other
 * party — and P5.3 needs a deleted message to say so, because «Сигнализирай»
 * is not offered on one and its report snapshot would otherwise be an empty
 * body indistinguishable from a capture failure.
 *
 * ## Edited is shown, not hidden
 *
 * A message silently rewritten after the other person read it is worse than
 * one marked as edited. Same reasoning as the server keeping `editedAt` at
 * all.
 *
 * ## The reaction gesture lives HERE, and it is not the only way in
 *
 * A long press targets ONE message, so it belongs on the bubble rather than on
 * the timeline — putting it on the scroll container would mean hit-testing to
 * find out which bubble was held. `useLongPress` attaches on a coarse pointer
 * only, for `<SwipeRow>`'s reason, and calls `onRequestReactions`.
 *
 * `<SwipeRow>`'s rule comes with it: **a gesture is an enhancement over a
 * control, never the control**. A long-press-only reaction is a reaction a
 * keyboard or screen-reader user cannot make, so the same callback also sits
 * on a real focusable `<button>` that is in the DOM whether or not anybody has
 * pressed anything — revealed on hover and on focus rather than conditionally
 * rendered, because a control that only appears after a gesture cannot be
 * tabbed to before it.
 *
 * Nothing here calls `preventDefault()`. #449 put it on a tooltip trigger's
 * `onPointerDown` and made every wrapped link inert on touch.
 *
 * **Swipe-to-reply is still NOT here, and the reason has changed** (#2829).
 * It used to be that `DirectMessage` carried no `replyToMessageId`, so a reply
 * had nothing to point at; #2880 added the column, its FK and the
 * same-conversation trigger, and the API half now accepts
 * `replyToMessageId` on send and returns a `replyTo` preview on read.
 *
 * What remains is this component's own: the gesture, the FOCUSABLE reply
 * control beside it (the `<IconAction>` rule above — a gesture is invisible to
 * a keyboard and a screen reader), the quoted preview inside the bubble, and a
 * rendered test under a coarse `matchMedia`, since the branch is dead under
 * jsdom's always-false stub. Do not read the API half landing as the gesture
 * being available.
 */
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { useLongPress } from '@/components/ui/hooks';
import { IconAction } from '@/components/ui/icon-action';
// nucleo, not the legacy icon package — see the note in
// `message-composer.tsx`. `MessageSmile` rather than `FaceSmile`: the
// control reacts to THIS message.
import { Flag, MessageSmile } from '@/components/ui/icons/nucleo';
import { cn } from '@/lib/cn';
import { useDateFormat } from '@/lib/i18n/use-date-format';

export interface MessageBubbleProps {
    readonly body: string | null;
    readonly createdAt: Date;
    readonly editedAt?: Date | null;
    readonly deletedAt?: Date | null;
    /** Written by the reader themselves. Decides the side and the tone. */
    readonly mine: boolean;
    /** The message above is from the same sender — drop the sender line. */
    readonly grouped?: boolean;
    /** Shown on the first bubble of a run from the other party. */
    readonly senderLabel?: string | null;
    readonly reactions?: readonly { readonly userId: string; readonly emoji: string }[];
    /**
     * Open the reaction picker for this message. The picker itself belongs to
     * the page (P8.4) — this component decides WHEN it is asked for, not what
     * it contains. Omitted ⇒ neither the gesture nor the button renders.
     */
    readonly onRequestReactions?: () => void;
    /** Accessible name for the reaction control. Required when it renders. */
    readonly reactionsLabel?: string;
    /**
     * «Сигнализирай» for THIS message (#2833). The dialog belongs to the page,
     * as the reaction picker does. Omitted ⇒ no control.
     *
     * Gated HERE rather than by the caller, because P5.3's rule is about the
     * control and not about one surface: it is never offered on your OWN
     * message — `remove` is the control for that, and offering both reads as a
     * choice between them — nor on a DELETED one, which has nothing to capture
     * and whose snapshot would be an empty body indistinguishable from a
     * capture failure. A caller that passes the callback unconditionally still
     * gets the rule.
     */
    readonly onRequestReport?: () => void;
    /** Accessible name for the report control. Required when it renders. */
    readonly reportLabel?: string;
}

export function MessageBubble({
    body,
    createdAt,
    editedAt,
    deletedAt,
    mine,
    grouped = false,
    senderLabel,
    reactions,
    onRequestReactions,
    reactionsLabel,
    onRequestReport,
    reportLabel,
}: MessageBubbleProps) {
    const t = useTranslations('chat');
    const { formatDateTime } = useDateFormat();
    const isDeleted = Boolean(deletedAt);

    // A deleted message has nothing to react to, which is the same reason P5.3
    // does not offer «Сигнализирай» on one.
    const canReact = Boolean(onRequestReactions) && !isDeleted;
    // NOT on your own message and NOT on a deleted one — see the prop's
    // docblock. `mine` is the half a caller would forget.
    const canReport = Boolean(onRequestReport) && !isDeleted && !mine;
    const { handlers, pressing } = useLongPress({
        onLongPress: () => onRequestReactions?.(),
        enabled: canReact,
    });

    // `MessageReaction` is unique on (message, user, emoji), so the server
    // sends one row PER PERSON. Rendering them one-to-one puts three identical
    // 👍 pills on a message three people liked; what a reader wants is one pill
    // with a count. Insertion order is preserved, so the first emoji used stays
    // leftmost as more people join it.
    const reactionCounts = React.useMemo(() => {
        const counts = new Map<string, number>();
        for (const r of reactions ?? []) counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
        return [...counts.entries()];
    }, [reactions]);

    return (
        <div
            className={cn(
                'flex w-full',
                mine ? 'justify-end' : 'justify-start',
                // The group gap, which is the whole visual point of grouping:
                // `tight` within a run, `default` between runs.
                grouped ? 'mt-tight' : 'mt-default',
            )}
        >
            <div className="group flex max-w-[85%] flex-col gap-0.5">
                {!mine && !grouped && senderLabel ? (
                    <span className="px-1 text-xs text-content-muted">{senderLabel}</span>
                ) : null}

                <div
                    {...(canReact ? handlers : {})}
                    className={cn(
                        // `border-border-subtle`, which is the DEFAULT tone
                        // and the three-tone rule's own tie-break ("if you
                        // have to ask, the answer is subtle"). The first draft
                        // reached for `border-border-default` arguing a bubble
                        // is a discrete surface; that tone is reserved for a
                        // card's or table's OUTER border, a modal/sheet
                        // boundary and a popover outline, and it carries a
                        // DOWNWARD budget ratchet — so one more costs an
                        // argument, and a bubble already has a background
                        // that separates it. `border-tone-budget` caught it at
                        // 63 against 62.
                        'rounded-lg border border-border-subtle px-3 py-2 text-sm',
                        // `bg-bg-muted` for the reader's own messages,
                        // `bg-bg-default` for the other party's. Both are real
                        // tokens, which is worth stating because the first
                        // draft reached for an emphasis-flavoured background
                        // that does not exist in the scale — Tailwind drops an
                        // unknown class silently, so every own-message bubble
                        // had no background and nothing failed. The token
                        // names are not spelled here beyond the two in use:
                        // naming a non-existent one in prose is what a class
                        // sweep would then find.
                        mine ? 'bg-bg-muted' : 'bg-bg-default',
                        isDeleted && 'italic text-content-muted',
                        // `border-border-emphasis` is reserved for STATE, and a
                        // message being held IS state — the three-tone rule.
                        pressing && 'border-border-emphasis',
                    )}
                >
                    {isDeleted ? t('messageDeleted') : body}
                </div>

                <div
                    className={cn(
                        'flex items-center gap-tight px-1 text-xs text-content-muted',
                        mine && 'justify-end',
                    )}
                >
                    {/*
                      * `formatDateTime`, never a raw `toLocaleDateString` —
                      * Epic 58. And no `title=`: Epic 56 reserves hover text
                      * for `<Tooltip>` (`no-ad-hoc-tooltip-title` enforces
                      * it), and the first draft's title repeated the visible
                      * string anyway. `dateTime` is the machine-readable
                      * copy, which is what a `<time>` is for.
                      */}
                    <time dateTime={createdAt.toISOString()}>{formatDateTime(createdAt)}</time>
                    {editedAt && !isDeleted ? <span>{t('edited')}</span> : null}
                    {canReact ? (
                        // `IconAction`, not a hand-rolled icon button: it sets
                        // the `aria-label` from the same string the tooltip
                        // shows, and it inherits the #765 coarse-pointer 44px
                        // floor — a tiny tap target on a phone would be the
                        // defect, not the saving.
                        //
                        // In the DOM always, so Tab reaches it; revealed on
                        // hover or focus so a thread is not a wall of buttons.
                        // `opacity-0` keeps it focusable — `hidden` would not.
                        <IconAction
                            icon={<MessageSmile />}
                            label={reactionsLabel ?? t('addReaction')}
                            variant="ghost"
                            onClick={onRequestReactions}
                            className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                        />
                    ) : null}
                    {canReport ? (
                        // Same treatment as the reaction control: in the DOM
                        // always so Tab reaches it, revealed on hover or focus,
                        // `opacity-0` rather than `hidden` because hidden is
                        // not focusable. No gesture for this one — a long press
                        // already means reactions, and two gestures on one
                        // bubble is a guess about which the operator made.
                        <IconAction
                            icon={<Flag />}
                            label={reportLabel ?? t('reportMessage')}
                            variant="ghost"
                            onClick={onRequestReport}
                            className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                        />
                    ) : null}
                </div>

                {reactionCounts.length > 0 ? (
                    <div className={cn('flex gap-tight px-1', mine && 'justify-end')}>
                        {reactionCounts.map(([emoji, count]) => (
                            <span
                                key={emoji}
                                className="rounded-full border border-border-subtle px-1.5 text-xs"
                            >
                                {emoji}
                                {count > 1 ? ` ${count}` : ''}
                            </span>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
