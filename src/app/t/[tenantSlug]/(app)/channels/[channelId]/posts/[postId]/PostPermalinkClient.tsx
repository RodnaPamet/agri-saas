'use client';

/**
 * One post and its thread, reached by a link (#3030).
 *
 * ## It is the SAME timeline, deliberately
 *
 * `MessageTimeline` renders the post and its replies, so day grouping, bubble
 * grouping, the removal collapse and the author line all arrive from P8.3's
 * primitives rather than being spelled a second time here. #2939's exit
 * criterion — no second timeline implementation — covers this page too, and
 * the author label is imported for the reason its own module records: a post's
 * attribution is a disclosure rule, and two spellings of one is how #2961's
 * removal collapse came to serve what the other read path hid.
 *
 * ## Oldest-first with NO reversal, which is the opposite of the feed
 *
 * The feed reverses once, because `readChannelFeed` is newest-first (a reader
 * wants what is new) while a timeline reads downward. A THREAD is already
 * oldest-first — `…/replies` pages on `after` for exactly that reason — so
 * there is nothing to reverse, and reversing "for consistency" would put the
 * answers above the question.
 *
 * ## A reply links UP rather than rendering its parent
 *
 * A push for a reply names the REPLY, so a permalink to one is a legitimate
 * thing to hold, and `readPost` accepts it. Threads are one level deep
 * (P9.3b), so a reply has no replies of its own and the page would otherwise
 * show a single bubble with no context. It offers the parent's permalink
 * instead of fetching and rendering it: one more read on every reply link, to
 * show content the reader can reach in one tap, is a cost paid on every
 * notification for a context most readers already have.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import useSWR from 'swr';

import {
    MessageTimeline,
    type TimelineMessage,
} from '@/components/chat/message-timeline';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Heading } from '@/components/ui/typography';
import { apiGet } from '@/lib/api-client';
import { makeAuthorLabel, type ChannelAuthor } from '@/lib/channels/author-label';

interface PostWire {
    id: string;
    authorUserId: string;
    author: ChannelAuthor | null;
    body: string;
    kind: string;
    createdAt: string;
    deleted: boolean;
    resolvedAt: string | null;
    replyCount: number;
}

interface PostResponse {
    post: PostWire;
    channelId: string;
    parentPostId: string | null;
}

interface RepliesResponse {
    replies: PostWire[];
    hasMore: boolean;
}

export function PostPermalinkClient({
    tenantSlug,
    channelId,
    postId,
    myUserId,
}: {
    tenantSlug: string;
    channelId: string;
    postId: string;
    myUserId: string;
}) {
    const t = useTranslations('channels');
    const authorLabel = React.useMemo(
        () => makeAuthorLabel((vars) => t('authorNameAndFarm', vars)),
        [t],
    );

    // LITERAL person-scoped paths — channel policies key on `app.user_id`, so
    // `useTenantApiUrl()` would build a tenant route that reads zero rows with
    // no error (#1664).
    const postPath = `/api/social/channel-posts/${encodeURIComponent(postId)}`;
    const { data, error, isLoading, mutate } = useSWR<PostResponse>(
        postPath,
        (url: string) => apiGet<PostResponse>(url),
    );

    // Conditional on the post having any, so a reply's permalink issues no
    // second request: `null` as the SWR key is how a fetch is skipped.
    const wantsReplies = Boolean(data && !data.parentPostId && data.post.replyCount > 0);
    const { data: thread } = useSWR<RepliesResponse>(
        wantsReplies ? `${postPath}/replies` : null,
        (url: string) => apiGet<RepliesResponse>(url),
    );

    const messages: TimelineMessage[] = React.useMemo(() => {
        if (!data) return [];
        // NO reversal — see the header. The post, then its answers in the
        // order they were given.
        return [data.post, ...(thread?.replies ?? [])].map((p) => ({
            id: p.id,
            senderUserId: p.authorUserId,
            body: p.body,
            createdAt: p.createdAt,
            // The BOOLEAN, not a fabricated date: a channel post has no
            // deletion timestamp, because the three removal columns are
            // collapsed so a reader cannot tell a moderator's act from the
            // author's.
            deleted: p.deleted,
            senderLabel: authorLabel(p.author),
        }));
    }, [data, thread, authorLabel]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 space-y-tight pb-default">
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t('breadcrumbCurrent'), href: `/t/${tenantSlug}/channels` },
                        {
                            label: t('breadcrumbChannel'),
                            href: `/t/${tenantSlug}/channels/${channelId}`,
                        },
                        { label: t('permalinkBreadcrumb') },
                    ]}
                />
                <Heading level={1}>{t('permalinkBreadcrumb')}</Heading>
            </div>

            {error ? (
                /*
                 * One state for every failure, including the 404. A post that
                 * was hard-deleted and a post id that never existed are the
                 * same observation from here, and the server deliberately
                 * tells them apart no further.
                 */
                <ErrorState
                    description={t('permalinkLoadError')}
                    onRetry={() => void mutate()}
                />
            ) : isLoading || !data ? (
                <div className="space-y-default" aria-busy="true">
                    {[0, 1].map((i) => (
                        <Skeleton key={i} className="h-12 w-full rounded-lg" />
                    ))}
                </div>
            ) : (
                <>
                    {data.parentPostId ? (
                        <div className="shrink-0 pb-default text-xs text-content-muted">
                            <Link
                                href={`/t/${tenantSlug}/channels/${channelId}/posts/${data.parentPostId}`}
                                className="underline"
                            >
                                {t('permalinkParentLink')}
                            </Link>
                        </div>
                    ) : null}

                    <MessageTimeline
                        messages={messages}
                        myUserId={myUserId}
                        className="min-h-0 flex-1"
                    />

                    {wantsReplies && thread?.hasMore ? (
                        /*
                         * NAMED rather than paged. A thread is one level deep
                         * and this page is a destination for a link, not a
                         * reading surface — the channel is where a long thread
                         * is read, and it already pages.
                         */
                        <div className="shrink-0 pt-default text-xs text-content-muted">
                            {t('permalinkMoreInChannel')}{' '}
                            <Link
                                href={`/t/${tenantSlug}/channels/${channelId}`}
                                className="underline"
                            >
                                {t('permalinkOpenChannel')}
                            </Link>
                        </div>
                    ) : (
                        <div className="shrink-0 pt-default text-xs text-content-muted">
                            <Link
                                href={`/t/${tenantSlug}/channels/${channelId}`}
                                className="underline"
                            >
                                {t('permalinkOpenChannel')}
                            </Link>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
