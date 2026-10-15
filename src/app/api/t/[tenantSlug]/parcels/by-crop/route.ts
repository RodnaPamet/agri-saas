import { getTenantCtx } from '@/app-layer/context';
import {
    listTenantCropTotals,
    listTenantParcelsByCrop,
} from '@/app-layer/usecases/parcel';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';
import { NextRequest } from 'next/server';

type Ctx = { params: Promise<{ tenantSlug: string }> };

/**
 * Farm-wide parcels grouped by crop — the treatment record's step 2 (#1740).
 *
 * TWO answers behind one path, chosen by `?crop=`:
 *
 *   - no `crop`  → the farm's crops, with parcel counts and total hectares.
 *     No geometry, because the crop picker draws nothing.
 *   - `?crop=X`  → that crop's parcels, each with its block and a simplified
 *     outline for the map beside the list.
 *
 * Split on a parameter rather than returned together because step 2 shows ONE
 * crop at a time: a single response carrying every crop's geometry would be
 * large for a client that discards all but one group.
 *
 * `simplify` is accepted and bounded for the same reason the location parcels
 * route accepts one — a phone map needs fewer vertices than a desktop one, and
 * the caller knows which it is. Geometry here is simplified either way; the
 * parameter only chooses how much.
 */
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: Ctx) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);

    const crop = req.nextUrl.searchParams.get('crop');
    if (crop == null || crop.trim().length === 0) {
        const crops = await listTenantCropTotals(ctx);
        // An ETag-bearing response rather than a plain one (#1845). This read is now
        // on `PERSISTABLE_PATHS`, so a phone keeps it across launches and
        // revalidates on open — and without an ETag that revalidation is a
        // FULL body, not a 304. That is the whole cost argument the 24h age
        // rests on, and CLAUDE.md's rule for a cacheable list GET.
        return jsonWithETag(req, { crops });
    }

    // A malformed `simplify` is IGNORED rather than refused: it is a display
    // hint, and failing a parcel list because a tolerance did not parse would
    // turn a cosmetic mistake into an empty map.
    const raw = Number(req.nextUrl.searchParams.get('simplify'));
    const simplifyTolerance = Number.isFinite(raw) && raw > 0 ? raw : undefined;

    const parcels = await listTenantParcelsByCrop(ctx, crop, { simplifyTolerance });
    return jsonWithETag(req, { cropType: crop.trim(), parcels });
});
