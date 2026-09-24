import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { deleteParcelCropSeason } from '@/app-layer/usecases/parcel-history';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * DELETE /api/t/{slug}/agro/parcels/{parcelId}/crop-seasons/{seasonId}
 *
 * Soft-delete — a mistyped year is corrected by removing the row, but the row
 * itself is retained like every other agronomic record here.
 */
export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        {
            params: paramsPromise,
        }: { params: Promise<{ tenantSlug: string; parcelId: string; seasonId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await deleteParcelCropSeason(ctx, params.seasonId);
        return jsonResponse({ ok: true });
    },
);
