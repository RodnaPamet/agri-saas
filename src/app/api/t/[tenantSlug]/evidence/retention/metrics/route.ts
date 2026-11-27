/**
 * GET /api/t/[tenantSlug]/evidence/retention/metrics
 * Retention metrics: expiring, archived and expired counts.
 *
 * This line said "top practices" until #3080. That breakdown grouped by
 * `Evidence.practiceId`, and both the column and `Practice` went with the GRC
 * teardown (phase 3) — `getRetentionMetrics` records the removal in its own
 * body, and this route did not, so the route advertised a field the payload
 * has not carried for months.
 *
 * The three counts range over three DIFFERENT populations and `expiredCount`
 * is a sweep BACKLOG rather than a count of expired records — see #3281 and
 * `evidence-retention.paths.ts` before rendering any of them.
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
