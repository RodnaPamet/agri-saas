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
 *
 * **IT IS HERE NOW** — the gesture, the focusable control and the quoted
 * preview all landed together, and that grouping is the point rather than
 * convenience: a swipe with no keyboard path is an action some people cannot
 * perform, and a reply with no visible quote is a message whose context only
 * the sender can see.
 *
 * What is still NOT here is the composer's side of it — holding the quoted
 * message while the operator types, and passing `replyToMessageId` on send.
 * That belongs to the page (P8.4), like the reaction picker and the report
 * dialog, and this component only decides WHEN a reply is asked for.
 *
 * ## Two gestures on one element, and the spread that loses one
 *
 * `useLongPress` (reactions) and `useSwipeAction` (reply) both return
 * `onPointerDown` / `onPointerMove` / `onPointerUp` / `onPointerCancel`.
 * `{...a.handlers} {...b.handlers}` keeps only the second set — a plain object
 * spread, no composition, no warning — so one gesture silently stops working.
 * `composeHandlers` merges them, and the rendered test asserts BOTH still fire
 * from this one node.
 *
 * They do not otherwise compete: a horizontal drag passes `useLongPress`'s
 * 10px move tolerance and cancels the hold, so hold means reactions and drag
 * means reply without either hook knowing about the other.
 */
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { composeHandlers, useLongPress, useSwipeAction } from '@/components/ui/hooks';
import { IconAction } from '@/components/ui/icon-action';
// nucleo, not the legacy icon package — see the note in
// `message-composer.tsx`. `MessageSmile` rather than `FaceSmile`: the
// control reacts to THIS message.
import { ArrowTurnLeft, Flag, MessageSmile } from '@/components/ui/icons/nucleo';
import { cn } from '@/lib/cn';
import { useDateFormat } from '@/lib/i18n/use-date-format';

export interface MessageBubbleProps {
    readonly body: string | null;
    readonly createdAt: Date;
    readonly editedAt?: Date | null;
    readonly deletedAt?: Date | null;
    /**
     * Deleted with no timestamp — see `TimelineMessage.deleted` (#2939). ORed
     * with `deletedAt` rather than replacing it, so the DM path is untouched.
     */
    readonly deleted?: boolean;
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
    /**
     * Quote THIS message in the composer (#2829). The composer's quoted state
     * belongs to the page, as the reaction picker and the report dialog do.
     * Omitted ⇒ neither the gesture nor the button renders.
     *
     * Offered on your OWN message too, unlike «Сигнализирай». Replying to
     * something you said is ordinary in a conversation and carries no
     * ambiguity about which control you meant — the argument that keeps
     * `onRequestReport` off own messages is that `remove` is the control for
     * those, and there is no competing reply control to confuse it with.
     *
     * NOT offered on a deleted message: `replyTo` would render as «изтрито»
     * before anybody read what was being answered, and the API accepts a
     * deleted target precisely so a reply SURVIVES a retraction — not so one
     * can be started against a message with nothing left in it.
     */
    readonly onRequestReply?: () => void;
    /** Accessible name for the reply control. Required when it renders. */
    readonly replyLabel?: string;
    /**
     * The message this one answers, from `DirectMessageView.replyTo`.
     *
     * `deleted` is a FIELD and not inferred from a null `body`, because a
     * photo-only message has a null body too (P8.6 made the column nullable).
     * Reading only `body` would render «изтрито» over a photograph.
     */
    readonly replyTo?: {
        readonly senderLabel?: string | null;
        readonly body: string | null;
        readonly deleted: boolean;
    } | null;
}

export function MessageBubble({
    body,
    createdAt,
    editedAt,
    deletedAt,
    deleted,
    mine,
    grouped = false,
    senderLabel,
    reactions,
    onRequestReactions,
    reactionsLabel,
    onRequestReport,
    reportLabel,
    onRequestReply,
    replyLabel,
    replyTo,
}: MessageBubbleProps) {
    const t = useTranslations('chat');
    const { formatDateTime } = useDateFormat();
    // Either shape counts. A channel post carries the boolean and no date; a
    // direct message carries the date and no boolean.
    const isDeleted = Boolean(deletedAt) || deleted === true;

    // A deleted message has nothing to react to, which is the same reason P5.3
    // does not offer «Сигнализирай» on one.
    const canReact = Boolean(onRequestReactions) && !isDeleted;
    // NOT on your own message and NOT on a deleted one — see the prop's
    // docblock. `mine` is the half a caller would forget.
    const canReport = Boolean(onRequestReport) && !isDeleted && !mine;
    // Own messages INCLUDED — see the prop's docblock for why this one
    // differs from `canReport`.
    const canReply = Boolean(onRequestReply) && !isDeleted;
    const { handlers: pressHandlers, pressing } = useLongPress({
        onLongPress: () => onRequestReactions?.(),
        enabled: canReact,
    });
    const {
        handlers: swipeHandlers,
        offsetPx,
        armed,
    } = useSwipeAction({
        onSwipe: () => onRequestReply?.(),
        enabled: canReply,
    });
    // `composeHandlers`, NEVER two spreads. Both hooks name the same four
    // pointer handlers, and an object spread keeps only the last set — the
    // first gesture then stops working with nothing saying so.
    const gestureHandlers = React.useMemo(
        () => composeHandlers(pressHandlers, swipeHandlers),
        [pressHandlers, swipeHandlers],
    );

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

                {/*
                  * The QUOTE, above the body and inside the same column, so it
                  * moves with the bubble and reads as part of the message
                  * rather than as a sibling of it.
                  *
                  * `replyTo.deleted` is read rather than `!replyTo.body`,
                  * because a photo-only message also has a null body. Both
                  * states render a muted line; only one of them says the
                  * message was taken back.
                  */}
                {replyTo ? (
                    <div
                        className={cn(
                            // `border-l` rather than a full box: a quote is a
                            // fragment of the conversation, not a second
                            // discrete surface, and `border-border-default` is
                            // reserved for those (and carries a downward
                            // budget ratchet).
                            'max-w-full truncate border-l-2 border-border-subtle px-2 py-0.5',
                            'text-xs text-content-muted',
                        )}
                    >
                        {replyTo.senderLabel ? (
                            <span className="font-[560]">{replyTo.senderLabel}: </span>
                        ) : null}
                        {replyTo.deleted ? (
                            <span className="italic">{t('messageDeleted')}</span>
                        ) : (
                            replyTo.body
                        )}
                    </div>
                ) : null}

                <div
                    {...(canReact || canReply ? gestureHandlers : {})}
                    style={offsetPx === 0 ? undefined : { transform: `translateX(${offsetPx}px)` }}
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
                        // A swipe past the threshold is state for the same
                        // reason: it says "release now and this fires".
                        (pressing || armed) && 'border-border-emphasis',
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
                    {canReply ? (
                        // In the DOM always, so Tab reaches it — the rule
                        // `<SwipeRow>` states and `useLongPress` inherits: a
                        // gesture is invisible to a keyboard and to a screen
                        // reader, so a gesture-only action is one some people
                        // cannot perform. `opacity-0` rather than `hidden`,
                        // because hidden is not focusable.
                        //
                        // FIRST of the three controls, matching the order a
                        // reader is most likely to want them in and keeping
                        // the tab order stable as the other two come and go.
                        <IconAction
                            icon={<ArrowTurnLeft />}
                            label={replyLabel ?? t('replyToMessage')}
                            variant="ghost"
                            onClick={onRequestReply}
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
