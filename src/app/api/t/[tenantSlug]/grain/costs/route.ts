import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import {
    getCostRollupByPlanting,
    getCostRollupBySeason,
    getCostRollupByField,
} from '@/app-layer/usecases/cost-rollup';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

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
        // `truncated` rides with every shape: a partial financial total that
        // does not say it is partial is the failure this endpoint had.
        if (by === 'season') {
            const { rows, truncated } = await getCostRollupBySeason(ctx);
            return jsonResponse({ by, rows, truncated });
        }
        if (by === 'field') {
            const { rows, truncated } = await getCostRollupByField(ctx);
            return jsonResponse({ by, rows, truncated });
        }
        const seasonId = req.nextUrl.searchParams.get('seasonId') ?? undefined;
        const { rows, truncated } = await getCostRollupByPlanting(ctx, { seasonId });
        return jsonResponse({ by: 'planting', rows, truncated });
    },
);
