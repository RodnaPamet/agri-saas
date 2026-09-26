import { getTenantCtx } from '@/app-layer/context';
import { receiveStock } from '@/app-layer/usecases/inventory';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { z } from 'zod';
import { ReceiveSchema } from '@/app-layer/schemas/inventory.schemas';


export const POST = withApiErrorHandling(
    withValidatedBody(
        ReceiveSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; lotId: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'INVENTORY');
            const res = await receiveStock(ctx, params.lotId, body.quantity);
            return jsonResponse(res);
        },
    ),
);
