import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { deleteGrainDelivery } from '@/app-layer/usecases/grain-delivery';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * A single grain delivery (GRAIN module).
 *   DELETE → soft-delete the delivery (write-gated).
 *
 * Deliberately NOT nested under the contract path: a delivery id is
 * globally unique and tenant-scoped by RLS, and removing a mis-keyed
 * ticket should not require knowing which contract it was wrongly filed
 * against. Correcting tonnage is delete-and-re-record — there is no
 * PATCH, because an edited weighbridge ticket is a new fact, not a
 * revised opinion, and the audit trail should show both.
 */

export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; deliveryId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        const result = await deleteGrainDelivery(ctx, params.deliveryId);
        return jsonResponse(result);
    },
);
