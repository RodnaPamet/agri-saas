import { getTenantCtx } from '@/app-layer/context';
import { getCostRollupByPlanting } from '@/app-layer/usecases/cost-rollup';
import { CostsClient } from './CostsClient';

export const dynamic = 'force-dynamic';

/**
 * Costs — Server Component (read-only cost rollup report).
 *
 * Fetches the default `by=planting` rollup server-side, then delegates
 * the dimension toggle (planting / field / season) + table to the client
 * island, which refetches `/grain/costs?by=…` on switch. The GRAIN module
 * gate is handled once in the route-group layout. This is NOT an
 * EntityListPage — it's a dimension-toggle report with no faceted
 * filters or mutations.
 */
export default async function GrainCostsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    const { rows, truncated } = await getCostRollupByPlanting(ctx);

    return (
        <CostsClient
            tenantSlug={tenantSlug}
            initialBy="planting"
            initialData={{
                by: 'planting',
                rows: JSON.parse(JSON.stringify(rows)),
                truncated,
            }}
        />
    );
}
