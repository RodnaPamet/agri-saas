import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listFrameworkRequirements } from '@/app-layer/usecases/practice';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; frameworkKey: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const requirements = await listFrameworkRequirements(ctx, params.frameworkKey);
    return jsonResponse(requirements);
});
