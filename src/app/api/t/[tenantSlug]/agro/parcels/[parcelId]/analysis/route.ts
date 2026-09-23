import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { analyzeParcelRisk } from '@/app-layer/usecases/parcel-risk';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * GET /api/t/{slug}/agro/parcels/{parcelId}/analysis
 *
 * Sentinel-2-derived vegetation + moisture risk for one parcel. Replaces
 * `GET /agro/parcel-analysis?parcelId=…`, which carried the id in the QUERY
 * STRING.
 *
 * ── Why the id moved out of the query ──
 *
 * iOS writes the FULL request URL, query included, to the unified log from
 * Apple's own networking layer. That happens below any logging the app
 * controls and cannot be suppressed, so an id in a query string is an id in a
 * device-local log for anything built on this route. Headers and bodies are
 * not logged; path segments are, but this route is about to be consumed by
 * the native client and the cheap fix is available now rather than after.
 *
 * Every sibling under `/agro` already takes its id as a path segment
 * (`data-streams/{streamId}/readings`); `parcel-analysis` was the only one
 * that did not, so this is the house shape rather than a new one.
 *
 * ── Why an ETag ──
 *
 * The usecase caches per (tenant, parcel, date) in Redis for 6h, so a repeat
 * request is already cheap for the SERVER. It was not cheap for the CLIENT: a
 * phone on rural LTE re-downloaded the whole body every time. `jsonWithETag`
 * honours `If-None-Match` and answers 304, which is the convention every
 * other hot read on this product follows.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; parcelId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const result = await analyzeParcelRisk(ctx, params.parcelId);
        return jsonWithETag(req, result);
    },
);
