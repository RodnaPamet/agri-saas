import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { jsonWithETag } from '@/lib/http/etag';
import { BENCHMARKS, benchmarkCommodities, benchmarksFor } from '@/lib/agro/benchmarks/load';

/**
 * `GET /api/agro-benchmarks[?commodity=]` — national average yields and
 * coupled-support rates (agrent-ios#638).
 *
 * ## Person-scoped and farm-free, like `/api/agro-calendar`
 *
 * Published Bulgarian figures, identical for every farm, so `getUserCtx` and
 * no `tenantSlug`: it works before a farmer has a farm.
 *
 * ## NOT behind a feature flag, by owner ruling
 *
 * "Merge and switch on for everyone" (owner, 2026-11-17). A flag the owner
 * wants on from the first deploy is a row that has to be written to
 * production by hand before the route answers anything but 404, so it is
 * ungated rather than gated-and-flipped. Signed-in only, as every
 * `/api/` route outside the public list.
 *
 * ## Figures as printed, never converted
 *
 * Yields in kg/ha, rates in the order's own currency as integer minor units.
 * A client wanting kg/дка divides by 10, which is exact; nothing here
 * divides, indexes or converts, because a derived figure is a number no
 * cited page supports.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    await getUserCtx(req);

    const commodity = req.nextUrl.searchParams.get('commodity') ?? undefined;
    if (commodity !== undefined && !benchmarkCommodities().includes(commodity)) {
        // Named rather than empty: an empty answer would read as "we cover
        // this crop and have no figure", which is a different claim.
        throw badRequest('`commodity` is not a crop these benchmarks cover');
    }

    const { yields, supportRates } = benchmarksFor({ commodity });
    return jsonWithETag(req, {
        schemaVersion: BENCHMARKS.schemaVersion,
        compiledAt: BENCHMARKS.compiledAt,
        conventions: BENCHMARKS.conventions,
        sources: BENCHMARKS.sources,
        yields,
        supportRates,
    });
});
