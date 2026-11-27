/**
 * POST /api/t/[tenantSlug]/evidence/[id]/retention
 * Set retention dates on evidence. ADMIN/EDITOR only.
 * Body: { retentionUntil?, retentionPolicy?, retentionDays? }
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { updateEvidenceRetention } from '@/app-layer/usecases/evidence-retention';
import { jsonResponse } from '@/lib/api-response';
import { EvidenceRetentionSchema } from '@/lib/schemas';


export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const body = EvidenceRetentionSchema.parse(await req.json());
    const result = await updateEvidenceRetention(ctx, params.id, body);
    return jsonResponse(result);
});
