import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listPracticeTasks, createPracticeTask } from '@/app-layer/usecases/practice';
import { withValidatedBody } from '@/lib/validation/route';
import { CreatePracticeTaskSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const tasks = await listPracticeTasks(ctx, params.practiceId);
    return jsonResponse(tasks);
});

export const POST = withApiErrorHandling(withValidatedBody(CreatePracticeTaskSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const task = await createPracticeTask(ctx, params.practiceId, body);
    return jsonResponse(task, { status: 201 });
}));
