import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listTaskComments, addTaskComment } from '@/app-layer/usecases/task';
import { withValidatedBody } from '@/lib/validation/route';
import { AddTaskCommentSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; taskId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const comments = await listTaskComments(ctx, params.taskId);
    return jsonResponse(comments);
});

export const POST = withApiErrorHandling(withValidatedBody(AddTaskCommentSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; taskId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    // Offline exactly-once — a comment typed in a field is replayed from the
    // outbox with its item id as the Idempotency-Key, so a re-send over flaky
    // rural LTE returns the original comment rather than posting it twice.
    const idempotencyKey = req.headers.get('Idempotency-Key') || undefined;
    const comment = await addTaskComment(ctx, params.taskId, body.body, idempotencyKey);
    return jsonResponse(comment, { status: 201 });
}));
