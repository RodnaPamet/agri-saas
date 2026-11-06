import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { deleteParcelComment } from '@/app-layer/usecases/task';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';

/**
 * DELETE /api/t/{slug}/agro/parcels/{parcelId}/comments/{commentId}
 *
 * Removes a note from a parcel — the AUTHOR, or a farm ADMIN/OWNER (owner
 * ruling 2026-11-06). Soft: the row is retained and the list read filters it
 * out, so the `PARCEL_COMMENT_DELETED` audit entry still has a subject.
 *
 * `{ ok: true }` at 200, NOT a 204, because that is what the two sibling
 * sub-resources on this very path return (`crop-seasons/{seasonId}`,
 * `weed-observations/{observationId}`). A lone 204 here would make the parcel
 * detail screen's three delete calls answer in two shapes.
 *
 * Every refusal is one contentless `PARCEL_COMMENT_NOT_FOUND` — missing,
 * already deleted, another parcel's, or somebody else's note with a non-admin
 * caller. The discrimination lives in the usecase, and the test asserts the
 * four are indistinguishable rather than merely each a 404.
 *
 * There is no PATCH. A note is not editable, which is the state of every other
 * comment surface in this API.
 */
export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        {
            params: paramsPromise,
        }: { params: Promise<{ tenantSlug: string; parcelId: string; commentId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await deleteParcelComment(ctx, params.parcelId, params.commentId);
        return jsonResponse({ ok: true });
    },
);
