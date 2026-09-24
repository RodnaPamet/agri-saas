import { getTenantCtx } from '@/app-layer/context';
import { requireModule } from '@/lib/security/require-module';
import { ThreadsClient } from './ThreadsClient';

/**
 * The messages inbox.
 *
 * Gated on EXCHANGE for the same reason `/exchange/my-interests` is: a thread
 * only exists because two farms are negotiating on the marketplace, so a
 * tenant without the module has nothing here and should not be able to reach
 * the screen. The API routes gate independently — this is the screen half.
 */
export default async function ExchangeThreadsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    await requireModule(ctx, 'EXCHANGE');
    return <ThreadsClient />;
}
