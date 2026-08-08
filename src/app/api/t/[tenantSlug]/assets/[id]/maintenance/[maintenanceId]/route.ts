import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import {
    closeAssetMaintenance,
    deleteAssetMaintenance,
} from '@/app-layer/usecases/asset-maintenance';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * One maintenance record.
 *
 *   PATCH  → close it (the only mutation today)
 *   DELETE → remove a mistaken entry
 *
 * Closing returns `suggestStatus: 'ACTIVE'` when this was the LAST open
 * record on the machine — advisory only, the UI prompts rather than
 * flipping the asset's status as a side effect.
 */

const CloseMaintenanceSchema = z.object({
    closedAt: z.string().datetime().nullable().optional(),
});

export const PATCH = withApiErrorHandling(
    withValidatedBody(
        CloseMaintenanceSchema,
        async (
            req,
            {
                params: paramsPromise,
            }: { params: Promise<{ tenantSlug: string; id: string; maintenanceId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await closeAssetMaintenance(
                ctx,
                params.id,
                params.maintenanceId,
                body.closedAt,
            );
            return jsonResponse(result);
        },
    ),
);

export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        {
            params: paramsPromise,
        }: { params: Promise<{ tenantSlug: string; id: string; maintenanceId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await deleteAssetMaintenance(ctx, params.id, params.maintenanceId);
        return jsonResponse({ success: true });
    },
);
