/**
 * POST /api/t/[tenantSlug]/evidence/retention/sweep
 * Admin-only: run retention sweep.
 * Body: { dryRun?: boolean }
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { runRetentionSweepUsecase } from '@/app-layer/usecases/evidence-retention';
import { jsonResponse } from '@/lib/api-response';
import { EvidenceRetentionSweepSchema } from '@/lib/schemas';


export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const body = EvidenceRetentionSweepSchema.parse(await req.json());
    const result = await runRetentionSweepUsecase(ctx, { dryRun: body.dryRun });
    return jsonResponse(result);
});
