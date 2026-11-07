import { notFound } from 'next/navigation';

import { getTenantCtx } from '@/app-layer/context';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { DmConversationClient } from './DmConversationClient';

/**
 * One direct conversation (P8.4, #2798).
 *
 * ## `dm/` is a STATIC segment beside `[threadId]`, deliberately
 *
 * The sibling route is `threads/[threadId]`, and Next resolves a static
 * segment before a dynamic one — so `threads/dm/<id>` can never be read as a
 * thread whose id happens to be `dm`. It keeps direct messages inside the
 * exchange messaging surface, which is where the owner ruled they go, without
 * either route having to inspect the other's ids.
 *
 * ## The gate is the FLAG only — no module
 *
 * The parent screen gates each half separately and the reason is written up
 * there: a direct message depends on no module, so gating it on EXCHANGE would
 * make a farm lose its messages by switching the marketplace off. Here that
 * means the flag and nothing else.
 *
 * `notFound()` rather than a redirect: a saved link to a conversation that the
 * flag has since turned off is a URL that does not resolve, and sending
 * somebody to a dashboard instead would read as "your conversation was
 * deleted". The API answers 404 on the same flag, so the two halves agree.
 *
 * ## Why the tenant context is resolved at all
 *
 * Only to authenticate and to render the farm chrome this route sits inside —
 * the conversation itself is person-scoped and is fetched by the client from
 * `/api/social/…`, which runs `runInUserContext`. Nothing here passes
 * `ctx.tenantId` to a DM read, and nothing should: those policies key on
 * `app.user_id`, which a tenant transaction does not set, so a tenant-scoped
 * read returns zero rows with no error (#1664).
 */
export default async function DirectConversationPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; conversationId: string }>;
}) {
    const { tenantSlug, conversationId } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    const [directMessages, personBlocks] = await Promise.all([
        isFeatureEnabled('social.direct-messages', ctx.userId),
        isFeatureEnabled('social.person-blocks', ctx.userId),
    ]);

    if (!directMessages) notFound();

    return (
        <DmConversationClient
            conversationId={conversationId}
            myUserId={ctx.userId}
            personBlocksEnabled={personBlocks}
        />
    );
}
