import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { restorePractice } from '@/app-layer/usecases/practice';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const result = await restorePractice(ctx, params.practiceId);
    return jsonResponse(result);
});
