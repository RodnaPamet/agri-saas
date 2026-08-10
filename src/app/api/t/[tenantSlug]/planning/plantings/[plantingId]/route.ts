import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { updatePlanting } from '@/app-layer/usecases/crop-planning';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * A single planting (PLANNING module).
 *   PATCH → update planting-level fields the succession engine does not
 *           own — today just the grower-entered planned yield. The wire
 *           format is ALWAYS per hectare (`plannedYieldKgPerHa`), same
 *           as the stored column; the UI converts to/from кг/дка at its
 *           own boundary (`haToDca`/`dcaToHa` in
 *           `src/lib/agro/rate-calc.ts`) before/after calling this
 *           route. `null` clears a previously-set estimate — it is NOT
 *           the same as `0` (see `Planting.plannedYieldKgPerHa`'s schema
 *           doc), so it is accepted explicitly rather than stripped.
 */
const UpdatePlantingSchema = z
    .object({
        plannedYieldKgPerHa: z.number().min(0).max(1_000_000).nullable().optional(),
    })
    .strip();

export const PATCH = withApiErrorHandling(
    withValidatedBody(
        UpdatePlantingSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; plantingId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'PLANNING');
            const planting = await updatePlanting(ctx, params.plantingId, body);
            return jsonResponse(planting);
        },
    ),
);
