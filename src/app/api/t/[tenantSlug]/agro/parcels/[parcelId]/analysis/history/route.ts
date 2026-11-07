import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getParcelRiskHistory, HISTORY_DEFAULT_DAYS } from '@/app-layer/usecases/parcel-risk';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * GET /api/t/{slug}/agro/parcels/{parcelId}/analysis/history?days=60
 *
 * The per-pass NDVI/NDMI series behind the sibling `/analysis` card — #2837.
 *
 * ## Why a separate path rather than a field on `/analysis`
 *
 * Different cache lifetime and different cost. `/analysis` is fetched on every
 * parcel-screen open and answers from a day-keyed 6h entry; a 60-day series is
 * a chart the operator asks for. Folding it in would make every card read pay
 * for the series.
 *
 * ## `days` is clamped, not refused
 *
 * `parseInt` then the usecase's own bounds, which is the house shape for this
 * param (`dashboard/task-trend` does the same). The response ECHOES the `days`
 * it actually used, so a client that asked for 400 can see it got 120 rather
 * than having to infer it from the row count — which it could not, since a
 * window with no clear passes legitimately returns none.
 *
 * ## Why an ETag
 *
 * `/analysis`'s reasoning verbatim: the server-side cost is already cached, the
 * CLIENT's was not. A pass arrives every ~5 days, so a phone re-opening the
 * chart on rural LTE gets a 304 almost always.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; parcelId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const raw = parseInt(req.nextUrl.searchParams.get('days') ?? '', 10);
        const days = Number.isNaN(raw) ? HISTORY_DEFAULT_DAYS : raw;
        const result = await getParcelRiskHistory(ctx, params.parcelId, days);
        return jsonWithETag(req, result);
    },
);
