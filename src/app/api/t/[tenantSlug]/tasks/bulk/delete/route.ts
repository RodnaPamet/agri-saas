/**
 * POST /api/t/:slug/tasks/bulk/delete
 *
 * Bulk soft-delete tasks (the tasks table selection action-row). Permission
 * (write) + tenant isolation enforced in `bulkDeleteTask`. Body:
 * `{ taskIds: string[] }` (1..100). Returns `{ deleted: n }`.
 *
 * ALL-OR-NOTHING (owner ruling, recorded in `task.policies.ts`): a refusal
 * leaves every selected row intact rather than part of the selection gone.
 * Both refusals carry `details.refusedTaskIds` so a client can untick exactly
 * the rows that blocked the call (#3063):
 *
 *   403 TASK_DELETE_NOT_PERMITTED  — created by somebody else, caller not admin
 *   409 TASK_BELONGS_TO_TREATMENT  — a share of a recorded treatment
 *
 * SOFT delete: `Task` is in `SOFT_DELETE_TARGETS`, so this stamps `deletedAt`
 * rather than destroying rows, and comments are untouched. Permanent removal
 * is `retention-purge`'s job. A client must not describe this as permanent.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { bulkDeleteTask } from '@/app-layer/usecases/task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { BulkTaskDeleteSchema } from '@/lib/schemas';

export const POST = withApiErrorHandling(
    withValidatedBody(
        BulkTaskDeleteSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await bulkDeleteTask(ctx, body.taskIds);
            return jsonResponse(result);
        },
    ),
);
