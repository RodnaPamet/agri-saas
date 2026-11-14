import { notFound } from 'next/navigation';

import { getTenantCtx } from '@/app-layer/context';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { PostPermalinkClient } from './PostPermalinkClient';

/**
 * One post, addressable (#3030).
 *
 * ## Why a page and not a `?post=` reader on the feed
 *
 * The push notification for a mention or a reply names a POST, and until this
 * existed its link pointed at `/channels/{channelId}?post={postId}` — a query
 * string nothing read, so tapping a notification landed the reader at the top
 * of a channel feed with no indication of which post had been about them. On a
 * busy channel that is a search, not a destination.
 *
 * A `?post=` reader on the feed page was the cheaper option and was rejected:
 * it gives the notification somewhere to land, and it gives nobody a link they
 * can SEND. A permalink is a thing you paste to a neighbour, and agrent-ios
 * has parsed this five-segment shape since their #591 — so the web answering
 * it is what makes the two clients agree about what a post link means.
 *
 * ## The gate is the flag alone
 *
 * Same as the feed and the directory beside it: no module gate, because a
 * channel depends on none, and `notFound()` rather than a redirect, matching
 * what the API answers on the same flag. P8.4 is why that matters — a module
 * gate REDIRECTS, so the symptom of getting it wrong is "my channels
 * vanished" rather than an error.
 *
 * ## A removed post still resolves here
 *
 * `readPost` answers 200 with the removal collapse applied — present, empty
 * body, no author — rather than 404, because the link may be sitting in
 * somebody's notification from before the removal. A 404 would read as "that
 * never existed" when the truth is "that is gone", and the row's existence is
 * not the secret; its content is.
 */
export default async function ChannelPostPermalinkPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; channelId: string; postId: string }>;
}) {
    const { tenantSlug, channelId, postId } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!(await isFeatureEnabled('social.channels', ctx.userId))) notFound();

    return (
        <PostPermalinkClient
            tenantSlug={tenantSlug}
            channelId={channelId}
            postId={postId}
            myUserId={ctx.userId}
        />
    );
}
