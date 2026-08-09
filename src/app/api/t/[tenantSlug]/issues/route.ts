/**
 * Issue compatibility routes — thin wrappers forwarding to Task usecases.
 * @deprecated Use /api/t/[tenantSlug]/tasks instead.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listTasks, createTask } from '@/app-layer/usecases/task';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateTaskSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const sp = req.nextUrl.searchParams;
    const tasks = await listTasks(ctx, {
        status: sp.get('status') ?? undefined,
        type: sp.get('type') ?? undefined,
        severity: sp.get('severity') ?? undefined,
        priority: sp.get('priority') ?? undefined,
        assigneeUserId: sp.get('assigneeUserId') ?? undefined,
        due: (sp.get('due') as 'overdue' | 'next7d') ?? undefined,
        q: sp.get('q') ?? undefined,
    });
    return jsonResponse(tasks);
});

export const POST = withApiErrorHandling(withValidatedBody(CreateTaskSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const task = await createTask(ctx, body);
    return jsonResponse(task, { status: 201 });
}));
