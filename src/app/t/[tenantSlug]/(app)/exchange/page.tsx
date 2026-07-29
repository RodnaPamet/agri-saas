import { getTenantCtx } from '@/app-layer/context';
import { requireModule } from '@/lib/security/require-module';
import { ExchangeClient } from './ExchangeClient';

/**
 * Exchange main page — a map of Bulgaria showing every tenant's P2P offers,
 * with a synced, filterable offer list. Data is fetched client-side from
 * `/api/t/<slug>/exchange/listings`.
 *
 * The module gate lives HERE rather than in the group `layout.tsx`, because
 * browsing is PARTICIPATION in the marketplace while `/exchange/my-listings`
 * is CUSTODY of your own rows and must stay reachable after an opt-out. See
 * that layout for the full reasoning.
 */
export default async function ExchangePage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    await requireModule(ctx, 'EXCHANGE');
    return <ExchangeClient />;
}
