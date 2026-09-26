import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { updateSeason } from '@/app-layer/usecases/crop-planning';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { UpdateSeasonSchema } from '@/app-layer/schemas/planning.schemas';

/**
 * A single season (PLANNING module).
 *   PATCH → update season fields (name / window / status / notes),
 *           write-gated. Every field optional.
 */


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
