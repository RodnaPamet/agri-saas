import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listBins, createBin } from '@/app-layer/usecases/grain-bin';
import { CreateBinSchema } from '@/app-layer/schemas/grain.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * Grain bins — BIN/STORAGE Locations that hold harvested produce (GRAIN
 * module).
 *   GET  → list bins with a computed fill (storedQuantity / capacity / %).
 *   POST → create a bin (a Location with kind BIN/STORAGE + capacity).
 */

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        const bins = await listBins(ctx);
        return jsonWithETag(req, bins);
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateBinSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'GRAIN');
            const bin = await createBin(ctx, body);
            return jsonResponse(bin, { status: 201 });
        },
    ),
);
