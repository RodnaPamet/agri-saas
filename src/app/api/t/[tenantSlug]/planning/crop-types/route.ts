import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listCropTypes, createCropType } from '@/app-layer/usecases/crop-planning';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { CreateCropTypeSchema } from '@/app-layer/schemas/planning.schemas';

/**
 * Crop types — the tenant crop catalog (PLANNING module).
 *   GET  → list crop types (alphabetical, with variety counts).
 *   POST → create a crop type (write-gated).
 */


export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'PLANNING');
        const cropTypes = await listCropTypes(ctx);
        return jsonResponse(cropTypes);
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateCropTypeSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'PLANNING');
            const cropType = await createCropType(ctx, body);
            return jsonResponse(cropType, { status: 201 });
        },
    ),
);
