import { NextRequest } from 'next/server';
import { z } from 'zod';
import { CropPlanStatus } from '@prisma/client';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listCropPlans, createCropPlan } from '@/app-layer/usecases/crop-planning';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { csvEnumField } from '@/lib/validation/query-params';
import { jsonResponse } from '@/lib/api-response';
import { CreateCropPlanSchema } from '@/app-layer/schemas/planning.schemas';

/**
 * Crop plans — the succession CONFIG the engine expands into Planting
 * rows (PLANNING module).
 *   GET  → list crop plans (optionally filtered by ?seasonId / ?status).
 *   POST → create a crop plan (write-gated).
 *
 * `status` is MULTI-value: the list toolbar declares the facet
 * `multiple: true` (see `filter-defs.ts`), so two selected statuses
 * arrive comma-joined (`?status=DRAFT,ACTIVE`). `csvEnumField` validates
 * every member against the `CropPlanStatus` enum in the schema itself —
 * an unknown value is a clean 400, never an unvalidated string reaching
 * Prisma (which threw a 500 the list page rendered as "no crop plans").
 * `seasonId` / `cropTypeId` stay plain strings — they are single-select
 * opaque ids, not multi-select facets.
 */


export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'PLANNING');
        const QuerySchema = z
            .object({
                seasonId: z.string().optional(),
                cropTypeId: z.string().optional(),
                status: csvEnumField(z.nativeEnum(CropPlanStatus)),
            })
            .strip();
        const query = QuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
        const plans = await listCropPlans(ctx, {
            seasonId: query.seasonId,
            cropTypeId: query.cropTypeId,
            status: query.status,
        });
        return jsonResponse(plans);
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateCropPlanSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'PLANNING');
            const plan = await createCropPlan(ctx, body);
            return jsonResponse(plan, { status: 201 });
        },
    ),
);
