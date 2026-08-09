import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { unlinkEvidence } from '@/app-layer/usecases/practice';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const DELETE = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string; linkId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await unlinkEvidence(ctx, params.practiceId, params.linkId);
    return jsonResponse({ success: true });
});
