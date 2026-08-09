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

/**
 * Farm tasks — a thin surface over the IC Task module.
 *   POST → create a FARM_TASK (catalog type + Location/Parcel/Equipment
 *          links + assignee, which fires the existing TASK_ASSIGNED bell).
 *   GET  → the operator's farm queue (FARM_TASK + FIELD_OPERATION assigned
 *          to the caller, soonest-due first). `?assigneeUserId=` overrides.
 */

const CreateFarmTaskSchema = z
    .object({
        title: z.string().min(1, 'Title is required').max(500),
        farmTaskType: z.string().min(1, 'A task type is required'),
        description: z.string().max(5000).nullable().optional(),
        priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
        dueAt: z.string().nullable().optional(),
        assigneeUserId: z.string().nullable().optional(),
        locationIds: z.array(z.string().min(1)).max(100).optional(),
        parcelIds: z.array(z.string().min(1)).max(100).optional(),
        equipmentIds: z.array(z.string().min(1)).max(100).optional(),
    })
    .strip();

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
            const task = await createFarmTask(ctx, body);
            return jsonResponse(task, { status: 201 });
        },
    ),
);
