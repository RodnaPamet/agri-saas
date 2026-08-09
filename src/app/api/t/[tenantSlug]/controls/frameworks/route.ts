import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listFrameworks } from '@/app-layer/usecases/framework';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const frameworks = await listFrameworks(ctx);
    return jsonResponse(frameworks);
});
