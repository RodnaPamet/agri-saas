import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import {
    listAssetMaintenance,
    createAssetMaintenance,
} from '@/app-layer/usecases/asset-maintenance';
import { withValidatedBody } from '@/lib/validation/route';
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

const CreateMaintenanceSchema = z.object({
    kind: z.enum(['SERVICE', 'REPAIR', 'INSPECTION', 'BREAKDOWN']),
    openedAt: z.string().datetime().optional(),
    closedAt: z.string().datetime().nullable().optional(),
    meterAtService: z.coerce.number().min(0).nullable().optional(),
    description: z.string().max(5000).nullable().optional(),
    cost: z.coerce.number().min(0).nullable().optional(),
    vendorId: z.string().min(1).nullable().optional(),
    nextDueAt: z.string().datetime().nullable().optional(),
    nextDueMeter: z.coerce.number().min(0).nullable().optional(),
});

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
        CreateMaintenanceSchema,
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
