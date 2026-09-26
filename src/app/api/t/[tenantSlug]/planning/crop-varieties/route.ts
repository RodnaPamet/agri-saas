import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listCropVarieties, createCropVariety } from '@/app-layer/usecases/crop-planning';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { CreateCropVarietySchema } from '@/app-layer/schemas/planning.schemas';

/**
 * Crop varieties — the succession-engine defaults catalog (PLANNING
 * module). A variety carries the agronomic numbers (days-to-maturity,
 * spacing, seed size) the engine reads.
 *   GET  → list varieties (optionally filtered by ?cropTypeId).
 *   POST → create a variety (write-gated).
 */


export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'PLANNING');
        const QuerySchema = z.object({ cropTypeId: z.string().optional() }).strip();
        const query = QuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
        const varieties = await listCropVarieties(ctx, { cropTypeId: query.cropTypeId });
        return jsonResponse(varieties);
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateCropVarietySchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'PLANNING');
            const variety = await createCropVariety(ctx, body);
            return jsonResponse(variety, { status: 201 });
        },
    ),
);
