import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import {
    getCostEntry,
    updateCostEntry,
    deleteCostEntry,
} from '@/app-layer/usecases/cost-entry';
import { UpdateCostEntrySchema } from '@/app-layer/schemas/grain.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * A single cost entry (GRAIN module).
 *   GET    → the record (+ domain links and invoice, including the
 *            encrypted `description`).
 *   PATCH  → update record fields (write-gated).
 *   DELETE → soft-delete the record (write-gated).
 */

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; costEntryId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        const record = await getCostEntry(ctx, params.costEntryId);
        return jsonResponse(record);
    },
);

export const PATCH = withApiErrorHandling(
    withValidatedBody(
        UpdateCostEntrySchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; costEntryId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'GRAIN');
            const record = await updateCostEntry(ctx, params.costEntryId, body);
            return jsonResponse(record);
        },
    ),
);

export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; costEntryId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        const result = await deleteCostEntry(ctx, params.costEntryId);
        return jsonResponse(result);
    },
);
