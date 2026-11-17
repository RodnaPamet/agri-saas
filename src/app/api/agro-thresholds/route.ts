import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { jsonWithETag } from '@/lib/http/etag';
import { THRESHOLDS, thresholdCrops, thresholdsFor } from '@/lib/agro/thresholds/load';

/**
 * `GET /api/agro-thresholds[?crop=]` — pest and disease thresholds (ПИВ),
 * from МЗХ's integrated-production guide (agrent-ios#636).
 *
 * Person-scoped and farm-free like `/api/agro-calendar`, and NOT behind a
 * feature flag by owner ruling ("merge and switch on for everyone",
 * 2026-11-17) — see `/api/agro-benchmarks` for why ungated rather than
 * gated-and-flipped.
 *
 * Each threshold carries its guide page. The wording is plain Bulgarian; the
 * figure and the stage are the guide's own, never changed.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    await getUserCtx(req);

    const crop = req.nextUrl.searchParams.get('crop') ?? undefined;
    if (crop !== undefined && !thresholdCrops().includes(crop)) {
        // Named rather than empty: "no thresholds" for a crop the guide does
        // not cover is a different claim from "no pest crosses a threshold".
        throw badRequest('`crop` is not a crop these thresholds cover');
    }

    return jsonWithETag(req, {
        schemaVersion: THRESHOLDS.schemaVersion,
        compiledAt: THRESHOLDS.compiledAt,
        conventions: THRESHOLDS.conventions,
        sources: THRESHOLDS.sources,
        thresholds: thresholdsFor(crop),
    });
});
