/** GET /api/t/[tenantSlug]/assets/[id]/evidence — evidence inherited from the asset's mapped practices (read-only). */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getAssetInheritedEvidence } from '@/app-layer/usecases/inherited-practice-data';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    return jsonResponse(await getAssetInheritedEvidence(ctx, params.id));
});
