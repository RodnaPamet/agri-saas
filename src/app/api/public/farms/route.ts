/**
 * P6.8 — the public farm directory.
 *
 *   GET /api/public/farms?q=&oblast=&crop=&limit=
 *
 * ## Public by construction, and it authenticates nothing
 *
 * There is no credential to verify: a stranger browsing the directory has no
 * account, which is the point. `/api/public/farms` is an EXACT entry in
 * `PUBLIC_PATH_EXACT` rather than a prefix — one path, so the narrower claim
 * is the right one, and a prefix would have opened anything added beneath it
 * later.
 *
 * ## It reads only the projection
 *
 * `searchPublicFarms` runs one parameterised query against
 * `PublicFarmProfile` under `runWithoutRls({ reason: 'public-projection-read' })`.
 * That table has no PII columns and no `tenantId`, so there is nothing to join
 * through and nothing to leak — the phase's rule holds structurally rather
 * than by review.
 *
 * ## No envelope, a bare array
 *
 * Matching the other list surfaces on this API. A client paging further is not
 * a feature here: the directory is bounded at 50 results and a visitor who
 * needs more should narrow by oblast or crop, which is what the filters are
 * for.
 */
import { NextRequest } from 'next/server';

import { searchPublicFarms } from '@/app-layer/usecases/public-farm-profile';
import { PublicFarmSearchQuerySchema } from '@/app-layer/schemas/public-farms.schemas';
import { withValidatedQuery } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const runtime = 'nodejs';

export const GET = withApiErrorHandling(
    withValidatedQuery(PublicFarmSearchQuerySchema, async (_req: NextRequest, _ctx, query) => {
        const hits = await searchPublicFarms(query);
        return jsonResponse(hits);
    }),
);
