import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getMetricTrends } from '@/app-layer/usecases/metric-trends';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * GET /api/t/:tenantSlug/dashboard/trends?days=90
 *
 * Returns daily compliance KPI snapshots for trend visualization.
 */
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const days = parseInt(req.nextUrl.searchParams.get('days') ?? '90', 10);
    const payload = await getMetricTrends(ctx, isNaN(days) ? 90 : days);
    return jsonResponse(payload);
});
