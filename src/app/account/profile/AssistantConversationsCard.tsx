'use client';

/**
 * «Какво помни асистентът» — the EXCHANGES half, on the web (#2695).
 *
 * A second card rather than a section inside `AssistantMemoryCard`, because
 * the two lists answer different questions and delete different things: that
 * one holds CONCLUSIONS the assistant drew, this one holds the CONVERSATIONS
 * they were drawn from. A person may want to forget a conversation and keep
 * the conclusion, or the reverse — so the controls must not look like one
 * control.
 *
 * Person-scoped across farms, so the paths are literal `/api/account/**`. A
 * tenant route would hide the exchanges this person had in their other farms,
 * silently.
 */
import { useCallback, useState } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';

import { Heading } from '@/components/ui/typography';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { useToastWithUndo } from '@/components/ui/hooks';
import { apiGet, apiDelete } from '@/lib/api-client';
import { formatDate } from '@/lib/format-date';

const ENDPOINT = '/api/account/assistant-conversations';

interface PastConversation {
    id: string;
    startedAt: string;
    lastTurnAt: string;
    turns: number;
    opening: string | null;
}

export function AssistantConversationsCard({ enabled }: { enabled: boolean }) {
    const t = useTranslations('account.assistantConversations');
    const triggerUndoToast = useToastWithUndo();
    const [confirmAll, setConfirmAll] = useState(false);

    const { data, mutate, isLoading } = useSWR(
        // `null` disables the fetch: a flag-off person must not even ask.
        enabled ? ENDPOINT : null,
        (url: string) => apiGet<{ conversations: PastConversation[] }>(url),
    );

    const items = data?.conversations ?? [];

    const deleteOne = useCallback(
        (item: PastConversation) => {
            // Epic 67's undo toast. The API tombstones, so an undone delete is
            // a conversation that was never deleted.
            const before = items;
            void mutate({ conversations: items.filter((c) => c.id !== item.id) }, { revalidate: false });
            triggerUndoToast({
                action: () => apiDelete(`${ENDPOINT}/${item.id}`),
                undoAction: () => {
                    void mutate({ conversations: before }, { revalidate: false });
                },
                onCommit: () => {
                    void mutate();
                },
                onError: () => {
                    void mutate({ conversations: before }, { revalidate: false });
                },
                message: t('deleted'),
                undoMessage: t('undo'),
            });
        },
        [items, mutate, t, triggerUndoToast],
    );

    const deleteAll = useCallback(async () => {
        setConfirmAll(false);
        await apiDelete(ENDPOINT);
        void mutate();
    }, [mutate]);

    if (!enabled) return null;

    return (
        <section
            className="mt-6 space-y-default rounded-lg border border-border-subtle bg-bg-default p-default"
            aria-labelledby="assistant-conversations-heading"
        >
            <div className="flex items-center justify-between gap-default">
                <Heading level={2} className="text-sm" id="assistant-conversations-heading">
                    {t('title')}
                </Heading>
                {items.length > 0 && (
                    <Button variant="ghost" onClick={() => setConfirmAll(true)}>
                        {t('deleteAll')}
                    </Button>
                )}
            </div>

            <p className="text-xs text-content-muted">{t('explainer')}</p>

            {isLoading ? null : items.length === 0 ? (
                <EmptyState title={t('emptyTitle')} description={t('emptyBody')} />
            ) : (
                <ul className="space-y-default">
                    {items.map((item) => (
                        <li
                            key={item.id}
                            className="flex items-start justify-between gap-default rounded-md border border-border-subtle p-default"
                        >
                            <div className="space-y-1">
                                {/*
                                 * The person's OWN first question labels the row.
                                 * `opening` is null for an exchange abandoned
                                 * before a question landed — a real state, not a
                                 * loading one, so it gets its own words rather
                                 * than an empty line.
                                 */}
                                <p className="text-sm text-content-default">
                                    {item.opening ?? t('noOpening')}
                                </p>
                                <p className="text-xs text-content-muted">
                                    {t('meta', {
                                        date: formatDate(item.lastTurnAt),
                                        turns: item.turns,
                                    })}
                                </p>
                            </div>
                            <Button variant="ghost" onClick={() => deleteOne(item)}>
                                {t('delete')}
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            {confirmAll && (
                /*
                 * A CONFIRM, not an undo toast: `deleteAll` tombstones every
                 * visible exchange and there is no un-tombstone verb, so an
                 * Undo button could not keep its promise. Same reasoning as the
                 * profile card's «Изтрий всичко».
                 */
                <ConfirmDialog
                    showModal
                    setShowModal={() => setConfirmAll(false)}
                    tone="danger"
                    title={t('deleteAllConfirmTitle')}
                    description={t('deleteAllConfirmBody')}
                    confirmLabel={t('deleteAllConfirm')}
                    onConfirm={deleteAll}
                />
            )}
        </section>
    );
}

export default AssistantConversationsCard;
