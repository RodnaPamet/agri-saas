import { getTenantCtx } from '@/app-layer/context';
import { requireModule } from '@/lib/security/require-module';
import { MyInterestsClient } from './MyInterestsClient';

/**
 * My interests — the buyer's outbox (offers I've reached out to).
 *
 * Gated: reaching out to other farms is participation in the marketplace. The
 * sibling `/exchange/my-listings` is not gated — a pending inquiry strands
 * nobody, whereas a public listing you cannot withdraw does.
 */
export default async function MyInterestsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    await requireModule(ctx, 'EXCHANGE');
    return <MyInterestsClient />;
}
