import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getMachineryDepreciation } from '@/app-layer/usecases/machinery-depreciation';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * GET /api/t/:slug/costs/machinery — straight-line depreciation of the
 * machine register, the cost basis behind `Asset.purchaseCost`.
 *
 * Reported ALONGSIDE the crop rollup, never folded into it: a tractor is
 * not consumed by one planting, and quietly adding it would move every
 * existing figure on /costs. Returns `method: 'NONE'` with no charges
 * for a tenant that has not opted in — "not computed" and "costs
 * nothing" must not render identically.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const result = await getMachineryDepreciation(ctx);
        return jsonWithETag(req, result);
    },
);
