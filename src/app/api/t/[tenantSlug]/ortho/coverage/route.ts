import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { resolveOrthoCoverage } from '@/app-layer/usecases/ortho-imagery';
import { parseLonLatBbox } from '@/lib/geo/ortho-bbox';

export const runtime = 'nodejs';

/**
 * GET /api/t/[tenantSlug]/ortho/coverage?bbox=minLon,minLat,maxLon,maxLat
 *
 * Which flight year covers this area, and when it was flown — the footer the
 * phone prints under «Ортофотокарта» (#2421).
 *
 * `year: null` is an ordinary answer meaning no year we serve has imagery
 * here, not a failure. The client falls back to the bare attribution.
 *
 * The bbox is a QUERY parameter rather than a path segment, unlike the tile
 * handle. iOS writes the full URL including the query string to the device
 * log, which is why ids and secrets must never go there — a bounding box is
 * neither. Four public coordinates of the farmer's own viewport reveal
 * nothing the map on their screen does not.
 */
const Query = z.object({ bbox: z.string().min(1) });

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);

        const { bbox } = Query.parse({
            bbox: new URL(req.url).searchParams.get('bbox') ?? '',
        });
        const parsed = parseLonLatBbox(bbox);

        const coverage = await resolveOrthoCoverage(ctx, parsed);
        return jsonResponse(coverage, {
            headers: { 'Cache-Control': 'private, max-age=3600' },
        });
    },
);
