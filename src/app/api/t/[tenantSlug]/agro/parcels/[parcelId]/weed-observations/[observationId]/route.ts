import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { deleteParcelWeedObservation } from '@/app-layer/usecases/parcel-history';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/** DELETE /api/t/{slug}/agro/parcels/{parcelId}/weed-observations/{observationId} */
export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        {
            params: paramsPromise,
        }: { params: Promise<{ tenantSlug: string; parcelId: string; observationId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await deleteParcelWeedObservation(ctx, params.observationId);
        return jsonResponse({ ok: true });
    },
);
