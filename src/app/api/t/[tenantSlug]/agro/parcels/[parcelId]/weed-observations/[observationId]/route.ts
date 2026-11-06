import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    deleteParcelWeedObservation,
    updateParcelWeedObservation,
} from '@/app-layer/usecases/parcel-history';
import { UpdateWeedObservationSchema } from '@/app-layer/schemas/parcel-history.schemas';
import { withValidatedBody } from '@/lib/validation/route';
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

/**
 * PATCH /api/t/{slug}/agro/parcels/{parcelId}/weed-observations/{observationId}
 *
 * Correct an observation in place. Same partial contract as the crop-season
 * PATCH, and the same typed-variable construction for the same reason.
 *
 * `weeds` replaces the list WHOLE and cannot empty it — the server
 * re-partitions it into catalogue keys and free text, so both columns move
 * together, and an emptied observation would assert that somebody looked and
 * found nothing. DELETE is the remedy for one that should not exist.
 */
export const PATCH = withApiErrorHandling(
    withValidatedBody(
        UpdateWeedObservationSchema,
        async (
            req,
            {
                params: paramsPromise,
            }: { params: Promise<{ tenantSlug: string; parcelId: string; observationId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);

            const patch: Parameters<typeof updateParcelWeedObservation>[2] = {};
            if (body.observedAt !== undefined) patch.observedAt = new Date(body.observedAt);
            if (body.weeds !== undefined) patch.weeds = body.weeds;
            if (body.notes !== undefined) patch.notes = body.notes;

            const row = await updateParcelWeedObservation(ctx, params.observationId, patch);
            return jsonResponse({ id: row.id });
        },
    ),
);
