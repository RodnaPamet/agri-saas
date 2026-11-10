import { notFound } from 'next/navigation';

import { getTenantCtx } from '@/app-layer/context';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { ChannelFeedClient } from './ChannelFeedClient';

/**
 * One channel's feed (P9.5, #2939).
 *
 * The gate, the 404 and the reason the tenant context is resolved at all are
 * all written up on the directory page beside this one. In short: the flag
 * only — no module, because a channel depends on none — and `notFound()`
 * rather than a redirect, matching what the API answers on the same flag.
 *
 * `myUserId` is passed because `MessageTimeline` needs it to decide which side
 * each bubble sits on. It is the only thing from the server the client could
 * not ask for itself: everything else is person-scoped and comes from
 * `/api/social/…`.
 */
export default async function ChannelFeedPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; channelId: string }>;
}) {
    const { tenantSlug, channelId } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!(await isFeatureEnabled('social.channels', ctx.userId))) notFound();

    return (
        <ChannelFeedClient
            tenantSlug={tenantSlug}
            channelId={channelId}
            myUserId={ctx.userId}
        />
    );
}
