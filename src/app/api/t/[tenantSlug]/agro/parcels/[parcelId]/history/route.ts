import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getParcelHistory } from '@/app-layer/usecases/parcel-history';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * GET /api/t/{slug}/agro/parcels/{parcelId}/history
 *
 * Everything known about what this parcel has grown and had done to it:
 * authored crop seasons, COMPLETED field operations, and weed observations.
 *
 * ── Why one endpoint rather than three ──
 *
 * The three sources are read together or not at all — the screen is a single
 * chronological archive, and a client assembling it from three requests would
 * render three loading states for one list. They are also cheap: all three are
 * indexed on `(tenantId, parcelId, …)` and scoped to one parcel.
 *
 * ── Why the id is a path segment ──
 *
 * Same reason as the sibling `analysis` route: iOS writes the full request URL
 * including the query string to the unified log, below any logging the app
 * controls. An id in a query string is an id in a device-local log.
 *
 * ETag'd because a parcel's history changes rarely — a crop is recorded once a
 * season — while the screen is revisited often.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; parcelId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const url = new URL(req.url);
        const limitRaw = url.searchParams.get('limit');
        // NOTE on the CFNetwork warning in the docblock above: a cursor is
        // base64url of `<sortKey>|<rowId>`, so it CONTAINS a row id — encoded,
        // not removed. Base64 is not redaction. These are internal cuids for
        // the tenant's own rows rather than personal data, so they are
        // acceptable here, but a client should not treat "it's a cursor" as
        // meaning the URL carries no identifiers.
        const history = await getParcelHistory(ctx, params.parcelId, {
            limit: limitRaw ? Number(limitRaw) : undefined,
            seasonsBefore: url.searchParams.get('seasonsBefore'),
            operationsBefore: url.searchParams.get('operationsBefore'),
            weedsBefore: url.searchParams.get('weedsBefore'),
        });
        return jsonWithETag(req, history);
    },
);
