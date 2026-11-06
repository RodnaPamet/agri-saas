import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { deleteParcelCropSeason, updateParcelCropSeason } from '@/app-layer/usecases/parcel-history';
import { UpdateCropSeasonSchema } from '@/app-layer/schemas/parcel-history.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * DELETE /api/t/{slug}/agro/parcels/{parcelId}/crop-seasons/{seasonId}
 *
 * Soft-delete. The row itself is retained like every other agronomic record
 * here.
 *
 * This used to say "a mistyped year is corrected by removing the row", which
 * was true until PATCH below existed (owner ruling 2026-11-06). A correction is
 * now an edit; DELETE is for a season that should not exist at all.
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

/**
 * PATCH /api/t/{slug}/agro/parcels/{parcelId}/crop-seasons/{seasonId}
 *
 * Correct a season in place. Partial: a field omitted leaves the stored value
 * alone, an explicit `null` clears a nullable one, and the schema refuses
 * `null` on the two required fields.
 *
 * The patch is built through a TYPED variable rather than conditional spreads.
 * TypeScript's excess-property check does not see through a spread, so
 * `...(x !== undefined && { croptype: x })` would compile and silently drop the
 * field; an assignment to a typed property is checked.
 *
 * `parcelId` is not in the body and cannot be changed — see the usecase.
 */
export const PATCH = withApiErrorHandling(
    withValidatedBody(
        UpdateCropSeasonSchema,
        async (
            req,
            {
                params: paramsPromise,
            }: { params: Promise<{ tenantSlug: string; parcelId: string; seasonId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);

            const patch: Parameters<typeof updateParcelCropSeason>[2] = {};
            if (body.year !== undefined) patch.year = body.year;
            if (body.cropType !== undefined) patch.cropType = body.cropType;
            // `=== null` kept explicit: `body.sownAt ? … : null` — which is what
            // the CREATE route does — collapses undefined and null, and the
            // whole contract here is that they differ.
            if (body.sownAt !== undefined) {
                patch.sownAt = body.sownAt === null ? null : new Date(body.sownAt);
            }
            if (body.harvestedAt !== undefined) {
                patch.harvestedAt = body.harvestedAt === null ? null : new Date(body.harvestedAt);
            }
            if (body.notes !== undefined) patch.notes = body.notes;
            if (body.yieldKgPerDca !== undefined) patch.yieldKgPerDca = body.yieldKgPerDca;

            const row = await updateParcelCropSeason(ctx, params.seasonId, patch);
            return jsonResponse({ id: row.id });
        },
    ),
);
