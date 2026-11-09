'use client';

/**
 * One direct conversation, read and written (P8.4, #2798).
 *
 * Composed entirely from P8.3's primitives — `MessageTimeline`,
 * `MessageComposer` — so day grouping, bubble grouping, the «Нови съобщения»
 * divider, the long-press reaction gesture and the keyboard inset all arrive
 * without this file knowing about any of them.
 *
 * ## The read cursor is FROZEN on arrival
 *
 * `firstUnreadId` is computed ONCE, from the `lastReadAt` the first response
 * carried, and then held for the life of the screen. Marking the conversation
 * read is the next thing this component does, so a divider derived from live
 * data would vanish under the reader's eyes a moment after they arrived — the
 * one thing a "new messages" marker must not do. `MessageTimeline` takes it as
 * a prop precisely so the caller owns that decision.
 *
 * ## A REQUEST has three shapes, and only one of them gets a composer
 *
 * `Conversation.state` plus who opened it decides what the bottom of the
 * screen is:
 *
 *   - `ACCEPTED`                     → the composer.
 *   - `REQUEST`, opened by SOMEBODY ELSE → accept / decline. P8.1's rule is
 *     that a stranger gets ONE message until accepted, and that rule lives on
 *     `Conversation.lastMessageAt` being NULL — so the recipient answering is
 *     what opens the conversation, not a second message arriving.
 *   - `REQUEST`, opened by ME        → a stated wait. The server would refuse
 *     a second message, so offering a composer that fails is worse than not
 *     offering one.
 *
 * `DECLINED` never reaches here: the API answers not-found on every content
 * path once a decision is final, so the screen shows the same not-found a
 * missing conversation gets.
 *
 * ## Paging up, and the anchoring it needs (#2826)
 *
 * `readConversation` pages BACKWARD on a `(createdAt, id)` keyset and returns
 * `olderCursor` + `hasOlder`. The newest page comes from SWR and is polled;
 * older pages accumulate HERE, prepended, because a poll must refresh the
 * newest page without discarding what the reader has already pulled in.
 *
 * A prepend cannot be restored by scroll OFFSET. react-window v2 keys its
 * measurement cache by INDEX and v2 removed `itemKey`, so inserting rows above
 * the viewport re-points every cached height at a different message and the
 * estimated extent above the reader is wrong until it has been scrolled
 * through. So the timeline exposes `anchor()` / `restore()` and this page
 * decides WHEN: capture before the fetch, restore after the commit that adds
 * the rows.
 *
 * The policy stays here rather than in the primitive because only the page
 * knows a prepend is happening — a timeline that anchored on every render
 * would impose one policy on every future consumer, which is the argument
 * `<SwipeRow>` makes for committing nothing.
 *
 * ## The counterparty is the sender of a message that is not mine
 *
 * The payload names people only on messages, which is the same constraint P5.3
 * worked under for the exchange thread header, and the same consequence: the
 * block control appears only once the other party has written. That matches
 * the standing rule that you can block somebody who has already written to
 * you, rather than being a limitation to work around.
 *
 * «Сигнализирай» IS here now, PER MESSAGE — #2833 closed the gap it was
 * waiting on. `captureSnapshot` has a `DIRECT_MESSAGE` arm that reads through
 * the Prisma client (so the body decrypts rather than snapshotting `v2:…`) and
 * asserts the reporter is a PARTICIPANT, which no other subject kind has had
 * to do: that capture runs privileged, so without it a crafted id would pull
 * two strangers' private conversation into the moderation queue.
 *
 * It is per-message rather than a header control because a notice names ONE
 * message. The bubble decides whether to offer it — never on your own, never on
 * a deleted one (P5.3) — so this passes the callback unconditionally and does
 * not re-implement that rule.
 *
 * **A moderator cannot REMOVE a direct message** (owner ruling 2026-11-08):
 * suspension is the remedy. So nothing here may promise a takedown; the
 * dialog's existing copy says the notice will be reviewed, which stays true.
 */
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import useSWR from 'swr';

import { MessageComposer } from '@/components/chat/message-composer';
import {
    MessageTimeline,
    type MessageTimelineHandle,
    type TimelineAnchor,
    type TimelineMessage,
} from '@/components/chat/message-timeline';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BlockPersonButton } from '@/components/trust-safety/BlockPersonButton';
import { ReportDialog } from '@/components/trust-safety/ReportDialog';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Heading } from '@/components/ui/typography';
import { apiGet, apiPost } from '@/lib/api-client';
import { useTenantHref } from '@/lib/tenant-context-provider';

interface MessageWire {
    id: string;
    senderUserId: string;
    body: string | null;
    createdAt: string;
    editedAt: string | null;
    deletedAt: string | null;
    reactions: { userId: string; emoji: string }[];
}

interface ConversationWire {
    id: string;
    state: 'REQUEST' | 'ACCEPTED' | 'DECLINED';
    initiatedByUserId: string;
    lastMessageAt: string | null;
    lastReadAt: string | null;
    messages: MessageWire[];
    olderCursor: string | null;
    hasOlder: boolean;
}

export interface DmConversationClientProps {
    readonly conversationId: string;
    readonly myUserId: string;
    /** `social.person-blocks`, resolved server-side — there is no client flags hook. */
    readonly personBlocksEnabled: boolean;
}

export function DmConversationClient({
    conversationId,
    myUserId,
    personBlocksEnabled,
}: DmConversationClientProps) {
    const t = useTranslations('chat');
    // The parent destination's name comes from ITS namespace, not a second
    // copy under `chat.`. «Съобщения» belongs to the exchange messaging screen
    // (owner ruling 2026-11-07), and a breadcrumb naming that destination must
    // read the same value the screen's own title does — coining a second one
    // is how a surface ends up with two names, which is the defect
    // `docs/nav-vocabulary.md` exists to prevent.
    const tExchange = useTranslations('exchange.messaging');
    // The report control's accessible name comes from the trust-safety
    // namespace rather than `chat`, so one string serves every surface that
    // offers «Сигнализирай».
    const tReport = useTranslations('trustSafety.report');
    const tenantHref = useTenantHref();
    const router = useRouter();

    // A LITERAL person-scoped path. Every other fetch on this screen's
    // neighbours builds `/api/t/{tenantSlug}/…`; these policies key on
    // `app.user_id`, which only `runInUserContext` sets, so a tenant route
    // would read zero rows with no error.
    const path = `/api/social/conversations/${encodeURIComponent(conversationId)}`;
    const { data, error, isLoading, mutate } = useSWR<ConversationWire>(
        path,
        (url: string) => apiGet<ConversationWire>(url),
        { refreshInterval: 30_000 },
    );

    const [sending, setSending] = React.useState(false);
    const [responding, setResponding] = React.useState(false);

    // Frozen per CONVERSATION on the first payload that arrives, then never
    // recomputed — see the header for why.
    //
    // STATE adjusted during render, not a ref. A ref was the first draft and
    // `react-hooks/refs` refuses it: reading or writing `ref.current` during
    // render is unsafe under concurrent rendering, where a render can be
    // discarded and replayed — the write would survive the discard and the
    // "first" payload would be whichever render happened to run. The lint gate
    // is a CEILING, so four new warnings also cost something real.
    //
    // Keyed by `data.id` so navigating to a DIFFERENT conversation recomputes,
    // while a poll of the SAME one does not. Calling a setter during render is
    // React's documented way to adjust state when inputs change, and it does
    // not schedule an extra commit the way an effect would — an effect here
    // would paint one frame with no divider and then add it.
    const [frozenUnread, setFrozenUnread] = React.useState<{
        for: string;
        id: string | null;
    } | null>(null);
    if (data && frozenUnread?.for !== data.id) {
        const readAt = data.lastReadAt ? Date.parse(data.lastReadAt) : null;
        const firstUnseen = data.messages.find(
            (m) =>
                m.senderUserId !== myUserId &&
                (readAt === null || Date.parse(m.createdAt) > readAt),
        );
        setFrozenUnread({ for: data.id, id: firstUnseen?.id ?? null });
    }

    /**
     * Older pages, oldest-first, ahead of SWR's newest page.
     *
     * Page state rather than SWR cache mutation: the 30-second poll replaces
     * the newest page wholesale, and folding older pages into that cache would
     * make every poll either discard them or merge them, which is a
     * reconciliation this screen does not need. Keyed by conversation so
     * navigating away and back does not resurrect somebody else's history.
     */
    const [older, setOlder] = React.useState<{
        for: string;
        rows: ConversationWire['messages'];
        cursor: string | null;
        hasOlder: boolean;
    } | null>(null);
    const [loadingOlder, setLoadingOlder] = React.useState(false);

    if (data && older && older.for !== data.id) setOlder(null);

    const sameConversation = Boolean(data && older && older.for === data.id);
    const cursor = sameConversation ? older!.cursor : (data?.olderCursor ?? null);
    const hasOlder = sameConversation ? older!.hasOlder : (data?.hasOlder ?? false);

    const timeline = React.useRef<MessageTimelineHandle | null>(null);

    // Which message «Сигнализирай» was pressed on, or null. One piece of state
    // rather than a dialog per bubble: the dialog is a modal, so only one can
    // be open, and mounting 200 of them is the windowing problem again.
    const [reportingMessageId, setReportingMessageId] = React.useState<string | null>(null);
    /** Set by the loader, consumed by the layout effect after the commit. */
    const pendingAnchor = React.useRef<TimelineAnchor | null>(null);

    const loadOlder = React.useCallback(async () => {
        if (!data || !cursor || loadingOlder) return;
        // CAPTURED BEFORE THE FETCH, not after: between the two the reader may
        // scroll, and an anchor read after the await would record where they
        // ended up rather than where the prepend has to put them back.
        pendingAnchor.current = timeline.current?.anchor() ?? null;
        setLoadingOlder(true);
        try {
            const page = await apiGet<ConversationWire>(
                `${path}?before=${encodeURIComponent(cursor)}`,
            );
            setOlder((prev) => {
                const kept = prev && prev.for === data.id ? prev.rows : [];
                // DEDUPED BY ID. The newest page is a moving window — new
                // messages shift it — so a page boundary can overlap, and a
                // duplicate row would get a duplicate React key and an anchor
                // that matches two elements.
                const seen = new Set(kept.map((m) => m.id));
                const fresh = page.messages.filter((m) => !seen.has(m.id));
                return {
                    for: data.id,
                    rows: [...fresh, ...kept],
                    cursor: page.olderCursor,
                    hasOlder: page.hasOlder,
                };
            });
        } catch {
            // A failed page must not clear the anchor on the floor: leaving it
            // set would restore on some LATER commit, moving the reader for no
            // reason they can see.
            pendingAnchor.current = null;
        } finally {
            setLoadingOlder(false);
        }
    }, [data, cursor, loadingOlder, path]);

    /**
     * Restore AFTER the commit that added the rows, before the browser paints.
     *
     * `useLayoutEffect`, not `useEffect`: an effect runs after paint, so the
     * reader would see one frame at the wrong position — which is the jump
     * this whole phase is about.
     */
    React.useLayoutEffect(() => {
        if (!pendingAnchor.current) return;
        timeline.current?.restore(pendingAnchor.current);
        pendingAnchor.current = null;
    }, [older]);

    const messages: TimelineMessage[] = React.useMemo(
        () =>
            [
                // Older pages first — the timeline takes oldest-first.
                ...(sameConversation ? older!.rows : []),
                ...(data?.messages ?? []),
            ].map((m) => ({
                id: m.id,
                senderUserId: m.senderUserId,
                body: m.body ?? '',
                createdAt: m.createdAt,
                editedAt: m.editedAt,
                deletedAt: m.deletedAt,
                reactions: m.reactions,
            })),
        [data?.messages, data?.id, older],
    );


    // The newest message from the other party names them. Searched from the
    // END so a long history does not make this depend on who spoke first.
    const counterpartyUserId = React.useMemo(() => {
        const fromThem = [...(data?.messages ?? [])]
            .reverse()
            .find((m) => m.senderUserId !== myUserId);
        return fromThem?.senderUserId ?? null;
    }, [data?.messages, myUserId]);

    // Mark read once per loaded conversation. `readAt` is an INSTANT, not a
    // message id, and the server moves the cursor FORWARD only — so a stale
    // call cannot rewind somebody's place.
    const markedFor = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!data || markedFor.current === data.id) return;
        markedFor.current = data.id;
        // Best-effort: failing to move a read cursor must not surface as an
        // error on a screen that otherwise loaded. The next visit retries.
        void apiPost(`${path}/read`, { readAt: new Date().toISOString() }).catch(() => undefined);
    }, [data, path]);

    /**
     * The message being answered (#2829), held HERE rather than in the
     * composer: the quote has to survive a timeline re-render and a poll, and
     * `MessageComposer` does the clearing and this screen decides WHETHER:
     * `send` returns `false` on failure, which keeps both the text and the
     * quote. That contract exists because the composer used to clear
     * unconditionally and synchronously, so a failed send lost the operator's
     * words — see `message-composer.tsx`'s `onSend`.
     *
     * The ID is the state and the quoted TEXT is derived from `messages` on
     * every render. Storing a snapshot of the body instead would show the
     * operator a quote of something the other party has since retracted, and
     * the payload already re-reads `replyTo` for exactly that reason.
     */
    /**
     * A failed send, surfaced the way the sibling exchange screen surfaces
     * one. Reset on the next ATTEMPT rather than on a timer, so the message
     * stays until the operator does something about it.
     */
    const [sendError, setSendError] = React.useState(false);
    const [replyToId, setReplyToId] = React.useState<string | null>(null);

    /**
     * The quoted message, DERIVED — no effect, and that is the second draft.
     *
     * A quoted message that has since been DELETED, or that has left the page,
     * must stop being quoted: the operator chose to answer something that is
     * no longer there, and quoting it as «изтрито» shows them a quote they did
     * not pick. The first draft cleared `replyToId` from a `useEffect`, which
     * `react-hooks/set-state-in-effect` flagged — correctly. Deriving it means
     * one source of truth, no cascading render and no warning to suppress.
     *
     * The consequence is that `replyToId` may name a message this returns null
     * for, so **every consumer reads `replyingTo`, never `replyToId`** — the
     * send below included, or a vanished target would still be sent.
     */
    const replyingTo = React.useMemo(() => {
        if (!replyToId) return null;
        const found = messages.find((m) => m.id === replyToId) ?? null;
        return found && !found.deletedAt ? found : null;
    }, [replyToId, messages]);

    const send = React.useCallback(
        async (body: string) => {
            setSending(true);
            setSendError(false);
            try {
                await apiPost(`${path}/messages`, {
                    body,
                    // `replyingTo`, NOT `replyToId` — see that memo. The id
                    // can name a message that has since been deleted or paged
                    // out, and the derived value is the only one that has
                    // applied those rules.
                    //
                    // Spread rather than `replyToMessageId: …`, so an absent
                    // reply sends no key at all. The route forwards per field
                    // and the schema is `.strip()`, so a null would be dropped
                    // silently — but #2890 was a field the route never
                    // forwarded, and sending a key the server ignores is the
                    // same class read from the other end.
                    ...(replyingTo ? { replyToMessageId: replyingTo.id } : {}),
                });
                // Cleared on SUCCESS only. A failed send retains the body
                // (that is `pending`'s contract) and must retain the quote
                // with it, or a retry sends the same words with their context
                // silently dropped.
                setReplyToId(null);
                await mutate();
                return true;
            } catch {
                // CAUGHT so the rejection does not escape. `onSend` discards
                // the promise (`void send(body)`), so without this a failed
                // send was an unhandled rejection — found by the rendered test
                // for the retained quote, which jest failed on the escape
                // rather than on its own assertion.
                //
                // And the operator is TOLD, which is the sibling exchange
                // screen's own pattern rather than something invented here:
                // `ThreadClient` does `catch { setSendError(true) }` and
                // renders `exchange…sendFailed`. Two message screens in one
                // product answering a failed send differently would be the
                // defect; the copy question #2899 asks was already settled
                // next door.
                //
                // A console line was the first draft and is wrong twice over:
                // `observability-foundation`'s console guard refuses it (and
                // an allowlist entry on a shrink-only list is a cost paid for
                // nothing), and a console reaches no farmer.
                setSendError(true);
                // `false`, so the composer KEEPS the text. Returning nothing
                // clears it — which is what happened before this, and it meant
                // a failed send lost the operator's words and left them with a
                // message saying to try again and nothing to try.
                return false;
            } finally {
                setSending(false);
            }
        },
        [path, mutate, replyingTo],
    );

    const respond = React.useCallback(
        async (decision: 'ACCEPT' | 'DECLINE') => {
            setResponding(true);
            try {
                await apiPost(`${path}/respond`, { decision });
                if (decision === 'DECLINE') {
                    // A declined conversation answers not-found on every
                    // content path, so staying here would show the reader a
                    // screen the server has stopped serving.
                    router.push(tenantHref('/exchange/threads'));
                    return;
                }
                await mutate();
            } finally {
                setResponding(false);
            }
        },
        [path, mutate, router, tenantHref],
    );

    if (error) {
        return (
            <div className="space-y-section p-default">
                <ErrorState description={t('loadError')} onRetry={() => void mutate()} />
            </div>
        );
    }

    if (isLoading || !data) {
        return (
            <div className="space-y-default p-default" aria-busy="true">
                <Skeleton className="h-8 w-full sm:w-48" />
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-16 w-full rounded-lg" />
            </div>
        );
    }

    const theirRequest = data.state === 'REQUEST' && data.initiatedByUserId !== myUserId;
    const myRequest = data.state === 'REQUEST' && data.initiatedByUserId === myUserId;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="space-y-default px-default pt-default">
                <PageBreadcrumbs
                    items={[
                        { label: tExchange('inboxTitle'), href: tenantHref('/exchange/threads') },
                        { label: t('directConversation') },
                    ]}
                />
                <div className="flex items-center gap-default">
                    <Heading level={1}>{t('directConversation')}</Heading>
                    {counterpartyUserId ? (
                        <div className="ml-auto">
                            <BlockPersonButton
                                blockedUserId={counterpartyUserId}
                                enabled={personBlocksEnabled}
                                onChanged={() => void mutate()}
                            />
                        </div>
                    ) : null}
                </div>
            </div>

            {/*
              * THE TIMELINE OWNS ITS SCROLLER, in both branches — #2826. This
              * used to be a `div.overflow-y-auto` here, which worked only
              * because nothing paged up: the windowed branch scrolls itself,
              * so with both live there were two scrollers and a prepend had to
              * be anchored in whichever one happened to be real.
              */}
            {hasOlder ? (
                <div className="flex justify-center border-b border-border-subtle p-tight">
                    <Button
                        size="sm"
                        disabled={loadingOlder}
                        onClick={() => void loadOlder()}
                    >
                        {loadingOlder ? t('loadingOlder') : t('loadOlder')}
                    </Button>
                </div>
            ) : null}
            {reportingMessageId ? (
                <ReportDialog
                    open
                    setOpen={(next) => {
                        // `Dispatch<SetStateAction<boolean>>` — the Modal
                        // primitive passes an updater through, so resolve it
                        // before deciding, rather than assuming a boolean.
                        const open = typeof next === 'function' ? next(true) : next;
                        if (!open) setReportingMessageId(null);
                    }}
                    subjectKind="DIRECT_MESSAGE"
                    subjectId={reportingMessageId}
                />
            ) : null}

            <MessageTimeline
                ref={timeline}
                messages={messages}
                myUserId={myUserId}
                firstUnreadId={frozenUnread?.id ?? null}
                onRequestReport={setReportingMessageId}
                reportLabel={tReport('triggerAria')}
                onRequestReply={setReplyToId}
                replyLabel={t('replyToMessage')}
            />

            {theirRequest ? (
                <div className="space-y-default border-t border-border-subtle p-default">
                    <p className="text-sm text-content-muted">{t('requestExplainer')}</p>
                    <div className="flex gap-tight">
                        <Button
                            variant="primary"
                            disabled={responding}
                            onClick={() => void respond('ACCEPT')}
                        >
                            {t('requestAccept')}
                        </Button>
                        <Button
                            variant="secondary"
                            disabled={responding}
                            onClick={() => void respond('DECLINE')}
                        >
                            {t('requestDecline')}
                        </Button>
                    </div>
                </div>
            ) : (
                <>
                    {/*
                      * Above the composer and OUTSIDE it, matching the sibling
                      * exchange screen: the composer is a primitive shared
                      * with any future chat surface, and a per-screen failure
                      * message is the screen's to render.
                      */}
                    {sendError ? (
                        <p className="px-default pt-default text-sm text-content-error">
                            {t('sendFailed')}
                        </p>
                    ) : null}
                <MessageComposer
                    // NOT `void send(body)`. The composer reads the result to
                    // decide whether to clear the text, and `void` discards it.
                    onSend={(body) => send(body)}
                    pending={sending}
                    placeholder={t('composerPlaceholder')}
                    sendLabel={t('send')}
                    quoted={
                        replyingTo
                            ? {
                                body: replyingTo.body,
                                deleted: Boolean(replyingTo.deletedAt),
                            }
                            : null
                    }
                    onClearQuote={() => setReplyToId(null)}
                    clearQuoteLabel={t('clearQuote')}
                    replyingToLabel={t('replyingTo')}
                    {...(myRequest ? { disabledReason: t('awaitingAcceptance') } : {})}
                />
                </>
            )}
        </div>
    );
}
