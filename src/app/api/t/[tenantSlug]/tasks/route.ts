import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listTasks, listTasksPaginated, createTask } from '@/app-layer/usecases/task';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateTaskSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { jsonResponse } from '@/lib/api-response';
import { LIST_BACKFILL_CAP, applyBackfillCap } from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

const TaskQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    status: z.string().optional(),
    type: z.string().optional(),
    severity: z.string().optional(),
    priority: z.string().optional(),
    assigneeUserId: z.string().optional(),
    controlId: z.string().optional(),
    due: z.enum(['overdue', 'next7d']).optional(),
    q: z.string().optional().transform(normalizeQ),
    linkedEntityType: z.string().optional(),
    linkedEntityId: z.string().optional(),
}).strip();

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = TaskQuerySchema.parse(sp);

    const hasPagination = query.limit || query.cursor;
    if (hasPagination) {
        const result = await listTasksPaginated(ctx, {
            limit: query.limit,
            cursor: query.cursor,
            filters: {
                status: query.status,
                type: query.type,
                severity: query.severity,
                priority: query.priority,
                assigneeUserId: query.assigneeUserId,
                controlId: query.controlId,
                due: query.due,
                q: query.q,
                linkedEntityType: query.linkedEntityType,
                linkedEntityId: query.linkedEntityId,
            },
        });
        return jsonResponse(result);
    }

    // PR-9 — backfill cap. Mirrors the seven other list-page routes.
    // Ask for cap+1 rows; helper slices and reports `truncated`.
    // Client renders TruncationBanner above the table when the cap
    // fired.
    const tasks = await listTasks(
        ctx,
        {
            status: query.status,
            type: query.type,
            severity: query.severity,
            priority: query.priority,
            assigneeUserId: query.assigneeUserId,
            controlId: query.controlId,
            due: query.due,
            q: query.q,
            linkedEntityType: query.linkedEntityType,
            linkedEntityId: query.linkedEntityId,
        },
        { take: LIST_BACKFILL_CAP + 1 },
    );
    const result = applyBackfillCap(tasks);
    // PR-9 — row-count observability.
    recordListPageRowCount({
        entity: 'tasks',
        count: result.rows.length,
        truncated: result.truncated,
        tenantId: ctx.tenantId,
    });
    return jsonResponse(result);
});

export const POST = withApiErrorHandling(withValidatedBody(CreateTaskSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const task = await createTask(ctx, body);
    return jsonResponse(task, { status: 201 });
}));
