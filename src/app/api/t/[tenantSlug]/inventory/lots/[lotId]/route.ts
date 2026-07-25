import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { getLot, updateLotLocation } from '@/app-layer/usecases/inventory';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * Lot position update. `locationId` is the ONLY mutable field here — quantity
 * changes go through the ledger (`/receive`, `/adjust`), never a lot-row
 * update, so widening this schema needs a look at the single-writer invariant
 * in `src/lib/inventory/stock-ledger.ts` first.
 *
 * `null` unassigns the lot from its bin; the field is required so a PATCH
 * cannot silently mean "nothing".
 */
const UpdateLotSchema = z
    .object({
        locationId: z.string().min(1).nullable(),
    })
    .strip();

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; lotId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'INVENTORY');
        const lot = await getLot(ctx, params.lotId);
        return jsonResponse(lot);
    },
);

export const PATCH = withApiErrorHandling(
    withValidatedBody(
        UpdateLotSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; lotId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'INVENTORY');
            const result = await updateLotLocation(ctx, params.lotId, body.locationId);
            return jsonResponse(result);
        },
    ),
);
