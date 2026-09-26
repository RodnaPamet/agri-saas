import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listSeasons, createSeason } from '@/app-layer/usecases/crop-planning';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { CreateSeasonSchema } from '@/app-layer/schemas/planning.schemas';

/**
 * Seasons — crop-planning season windows (PLANNING module).
 *   GET  → list seasons (most-recent first).
 *   POST → create a season.
 */


export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'PLANNING');
        const seasons = await listSeasons(ctx);
        return jsonResponse(seasons);
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateSeasonSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'PLANNING');
            const season = await createSeason(ctx, body);
            return jsonResponse(season, { status: 201 });
        },
    ),
);
