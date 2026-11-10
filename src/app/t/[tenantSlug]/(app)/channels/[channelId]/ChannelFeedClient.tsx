'use client';

/**
 * One channel's feed, read and written (P9.5, #2939).
 *
 * Composed from P8.3's primitives — `MessageTimeline`, `MessageComposer` — so
 * day grouping, bubble grouping and the keyboard inset arrive without this
 * file knowing about any of them. #2939's first exit criterion is that there
 * is no second timeline implementation, and `buildTimelineRows` is reused
 * rather than re-derived.
 *
 * ## The feed is newest-first and the timeline is oldest-first
 *
 * `readChannelFeed` orders `createdAt desc` because a reader wants what is
 * new; `MessageTimeline` takes `messages` oldest-first because a conversation
 * reads downward. So the adapter REVERSES, and that is the one place the two
 * orders meet. Reversing anywhere else — in the usecase, or by asking the API
 * for ascending order — would change what `before` means for paging and break
 * the keyset.
 *
 * ## Paging up, and the anchoring it needs (#2826)
 *
 * A channel feed is the other surface that grows at the TOP, which is where
 * `<VirtualizedList>`'s rule 4 runs out: react-window v2 keys its measurement
 * cache by INDEX and v2 removed `itemKey`, so prepending a page of older posts
 * re-points every cached height at a different post and the estimated extent
 * above the reader is wrong until it has been scrolled through.
 *
 * So the policy is the same as the DM screen's and is deliberately a COPY of
 * the decision rather than of the code: capture the anchor BEFORE the fetch,
 * restore in a layout effect after the commit that adds the rows. It lives
 * here rather than in the primitive because only the page knows a prepend is
 * happening — a timeline that anchored on every render would impose one policy
 * on every future consumer.
 *
 * ## Posting is gated by MEMBERSHIP, and the composer says so rather than failing
 *
 * `channel_post_insert`'s WITH CHECK enforces author-is-caller, membership
 * exists, and not banned — in the DATABASE. A non-member who posts gets a
 * refusal, so offering a composer that cannot succeed is worse than offering
 * none: the directory's Join button is the way in, and this screen names it.
 *
 * ## A hidden post is a ROW, not an absence
 *
 * The feed returns a removed, auto-hidden or retracted post with
 * `deleted: true` and an EMPTY body rather than omitting it, so a reply above
 * it does not dangle. `TimelineMessage.deleted` carries that: a channel post
 * has no deletion TIMESTAMP to give, because the three removal columns are
 * collapsed into one boolean precisely so a reader cannot tell a moderator's
 * act from the author's.
 */
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
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
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Heading } from '@/components/ui/typography';
import { apiGet, apiPost } from '@/lib/api-client';

interface PostWire {
    id: string;
    authorUserId: string;
    body: string;
    kind: string;
    createdAt: string;
    deleted: boolean;
    resolvedAt: string | null;
    replyCount: number;
}

interface FeedWire {
    posts: PostWire[];
    hasMore: boolean;
}

interface ChannelWire {
    id: string;
    key: string;
    nameBg: string;
    nameEn: string;
    joined: boolean;
    banned: boolean;
    slowModeSeconds: number;
}

export function ChannelFeedClient({
    tenantSlug,
    channelId,
    myUserId,
}: {
    tenantSlug: string;
    channelId: string;
    myUserId: string;
}) {
    const t = useTranslations('channels');
    const locale = useLocale();

    // LITERAL person-scoped paths — channel policies key on `app.user_id`.
    const feedPath = `/api/social/channels/${encodeURIComponent(channelId)}`;
    const { data, error, isLoading, mutate } = useSWR<FeedWire>(
        feedPath,
        (url: string) => apiGet<FeedWire>(url),
        { refreshInterval: 30_000 },
    );

    // The directory read, for this channel's name and the caller's membership.
    // A second request rather than a field on the feed: `readChannelFeed`
    // returns posts, and widening it to carry membership would make every
    // poll re-read a row that changes when the person presses a button.
    const { data: dir } = useSWR<{ channels: ChannelWire[] }>(
        '/api/social/channels',
        (url: string) => apiGet<{ channels: ChannelWire[] }>(url),
    );
    const channel = dir?.channels.find((c) => c.id === channelId);

    const [older, setOlder] = React.useState<{
        for: string;
        rows: PostWire[];
        cursor: string | null;
        hasMore: boolean;
    } | null>(null);
    const [loadingOlder, setLoadingOlder] = React.useState(false);
    const [posting, setPosting] = React.useState(false);

    // State adjusted during render, not a ref: `react-hooks/refs` refuses a
    // ref written during render, because a discarded-and-replayed render would
    // keep the write. The DM screen carries the same note.
    if (older && older.for !== channelId) setOlder(null);

    const sameChannel = Boolean(older && older.for === channelId);
    const oldest = sameChannel && older!.rows.length > 0
        ? older!.rows[older!.rows.length - 1]!
        : data?.posts[data.posts.length - 1];
    const hasMore = sameChannel ? older!.hasMore : (data?.hasMore ?? false);

    const timeline = React.useRef<MessageTimelineHandle | null>(null);
    const pendingAnchor = React.useRef<TimelineAnchor | null>(null);

    const loadOlder = React.useCallback(async () => {
        if (!data || !oldest || loadingOlder || !hasMore) return;
        // CAPTURED BEFORE THE FETCH: between the two the reader may scroll, and
        // an anchor read after the await would record where they ended up
        // rather than where the prepend has to put them back.
        pendingAnchor.current = timeline.current?.anchor() ?? null;
        setLoadingOlder(true);
        try {
            const page = await apiGet<FeedWire>(
                `${feedPath}?before=${encodeURIComponent(oldest.createdAt)}`,
            );
            setOlder((prev) => {
                const kept = prev && prev.for === channelId ? prev.rows : [];
                // DEDUPED BY ID. The newest page is a moving window, so a page
                // boundary can overlap — and a duplicate row would get a
                // duplicate React key and an anchor matching two elements.
                const seen = new Set(kept.map((p) => p.id));
                const fresh = page.posts.filter((p) => !seen.has(p.id));
                return {
                    for: channelId,
                    // Both halves stay NEWEST-first here; the adapter reverses
                    // once, at the end.
                    rows: [...kept, ...fresh],
                    cursor: null,
                    hasMore: page.hasMore,
                };
            });
        } catch {
            // A failed page must not leave the anchor set: it would restore on
            // some later commit and move the reader for no visible reason.
            pendingAnchor.current = null;
        } finally {
            setLoadingOlder(false);
        }
    }, [data, oldest, loadingOlder, hasMore, feedPath, channelId]);

    /**
     * Restore AFTER the commit that added the rows and BEFORE paint.
     *
     * `useLayoutEffect`, not `useEffect`: an effect runs after paint, so the
     * reader would see one frame at the wrong position — the jump this is
     * about.
     */
    React.useLayoutEffect(() => {
        if (!pendingAnchor.current) return;
        timeline.current?.restore(pendingAnchor.current);
        pendingAnchor.current = null;
    }, [older]);

    const messages: TimelineMessage[] = React.useMemo(() => {
        const newestFirst = [
            ...(data?.posts ?? []),
            ...(sameChannel ? older!.rows.filter(
                (p) => !(data?.posts ?? []).some((q) => q.id === p.id),
            ) : []),
        ];
        // ONE reversal, here. See the header: the API is newest-first and the
        // timeline is oldest-first, and this is where the two orders meet.
        return newestFirst
            .slice()
            .reverse()
            .map((p) => ({
                id: p.id,
                senderUserId: p.authorUserId,
                body: p.body,
                createdAt: p.createdAt,
                // The BOOLEAN, not a fabricated date. A channel post has no
                // deletion timestamp: the three removal columns are collapsed
                // so a reader cannot tell a moderator's act from the author's.
                deleted: p.deleted,
            }));
    }, [data, older, sameChannel]);

    const canPost = channel?.joined === true && channel?.banned !== true;

    const send = React.useCallback(
        async (body: string) => {
            setPosting(true);
            try {
                await apiPost(`${feedPath}/posts`, { body });
                await mutate();
                return true;
            } catch {
                // RETURN FALSE TO KEEP THE TEXT. The composer clears on
                // anything that is not `false`, and its own docblock records
                // what that cost: the text used to be cleared unconditionally
                // and synchronously, so a failed send lost the operator's
                // words. A channel post can fail for reasons the operator can
                // act on — slow mode, a ban, a refused mention — so losing it
                // here would be worse than on a DM.
                return false;
            } finally {
                setPosting(false);
            }
        },
        [feedPath, mutate],
    );

    const name = channel
        ? (locale === 'bg' ? channel.nameBg : channel.nameEn)
        : '';

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 space-y-tight pb-default">
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t('breadcrumbCurrent'), href: `/t/${tenantSlug}/channels` },
                        { label: name || t('breadcrumbChannel') },
                    ]}
                />
                <Heading level={1}>{name || t('title')}</Heading>
            </div>

            {error ? (
                <ErrorState description={t('loadError')} onRetry={() => void mutate()} />
            ) : isLoading && messages.length === 0 ? (
                <div className="space-y-default" aria-busy="true">
                    {[0, 1, 2].map((i) => (
                        <Skeleton key={i} className="h-12 w-full rounded-lg" />
                    ))}
                </div>
            ) : (
                <>
                    {hasMore ? (
                        <div className="shrink-0 pb-default text-center">
                            <Button
                                variant="secondary"
                                onClick={() => void loadOlder()}
                                disabled={loadingOlder}
                            >
                                {t('loadOlder')}
                            </Button>
                        </div>
                    ) : null}
                    {messages.length === 0 ? (
                        <EmptyState variant="no-records" title={t('feedEmpty')} />
                    ) : (
                        <MessageTimeline
                            ref={timeline}
                            messages={messages}
                            myUserId={myUserId}
                            className="min-h-0 flex-1"
                        />
                    )}
                    {canPost ? (
                        <div className="shrink-0 pt-default">
                            <MessageComposer
                                onSend={send}
                                pending={posting}
                                placeholder={t('composerPlaceholder')}
                                sendLabel={t('send')}
                            />
                        </div>
                    ) : (
                        /*
                         * NAMED, not a disabled composer. The database refuses
                         * a non-member's post, so a composer here could only
                         * fail — and the way in is the directory's Join
                         * button, which this says out loud.
                         */
                        <div className="shrink-0 pt-default text-xs text-content-muted">
                            {channel?.banned ? t('bannedHere') : t('joinToPost')}{' '}
                            <Link
                                href={`/t/${tenantSlug}/channels`}
                                className="underline"
                            >
                                {t('title')}
                            </Link>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
