/** @deprecated Use /api/t/[tenantSlug]/tasks with practiceId filter */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listTasksByPractice } from '@/app-layer/usecases/task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const tasks = await listTasksByPractice(ctx, params.practiceId);
    return jsonResponse(tasks);
});
