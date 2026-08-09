/**
 * GET /api/t/[tenantSlug]/evidence/retention/metrics
 * Retention metrics: expiring, archived, expired counts, top practices.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { getRetentionMetrics } from '@/app-layer/usecases/evidence-retention';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const metrics = await getRetentionMetrics(ctx);
    return jsonResponse(metrics);
});
