import { NextRequest } from 'next/server';
import { z } from 'zod';
import { csvEnumField, csvIdField } from '@/lib/validation/query-params';
import { WorkItemStatus } from '@prisma/client';

import { getTenantCtx } from '@/app-layer/context';
import { createFarmTask, listMyFarmTasks } from '@/app-layer/usecases/farm-task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';
import { CreateFarmTaskSchema } from '@/lib/schemas';



const FarmTaskQuerySchema = z
    .object({
        // multiple:true facets on the farm-tasks list.
        assigneeUserId: csvIdField(),
        status: csvEnumField(z.nativeEnum(WorkItemStatus)),
        // `?open=1` → only the caller's outstanding work (drives "My work").
        open: z.enum(['1', 'true']).optional(),
        // `?scope=all` → the tenant-wide manager queue (drives the /farm-tasks
        // page, which is the sole task UI); omitted/`mine` → the caller's own.
        scope: z.enum(['mine', 'all']).optional(),
    })
    .strip();

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const query = FarmTaskQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
        const tasks = await listMyFarmTasks(ctx, {
            assigneeUserId: query.assigneeUserId,
            status: query.status,
            openOnly: query.open !== undefined,
            scope: query.scope,
        });
        return jsonWithETag(req, tasks);
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateFarmTaskSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            // Offline exactly-once — the outbox replays a queued task with its
            // item id as the Idempotency-Key, and createFarmTask dedupes on it,
            // so a re-send over flaky rural LTE returns the ORIGINAL task
            // rather than minting a second one. Until this line existed the
            // client could not safely queue a task at all: the outbox was
            // already sending the header and nothing was reading it.
            const idempotencyKey = req.headers.get('Idempotency-Key') || undefined;
            const task = await createFarmTask(ctx, body, idempotencyKey);
            return jsonResponse(task, { status: 201 });
        },
    ),
);
