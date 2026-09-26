import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { getCropPlan, updateCropPlan, deleteCropPlan, getCropPlanProgress } from '@/app-layer/usecases/crop-planning';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { UpdateCropPlanSchema } from '@/app-layer/schemas/planning.schemas';

/**
 * A single crop plan (PLANNING module).
 *   GET    → the plan (season + crop + variety + planting count). Pass
 *            ?include=progress to also return the plan-vs-actual rows.
 *   PATCH  → update plan fields incl. lifecycle status (write-gated).
 *   DELETE → soft-delete the plan (admin-gated).
 */


export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; cropPlanId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'PLANNING');
        const plan = await getCropPlan(ctx, params.cropPlanId);
        if (req.nextUrl.searchParams.get('include') === 'progress') {
            const progress = await getCropPlanProgress(ctx, params.cropPlanId);
            return jsonResponse({ plan, progress });
        }
        return jsonResponse(plan);
    },
);

export const PATCH = withApiErrorHandling(
    withValidatedBody(
        UpdateCropPlanSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; cropPlanId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'PLANNING');
            const plan = await updateCropPlan(ctx, params.cropPlanId, body);
            return jsonResponse(plan);
        },
    ),
);

export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; cropPlanId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'PLANNING');
        const result = await deleteCropPlan(ctx, params.cropPlanId);
        return jsonResponse(result);
    },
);
