import { getTenantCtx } from '@/app-layer/context';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { requireModule } from '@/lib/security/require-module';
import { ThreadClient } from './ThreadClient';

/**
 * One conversation. Gated on EXCHANGE, like the inbox that links here.
 *
 * The thread id is handed to the client and no further: whether the caller is
 * a party to it is decided by RLS on every read, not by this page. A tenant
 * that guesses another's thread id gets a 404 from the route, so there is
 * nothing for this component to check that would not be a second, weaker copy
 * of the real gate.
 */
export default async function ExchangeThreadPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; threadId: string }>;
}) {
    const { tenantSlug, threadId } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    await requireModule(ctx, 'EXCHANGE');
    // P5.3 — the person-block control is gated; the report control is not,
    // because filing a DSA Art 16 notice is a legal duty. Resolved HERE
    // because there is no client-side flags hook, and the route gates again
    // independently: a client that kept the button still gets a 404.
    const personBlocksEnabled = await isFeatureEnabled('social.person-blocks', ctx.userId);
    return <ThreadClient threadId={threadId} personBlocksEnabled={personBlocksEnabled} />;
}
