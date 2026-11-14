'use client';

/**
 * «За Вас» — replies to the caller's posts and mentions of them (P9.7, #2941).
 *
 * ## NOT a timeline
 *
 * `MessageTimeline` groups by sender and day because a conversation reads that
 * way. This is a list of unrelated events from different channels, so grouping
 * them would imply a thread that does not exist. Each row names its channel and
 * why it is here, and that is the whole shape.
 *
 * ## The reason is a DESCRIPTOR, composed here
 *
 * The server sends `reason: 'mention' | 'reply'`, never a sentence — P9.7's own
 * rule, and the correction `DueItem.reason` took: the item is produced where the
 * reader's language is not yet known.
 *
 * ## A hidden post still occupies a row
 *
 * `readMyActivity` returns a removed post with `deleted: true` and an empty
 * body, like every other channel read. The row stays so the count a person was
 * notified about matches what they find — and the collapse is what withholds
 * the content, exactly as in the feed.
 */
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import useSWR from 'swr';

import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Heading } from '@/components/ui/typography';
import { apiGet } from '@/lib/api-client';
import { makeAuthorLabel, type ChannelAuthor } from '@/lib/channels/author-label';
import { formatDateTime } from '@/lib/format-date';

interface ActivityWire {
    post: {
        id: string;
        body: string;
        createdAt: string;
        deleted: boolean;
        author: ChannelAuthor | null;
    };
    channelId: string;
    channelNameBg: string;
    channelNameEn: string;
    reason: 'mention' | 'reply';
    parentPostId: string | null;
}

interface FeedWire {
    items: ActivityWire[];
    hasMore: boolean;
}

export function ForYouClient({ tenantSlug }: { tenantSlug: string }) {
    const t = useTranslations('channels');
    const locale = useLocale();
    const authorLabel = React.useMemo(
        () => makeAuthorLabel((vars) => t('authorNameAndFarm', vars)),
        [t],
    );

    // LITERAL person-scoped path — channel policies key on `app.user_id`, so a
    // tenant route would read zero rows with no error (#1664).
    const path = '/api/social/activity';
    const { data, error, isLoading, mutate } = useSWR<FeedWire>(
        path,
        (url: string) => apiGet<FeedWire>(url),
        { refreshInterval: 60_000 },
    );

    const [older, setOlder] = React.useState<ActivityWire[]>([]);
    const [loadingOlder, setLoadingOlder] = React.useState(false);
    const [exhausted, setExhausted] = React.useState(false);

    const items = React.useMemo(() => {
        const seen = new Set((data?.items ?? []).map((i) => i.post.id));
        return [...(data?.items ?? []), ...older.filter((i) => !seen.has(i.post.id))];
    }, [data, older]);

    const oldest = items.at(-1);
    const hasMore = older.length > 0 ? !exhausted : (data?.hasMore ?? false);

    const loadOlder = React.useCallback(async () => {
        if (!oldest || loadingOlder) return;
        setLoadingOlder(true);
        try {
            const page = await apiGet<FeedWire>(
                `${path}?before=${encodeURIComponent(oldest.post.createdAt)}`,
            );
            // DEDUPED BY POST ID: the newest page is a moving window, so a page
            // boundary can overlap and a duplicate would get a duplicate React
            // key.
            setOlder((prev) => {
                const seen = new Set(prev.map((i) => i.post.id));
                return [...prev, ...page.items.filter((i) => !seen.has(i.post.id))];
            });
            if (!page.hasMore) setExhausted(true);
        } finally {
            setLoadingOlder(false);
        }
    }, [oldest, loadingOlder]);

    const channelName = (i: ActivityWire) =>
        locale === 'bg' ? i.channelNameBg : i.channelNameEn;

    return (
        <div className="space-y-section">
            <div className="space-y-tight">
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t('breadcrumbCurrent'), href: `/t/${tenantSlug}/channels` },
                        { label: t('forYou.breadcrumbCurrent') },
                    ]}
                />
                <Heading level={1}>{t('forYou.title')}</Heading>
            </div>

            {error ? (
                <ErrorState
                    description={t('forYou.loadError')}
                    onRetry={() => void mutate()}
                />
            ) : isLoading && items.length === 0 ? (
                <div className="space-y-default" aria-busy="true">
                    {[0, 1, 2].map((i) => (
                        <Skeleton key={i} className="h-16 w-full rounded-lg" />
                    ))}
                </div>
            ) : items.length === 0 ? (
                <EmptyState variant="no-records" title={t('forYou.empty')} />
            ) : (
                <>
                    <ul className="space-y-default">
                        {items.map((i) => (
                            <li
                                key={i.post.id}
                                className="rounded-lg border border-border-subtle p-default"
                            >
                                <div className="flex flex-wrap items-baseline gap-tight text-xs text-content-muted">
                                    <span>
                                        {i.reason === 'mention'
                                            ? t('forYou.reasonMention')
                                            : t('forYou.reasonReply')}
                                    </span>
                                    <span>{t('forYou.inChannel', { channel: channelName(i) })}</span>
                                    <span>{formatDateTime(i.post.createdAt)}</span>
                                </div>
                                {/*
                                  * The author line, or nothing on a hidden post
                                  * — the server suppresses attribution there
                                  * rather than naming somebody above content
                                  * nobody can read (#2989).
                                  */}
                                {authorLabel(i.post.author) ? (
                                    <div className="pt-tight text-xs font-[560]">
                                        {authorLabel(i.post.author)}
                                    </div>
                                ) : null}
                                <p className="pt-tight text-sm">{i.post.body}</p>
                                <div className="pt-tight">
                                    {/*
                                      * The PERMALINK #3030 built, and the parent
                                      * when this is a reply — a reply's own page
                                      * would show one bubble with no context,
                                      * and the thread is what the person wants.
                                      */}
                                    <Link
                                        href={`/t/${tenantSlug}/channels/${i.channelId}/posts/${i.parentPostId ?? i.post.id}`}
                                        className="text-xs underline"
                                    >
                                        {t('card.open')}
                                    </Link>
                                </div>
                            </li>
                        ))}
                    </ul>
                    {hasMore ? (
                        <div className="text-center">
                            <Button
                                variant="secondary"
                                onClick={() => void loadOlder()}
                                disabled={loadingOlder}
                            >
                                {t('forYou.loadOlder')}
                            </Button>
                        </div>
                    ) : null}
                </>
            )}
        </div>
    );
}
