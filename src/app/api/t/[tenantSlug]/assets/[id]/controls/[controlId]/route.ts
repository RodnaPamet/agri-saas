import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { unmapAssetFromPractice } from '@/app-layer/usecases/traceability';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const DELETE = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string; practiceId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await unmapAssetFromPractice(ctx, params.id, params.practiceId);
    return jsonResponse({ ok: true });
});
