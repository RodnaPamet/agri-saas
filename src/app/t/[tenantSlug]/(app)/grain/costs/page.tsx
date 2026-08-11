import { getTenantCtx } from '@/app-layer/context';
import { listCostEntries } from '@/app-layer/usecases/cost-entry';
import { CostsClient } from './CostsClient';

export const dynamic = 'force-dynamic';

/**
 * Costs — Server Component (the cost-ENTRY register).
 *
 * This page used to server-render a `by=planting` cost ROLLUP and hand it
 * to a dimension-toggle report. That rollup is gone: the grain net-worth
 * calculator already reports the same `ATTRIBUTED_CROP_COST` figure as
 * part of a larger answer, and `src/lib/grain/cost-metrics.ts` exists
 * because this product once shipped one word over three different
 * numbers. Two pages reporting one figure is how that happens, so the
 * duplicate was dropped rather than relocated.
 *
 * What replaced it is the thing a farmer could not do anywhere: enter a
 * cost — of any kind — in one place, with the domain attribution and the
 * invoice attached to it.
 *
 * The GRAIN module gate is handled once in the route-group layout; a
 * second `requireModule` here would be redundant work on every request
 * and a second place to forget.
 */
export default async function GrainCostsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    const { rows, totalCount, truncated } = await listCostEntries(ctx);

    return (
        <CostsClient
            tenantSlug={tenantSlug}
            initialRows={JSON.parse(JSON.stringify(rows))}
            initialTotalCount={totalCount}
            initialTruncated={truncated}
            permissions={{ canWrite: ctx.permissions.canWrite }}
        />
    );
}
