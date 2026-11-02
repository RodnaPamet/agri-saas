'use client';

/**
 * «Какво помни асистентът» — the web half of the owner's decision 2 (#2671).
 *
 * The phone screen is agrent-ios's (agrent-ios#507); this is the same API from
 * the browser. Nothing here is tenant-scoped: a remembered point is about a
 * PERSON, across farms, so the routes live under `/api/account/**` and the
 * paths are LITERAL rather than built with `useTenantApiUrl()`. Reaching for
 * that helper is the natural mistake — every other list in this product is a
 * farm's — and a tenant route would read zero rows with no error, because the
 * policies key on the person.
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

const ENDPOINT = '/api/account/assistant-memory';

interface RememberedPoint {
    id: string;
    text: string;
    rememberedAt: string;
}

export function AssistantMemoryCard({ enabled }: { enabled: boolean }) {
    const t = useTranslations('account.assistantMemory');
    const triggerUndoToast = useToastWithUndo();
    const [confirmAll, setConfirmAll] = useState(false);

    const { data, mutate, isLoading } = useSWR(
        // `null` disables the fetch entirely — a flag-off person must not even
        // ask, or the OFF state is observable as a 404 in their network tab.
        enabled ? ENDPOINT : null,
        (url: string) => apiGet<{ facts: RememberedPoint[] }>(url),
    );

    const points = data?.facts ?? [];

    const forgetOne = useCallback(
        (point: RememberedPoint) => {
            // Epic 67: a routine destructive action gets the undo toast, not a
            // confirm. The API tombstones rather than deleting (rule 5), so an
            // undone delete is a point that was never forgotten.
            const before = points;
            void mutate({ facts: points.filter((p) => p.id !== point.id) }, { revalidate: false });
            triggerUndoToast({
                action: () => apiDelete(`${ENDPOINT}/${point.id}`),
                undoAction: () => {
                    void mutate({ facts: before }, { revalidate: false });
                },
                onCommit: () => {
                    void mutate();
                },
                onError: () => {
                    void mutate({ facts: before }, { revalidate: false });
                },
                message: t('forgotten'),
                undoMessage: t('undo'),
            });
        },
        [points, mutate, t, triggerUndoToast],
    );

    const forgetAll = useCallback(async () => {
        setConfirmAll(false);
        await apiDelete(ENDPOINT);
        void mutate();
    }, [mutate]);

    /*
     * The flag is resolved on the SERVER page and passed down, and with it off
     * this renders NOTHING — not a disabled card, which would advertise a
     * feature that does not exist. P5.3's rule, and there is no client-side
     * flags hook in this codebase to do it any other way.
     */
    if (!enabled) return null;

    return (
        <section
            className="mt-6 space-y-default rounded-lg border border-border-subtle bg-bg-default p-default"
            aria-labelledby="assistant-memory-heading"
        >
            <div className="flex items-center justify-between gap-default">
                <Heading level={2} className="text-sm" id="assistant-memory-heading">
                    {t('title')}
                </Heading>
                {points.length > 0 && (
                    <Button variant="ghost" onClick={() => setConfirmAll(true)}>
                        {t('forgetAll')}
                    </Button>
                )}
            </div>

            <p className="text-xs text-content-muted">{t('explainer')}</p>

            {isLoading ? null : points.length === 0 ? (
                /*
                 * An HONEST empty state. It is the common case while the
                 * feature is dark and while a new person has said nothing
                 * durable yet — and "nothing remembered" is a true, calm
                 * answer rather than a failure. Saying nothing at all would
                 * read as a broken card.
                 */
                <EmptyState title={t('emptyTitle')} description={t('emptyBody')} />
            ) : (
                <ul className="space-y-default">
                    {points.map((point) => (
                        <li
                            key={point.id}
                            className="flex items-start justify-between gap-default rounded-md border border-border-subtle p-default"
                        >
                            <div className="space-y-1">
                                <p className="text-sm text-content-default">{point.text}</p>
                                <p className="text-xs text-content-muted">
                                    {t('rememberedOn', { date: formatDate(point.rememberedAt) })}
                                </p>
                            </div>
                            <Button variant="ghost" onClick={() => forgetOne(point)}>
                                {t('forget')}
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            {confirmAll && (
                /*
                 * A CONFIRM rather than an undo toast, and the reason is the
                 * API: `forgetAll` tombstones every visible point and there is
                 * no un-tombstone verb, so there is nothing for Undo to call.
                 * Offering one would be a button that cannot keep its promise.
                 */
                <ConfirmDialog
                    showModal
                    setShowModal={() => setConfirmAll(false)}
                    tone="danger"
                    title={t('forgetAllConfirmTitle')}
                    description={t('forgetAllConfirmBody')}
                    confirmLabel={t('forgetAllConfirm')}
                    onConfirm={forgetAll}
                />
            )}
        </section>
    );
}

export default AssistantMemoryCard;
