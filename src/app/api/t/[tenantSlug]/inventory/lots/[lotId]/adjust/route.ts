import { getTenantCtx } from '@/app-layer/context';
import { adjustStock } from '@/app-layer/usecases/inventory';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { z } from 'zod';
import { AdjustSchema } from '@/app-layer/schemas/inventory.schemas';


export const POST = withApiErrorHandling(
    withValidatedBody(
        AdjustSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; lotId: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'INVENTORY');
            const res = await adjustStock(ctx, params.lotId, body.delta, body.reason);
            return jsonResponse(res);
        },
    ),
);
