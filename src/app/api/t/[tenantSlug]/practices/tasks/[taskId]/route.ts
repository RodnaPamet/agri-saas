import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { updatePracticeTask, deletePracticeTask } from '@/app-layer/usecases/practice';
import { withValidatedBody } from '@/lib/validation/route';
import { UpdatePracticeTaskSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const PATCH = withApiErrorHandling(withValidatedBody(UpdatePracticeTaskSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; taskId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const task = await updatePracticeTask(ctx, params.taskId, body);
    return jsonResponse(task);
}));

export const DELETE = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; taskId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await deletePracticeTask(ctx, params.taskId);
    return jsonResponse({ success: true });
});
