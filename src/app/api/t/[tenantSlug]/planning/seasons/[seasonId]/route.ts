import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { updateSeason } from '@/app-layer/usecases/crop-planning';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * A single season (PLANNING module).
 *   PATCH → update season fields (name / window / status / notes),
 *           write-gated. Every field optional.
 */

const UpdateSeasonSchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        year: z.number().int().min(1900).max(3000).nullable().optional(),
        startDate: z.string().min(8).optional(),
        endDate: z.string().min(8).optional(),
        status: z.enum(['PLANNING', 'ACTIVE', 'CLOSED']).optional(),
        notes: z.string().max(5000).nullable().optional(),
    })
    .strip();

export const PATCH = withApiErrorHandling(
    withValidatedBody(
        UpdateSeasonSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; seasonId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'PLANNING');
            const season = await updateSeason(ctx, params.seasonId, body);
            return jsonResponse(season);
        },
    ),
);
