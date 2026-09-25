'use client';

/**
 * One conversation, oldest message at the top.
 *
 * ── Why polling and not a socket ──
 *
 * There is no broker, deliberately — `usecases/exchange-messaging.ts` persists
 * and never publishes, so the transport is a rendering concern and lives here.
 * A 5s refresh while a thread is open is what makes this feel live, against a
 * capped, indexed page. When a real transport lands, this file changes and
 * nothing behind it does.
 *
 * ── Marking read ──
 *
 * Once per mount. The endpoint is monotonic — it refuses to move the pointer
 * backwards — so two tabs, or a slow response overtaking a fast one, cannot
 * rewind it. That is why this component coordinates with nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Button } from '@/components/ui/button';
import { MetaStrip } from '@/components/ui/meta-strip';
import { Textarea } from '@/components/ui/textarea';
import { useEnterSubmit } from '@/components/ui/hooks';
import { formatDateTime } from '@/lib/format-date';
import { apiDelete, apiGet, apiPost } from '@/lib/api-client';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';

/** The wire shape of `getExchangeThread` — dates arrive as ISO strings. */
interface ThreadMessage {
    id: string;
    senderTenantId: string;
    mine: boolean;
    body: string | null;
    deleted: boolean;
    createdAt: string;
}
interface ThreadDetail {
    id: string;
    listingId: string;
    listingCommodity: string;
    role: 'seller' | 'inquirer';
    lastMessageAt: string;
    closed: boolean;
    blocked: boolean;
    unreadCount: number;
    olderCursor: string | null;
    messages: ThreadMessage[];
}

export function ThreadClient({ threadId }: { threadId: string }) {
    const t = useTranslations('exchange.messaging');
    const tenantHref = useTenantHref();
    const buildApiUrl = useTenantApiUrl();
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState(false);
    const [closeError, setCloseError] = useState(false);
    const [blockError, setBlockError] = useState(false);
    const marked = useRef(false);
    // Older pages accumulate HERE rather than in the SWR cache. The poll
    // refreshes the newest page every 5s; if scrollback lived in the same
    // cache entry it would be discarded on every tick.
    const [older, setOlder] = useState<ThreadMessage[]>([]);
    // `undefined` means "not walked yet", which is DISTINCT from `null`
    // ("reached the start"). Derived rather than seeded in an effect: seeding
    // on every 5s poll would resurrect a cursor the reader has already walked
    // past, and the effect form also trips `react-hooks/set-state-in-effect`.
    const [walkedCursor, setWalkedCursor] = useState<string | null | undefined>(undefined);
    const [loadingOlder, setLoadingOlder] = useState(false);

    const { data, isLoading, error, mutate } = useTenantSWR<ThreadDetail>(
        `/exchange/threads/${threadId}`,
        { refreshInterval: 5_000 },
    );

    useEffect(() => {
        // Once per mount, and only once the thread has loaded — a read receipt
        // for a thread that 404s would be a lie. Failure is swallowed: an
        // unmarked thread shows as unread, a strictly safer wrong answer than
        // an error on a screen the operator never asked to write to.
        if (marked.current || !data) return;
        marked.current = true;
        void apiPost(buildApiUrl(`/exchange/threads/${threadId}/read`), {}).catch(() => {});
    }, [data, threadId, buildApiUrl]);

    const send = useCallback(async () => {
        const body = draft.trim();
        if (!body) return;
        setSending(true);
        setSendError(false);
        try {
            await apiPost(buildApiUrl(`/exchange/threads/${threadId}/messages`), { body });
            // Cleared only on success. Clearing first would lose what the
            // operator wrote to a dropped connection.
            setDraft('');
            await mutate();
        } catch {
            setSendError(true);
        } finally {
            setSending(false);
        }
    }, [draft, threadId, buildApiUrl, mutate]);

    // Cmd/Ctrl+Enter sends, bare Enter breaks the line — the hook's `auto`
    // policy for a textarea. It also bails while an IME candidate window is
    // open, which a hand-rolled keydown comparison does not: composing
    // Cyrillic through a dead-key chain would otherwise fire a half-typed
    // message.
    const { handleKeyDown } = useEnterSubmit({ onSubmit: () => { void send(); } });

    const closeThread = useCallback(async () => {
        setCloseError(false);
        try {
            await apiPost(buildApiUrl(`/exchange/threads/${threadId}/close`), {});
            await mutate();
        } catch {
            setCloseError(true);
        }
    }, [buildApiUrl, threadId, mutate]);

    // No confirmation dialog, deliberately: blocking is REVERSIBLE from the
    // same button, so the cost of a mis-tap is one more tap. A confirm here
    // would be ceremony around an undoable action.
    const toggleBlock = useCallback(async (blocked: boolean) => {
        setBlockError(false);
        try {
            const url = buildApiUrl(`/exchange/threads/${threadId}/block`);
            await (blocked ? apiDelete(url) : apiPost(url, {}));
            await mutate();
        } catch {
            setBlockError(true);
        }
    }, [buildApiUrl, threadId, mutate]);

    const remove = useCallback(
        async (messageId: string) => {
            try {
                await apiDelete(buildApiUrl(`/exchange/messages/${messageId}`));
                await mutate();
            } catch {
                setSendError(true);
            }
        },
        [buildApiUrl, mutate],
    );

    const olderCursor = walkedCursor === undefined ? (data?.olderCursor ?? null) : walkedCursor;

    const loadOlder = useCallback(async () => {
        if (!olderCursor) return;
        setLoadingOlder(true);
        try {
            const page = await apiGet<ThreadDetail>(
                buildApiUrl(`/exchange/threads/${threadId}?before=${encodeURIComponent(olderCursor)}`),
            );
            setOlder((prev) => [...page.messages, ...prev]);
            setWalkedCursor(page.olderCursor);
        } catch {
            // Silent: the reader still has everything they had a moment ago,
            // and an error banner over a scrollback they did not ask to
            // extend is noisier than the failure.
        } finally {
            setLoadingOlder(false);
        }
    }, [olderCursor, threadId, buildApiUrl]);

    const messages = [...older, ...(data?.messages ?? [])];

    return (
        <EntityDetailLayout
            breadcrumbs={[
                { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                { label: t('breadcrumbExchange'), href: tenantHref('/exchange') },
                { label: t('breadcrumbCurrent'), href: tenantHref('/exchange/threads') },
                { label: data?.listingCommodity ?? t('threadTitle') },
            ]}
            title={data?.listingCommodity ?? t('threadTitle')}
            meta={
                data ? (
                    <MetaStrip
                        items={[
                            {
                                label: t('metaRole'),
                                value: data.role === 'seller' ? t('roleSeller') : t('roleInquirer'),
                            },
                            {
                                label: t('metaStatus'),
                                value: data.closed ? t('closed') : t('open'),
                            },
                        ]}
                    />
                ) : undefined
            }
            actions={
                data ? (
                    <div className="flex items-center gap-tight">
                        {/* Seller only — the buyer has no mirror control. */}
                        {data.role === 'seller' ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => { void toggleBlock(data.blocked); }}
                            >
                                {data.blocked ? t('unblockParty') : t('blockParty')}
                            </Button>
                        ) : null}
                        {!data.closed ? (
                            <Button variant="secondary" size="sm" onClick={() => { void closeThread(); }}>
                                {t('closeThread')}
                            </Button>
                        ) : null}
                    </div>
                ) : undefined
            }
            loading={isLoading}
            error={error ? t('loadError') : null}
        >
            <div className="flex min-h-0 flex-1 flex-col gap-default">
                <div className="min-h-0 flex-1 space-y-tight overflow-y-auto pr-1">
                    {olderCursor ? (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="w-full"
                            loading={loadingOlder}
                            onClick={() => { void loadOlder(); }}
                        >
                            {t('loadOlder')}
                        </Button>
                    ) : null}
                    {messages.length === 0 ? (
                        <div className="rounded-lg border border-border-subtle p-4 text-sm text-content-muted">
                            {t('threadEmpty')}
                        </div>
                    ) : (
                        messages.map((m) => (
                            <div
                                key={m.id}
                                className={`max-w-[80%] rounded-lg border border-border-subtle p-3 ${
                                    m.mine ? 'ml-auto bg-surface-subtle' : ''
                                }`}
                            >
                                <div className="flex items-center gap-tight text-xs text-content-muted">
                                    <span>{m.mine ? t('you') : t('them')}</span>
                                    <span>{formatDateTime(m.createdAt)}</span>
                                    {m.mine && !m.deleted ? (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="ml-auto"
                                            onClick={() => { void remove(m.id); }}
                                        >
                                            {t('remove')}
                                        </Button>
                                    ) : null}
                                </div>
                                {/*
                                  * A retracted message keeps its place and says so.
                                  * Removing the row would leave a hole where the other
                                  * party demonstrably read something, which reads as
                                  * data loss rather than as a retraction.
                                  */}
                                <p
                                    className={
                                        m.deleted
                                            ? 'whitespace-pre-wrap text-sm italic text-content-muted'
                                            : 'whitespace-pre-wrap text-sm text-content-strong'
                                    }
                                >
                                    {m.deleted ? t('deleted') : m.body}
                                </p>
                            </div>
                        ))
                    )}
                </div>

                {/*
                  * The composer stays on a CLOSED thread, deliberately. Closing
                  * is a soft "I'm done here" and sending is what reopens it, so
                  * hiding the composer would remove the only way back and turn a
                  * tidy-up into a lock either party could impose on the other.
                  */}
                {data?.closed ? (
                    <p className="text-sm text-content-muted">{t('closedHint')}</p>
                ) : null}
                {data?.blocked ? (
                    <p className="text-sm text-content-muted">
                        {data.role === 'seller' ? t('blockedNotice') : t('blockedForYou')}
                    </p>
                ) : null}
                {(
                    <div className="flex items-end gap-tight border-t border-border-subtle pt-3">
                        <Textarea
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={t('composerPlaceholder')}
                            rows={2}
                            className="flex-1"
                        />
                        <Button
                            variant="primary"
                            loading={sending}
                            disabled={draft.trim() === ''}
                            onClick={() => { void send(); }}
                        >
                            {t('send')}
                        </Button>
                    </div>
                )}
                {sendError ? <p className="text-sm text-content-danger">{t('sendFailed')}</p> : null}
                {closeError ? <p className="text-sm text-content-danger">{t('closeFailed')}</p> : null}
                {blockError ? <p className="text-sm text-content-danger">{t('blockFailed')}</p> : null}
            </div>
        </EntityDetailLayout>
    );
}
