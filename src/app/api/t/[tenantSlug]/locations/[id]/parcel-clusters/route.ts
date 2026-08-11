import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { getParcelOverview } from '@/app-layer/usecases/parcel-overview';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * GET /api/t/:slug/locations/:id/parcel-clusters
 *
 * Proximity clusters for one location's parcels, labelled with their
 * nearest settlement — the data behind the 2D overview that makes a
 * 100-parcel holding navigable.
 *
 * Returns via `jsonWithETag` (honours `If-None-Match` → 304) rather than
 * `jsonResponse`: this is a hot list read on a page that can hold 100+
 * parcels, and the cold-start data-cost work expects conditional
 * revalidation for cacheable list GETs. Panning and re-opening the tab
 * should cost a 304, not a full payload, on rural LTE.
 *
 * `zoom` picks the clustering grid pitch — zooming in splits clusters
 * into their members. Bounded to the range the UI actually uses so a
 * hand-typed `?zoom=9999` cannot ask for a degenerate grid.
 */
const QuerySchema = z
    .object({
        zoom: z.coerce.number().min(1).max(20).optional(),
    })
    .strip();

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const query = QuerySchema.parse(
            Object.fromEntries(req.nextUrl.searchParams.entries()),
        );
        const overview = await getParcelOverview(ctx, params.id, { zoom: query.zoom });
        return jsonWithETag(req, overview);
    },
);
