import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import {
    getCostRollupByPlanting,
    getCostRollupBySeason,
    getCostRollupByField,
} from '@/app-layer/usecases/cost-rollup';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * Per-activity cost rollup (GRAIN module).
 *   GET ?by=planting|field|season (default planting) — rolls up
 *       LogEntry.costAmount + linked StockTransaction.costAmount grouped by
 *       the requested dimension. ?seasonId= narrows the planting rollup.
 */

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');

        const by = req.nextUrl.searchParams.get('by') ?? 'planting';
        // Applies to every dimension now — it used to be read only on the
        // planting branch, so a shared ?seasonId link silently showed the
        // whole farm on the field and season views.
        const seasonId = req.nextUrl.searchParams.get('seasonId') ?? undefined;
        // `truncated` rides with every shape: a partial financial total that
        // does not say it is partial is the failure this endpoint had.
        if (by === 'season') {
            const { rows, truncated } = await getCostRollupBySeason(ctx, { seasonId });
            return jsonWithETag(req, { by, rows, truncated });
        }
        if (by === 'field') {
            const { rows, truncated } = await getCostRollupByField(ctx, { seasonId });
            return jsonWithETag(req, { by, rows, truncated });
        }
        const { rows, truncated } = await getCostRollupByPlanting(ctx, { seasonId });
        return jsonWithETag(req, { by: 'planting', rows, truncated });
    },
);
