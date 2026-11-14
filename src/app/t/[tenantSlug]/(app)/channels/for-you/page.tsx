import { notFound } from 'next/navigation';

import { getTenantCtx } from '@/app-layer/context';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { ForYouClient } from './ForYouClient';

/**
 * «За Вас» — what happened to the caller across every channel (P9.7, #2941).
 *
 * ## A STATIC segment beside `[channelId]`
 *
 * Next resolves `for-you` before the dynamic sibling, so neither route
 * inspects the other's ids — the same arrangement P8.4 used for
 * `threads/dm/[conversationId]` beside `threads/[threadId]`.
 *
 * ## The noun is «За Вас» and NOT «Активност» (owner ruling 2026-11-14)
 *
 * «Активност» is already the exact label of two entity-scoped tabs
 * (`assets.tabActivity`, `tasks.detail.tabActivity`) and a dashboard chart, all
 * meaning "this record's history". Registering it here would have made one word
 * name three unrelated destinations — `nav-vocabulary.md`'s own problem
 * inverted, and that file now carries the row with «Активност» in its `Never`
 * list so the obvious word fails loudly.
 *
 * ## The gate is the flag alone
 *
 * No module gate, as on the channel pages beside it: a channel depends on no
 * module, and a module gate REDIRECTS, so getting it wrong reads as "my
 * channels vanished" rather than as an error (P8.4).
 */
export default async function ForYouPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!(await isFeatureEnabled('social.channels', ctx.userId))) notFound();

    // No `myUserId`: unlike the feed there is no timeline deciding which side
    // a bubble sits on — every row here is somebody else's act, which is what
    // makes it "за Вас".
    return <ForYouClient tenantSlug={tenantSlug} />;
}
