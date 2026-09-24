import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { createParcelCropSeason } from '@/app-layer/usecases/parcel-history';
import { CreateCropSeasonSchema } from '@/app-layer/schemas/parcel-history.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/{slug}/agro/parcels/{parcelId}/crop-seasons
 *
 * Record what this parcel grew in a harvest year. Back-fillable by design —
 * an archive whose first entry can only be today is not an archive.
 */
export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateCropSeasonSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; parcelId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const row = await createParcelCropSeason(ctx, {
                parcelId: params.parcelId,
                year: body.year,
                cropType: body.cropType,
                sownAt: body.sownAt ? new Date(body.sownAt) : null,
                harvestedAt: body.harvestedAt ? new Date(body.harvestedAt) : null,
                notes: body.notes ?? null,
            });
            return jsonResponse({ id: row.id }, { status: 201 });
        },
    ),
);
