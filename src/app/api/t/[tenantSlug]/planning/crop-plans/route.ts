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

const CreateCropPlanSchema = z
    .object({
        seasonId: z.string().min(1, 'A season is required'),
        cropTypeId: z.string().min(1, 'A crop type is required'),
        cropVarietyId: z.string().nullable().optional(),
        locationId: z.string().nullable().optional(),
        parcelId: z.string().nullable().optional(),
        name: z.string().min(1, 'Crop plan name is required').max(200),
        method: z.enum(['DIRECT_SOW', 'TRANSPLANT']).optional(),
        firstSowDate: z.string().min(8, 'First sow date is required'),
        successions: z.number().int().min(1).max(365).optional(),
        intervalDays: z.number().int().min(0).max(365).optional(),
        plantsPerSuccession: z.number().int().min(0).max(10000000).nullable().optional(),
        bedLengthM: z.number().min(0).max(1000000).nullable().optional(),
        rowsPerBed: z.number().int().min(0).max(1000).nullable().optional(),
        targetAreaM2: z.number().min(0).max(100000000).nullable().optional(),
        status: z.enum(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
        notes: z.string().max(5000).nullable().optional(),
    })
    .strip();

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
