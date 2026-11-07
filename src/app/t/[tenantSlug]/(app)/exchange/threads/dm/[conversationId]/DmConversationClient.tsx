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
 * ## No "load older" yet, and that is measured rather than forgotten
 *
 * `readConversation` returns `olderCursor` and `hasOlder` and pages backwards
 * on a `(createdAt, id)` keyset, so the data side is ready. The CONTROL is
 * absent because paging up without scroll anchoring puts the reader somewhere
 * they did not ask to be, and anchoring is a change to the timeline's scroll
 * ownership — #2826 owns both together. Measured 2026-11-07: production has 0
 * conversations and 0 direct messages, and the page size is 100, so nobody can
 * reach a second page today.
 *
 * ## The counterparty is the sender of a message that is not mine
 *
 * The payload names people only on messages, which is the same constraint P5.3
 * worked under for the exchange thread header, and the same consequence: the
 * block control appears only once the other party has written. That matches
 * the standing rule that you can block somebody who has already written to
 * you, rather than being a limitation to work around.
 *
 * `ReportButton` is deliberately NOT here — #2833. `captureSnapshot` resolves
 * `MESSAGE` against `prisma.exchangeMessage`, so a notice about a direct
 * message would be filed with `SUBJECT_NOT_FOUND` as its evidence, and the
 * reporter could not tell that from a successful report.
 */
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import useSWR from 'swr';

import { MessageComposer } from '@/components/chat/message-composer';
import { MessageTimeline, type TimelineMessage } from '@/components/chat/message-timeline';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BlockPersonButton } from '@/components/trust-safety/BlockPersonButton';
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

    const messages: TimelineMessage[] = React.useMemo(
        () =>
            (data?.messages ?? []).map((m) => ({
                id: m.id,
                senderUserId: m.senderUserId,
                body: m.body ?? '',
                createdAt: m.createdAt,
                editedAt: m.editedAt,
                deletedAt: m.deletedAt,
                reactions: m.reactions,
            })),
        [data?.messages],
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

    const send = React.useCallback(
        async (body: string) => {
            setSending(true);
            try {
                await apiPost(`${path}/messages`, { body });
                await mutate();
            } finally {
                setSending(false);
            }
        },
        [path, mutate],
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
              * The scroll container is HERE, not inside the timeline. That is
              * the seam #2826 has to move: the windowed branch scrolls itself,
              * so anchoring a prepend across both branches means the timeline
              * owning this element. Nothing pages up yet, so the two do not
              * disagree today.
              */}
            <div className="min-h-0 flex-1 overflow-y-auto">
                <MessageTimeline
                    messages={messages}
                    myUserId={myUserId}
                    firstUnreadId={frozenUnread?.id ?? null}
                />
            </div>

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
                <MessageComposer
                    onSend={(body) => void send(body)}
                    pending={sending}
                    placeholder={t('composerPlaceholder')}
                    sendLabel={t('send')}
                    {...(myRequest ? { disabledReason: t('awaitingAcceptance') } : {})}
                />
            )}
        </div>
    );
}
