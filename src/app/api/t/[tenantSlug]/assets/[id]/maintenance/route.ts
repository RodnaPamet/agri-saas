import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    listAssetMaintenance,
    createAssetMaintenance,
} from '@/app-layer/usecases/asset-maintenance';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateAssetMaintenanceSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * Maintenance history for one machine.
 *
 *   GET  → the service / repair / inspection / breakdown log, newest first
 *   POST → open (or record a completed) maintenance entry
 *
 * Ungated beyond the standard read/write tiers: this is the tab a farm
 * actually wants, unlike the compliance-era Evidence / Mappings /
 * Traceability surfaces which a plain-farm tenant has hidden.
 */


export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const rows = await listAssetMaintenance(ctx, params.id);
        return jsonResponse(rows);
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateAssetMaintenanceSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await createAssetMaintenance(ctx, params.id, body);
            return jsonResponse(result, { status: 201 });
        },
    ),
);
