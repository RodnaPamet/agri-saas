import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { getBin, updateBin, deleteBin } from '@/app-layer/usecases/grain-bin';
import { UpdateBinSchema } from '@/app-layer/schemas/grain.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * A single grain bin (GRAIN module).
 *   GET    → the bin with its computed fill AND the lots inside it.
 *   PATCH  → update bin fields (name / kind / capacity; write-gated).
 *   DELETE → soft-delete the bin, REFUSED while stock is still assigned
 *            (deleting an occupied bin would orphan its lots: still on hand,
 *            invisible to every bin view).
 */

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; binId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        const bin = await getBin(ctx, params.binId);
        return jsonResponse(bin);
    },
);

export const PATCH = withApiErrorHandling(
    withValidatedBody(
        UpdateBinSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; binId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'GRAIN');
            const bin = await updateBin(ctx, params.binId, body);
            return jsonResponse(bin);
        },
    ),
);

export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; binId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        const result = await deleteBin(ctx, params.binId);
        return jsonResponse(result);
    },
);
