import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import {
    listContractDeliveries,
    createGrainDelivery,
} from '@/app-layer/usecases/grain-delivery';
import { CreateGrainDeliverySchema } from '@/app-layer/schemas/grain.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { badRequest } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';

/**
 * Deliveries recorded against one grain contract (GRAIN module).
 *   GET  → `{ rows, fulfilment }` — the delivery ledger for this
 *          contract plus its delivered / remaining / progress position.
 *   POST → record a delivery.
 *
 * The contract id comes from the PATH; a body that names a different
 * contract is rejected rather than silently trusted, so a delivery can
 * never be posted against one contract through another's URL.
 */

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; contractId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        const result = await listContractDeliveries(ctx, params.contractId);
        return jsonResponse(result);
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateGrainDeliverySchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; contractId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'GRAIN');
            if (body.contractId !== params.contractId) {
                throw badRequest('Delivery contractId does not match the URL contract');
            }
            const delivery = await createGrainDelivery(ctx, body);
            return jsonResponse(delivery, { status: 201 });
        },
    ),
);
