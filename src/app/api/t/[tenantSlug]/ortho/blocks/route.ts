import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { fetchOrthoBlocks } from '@/app-layer/usecases/ortho-imagery';
import { parseLonLatBbox } from '@/lib/geo/ortho-bbox';

export const runtime = 'nodejs';

/**
 * GET /api/t/[tenantSlug]/ortho/blocks?bbox=minLon,minLat,maxLon,maxLat
 *
 * The Ministry's physical blocks (ФБ) over an area, as GeoJSON in EPSG:4326
 * (#2421) — thin outlines and their numbers, drawn under the farm's own
 * parcels.
 *
 * `truncated` is the field that matters. The server caps the list at its own
 * number regardless of what the client asks for, and a cut list that does not
 * SAY it was cut reads as a complete one — a farmer would see a map missing
 * blocks with nothing to indicate it. The phone asks only below 0.12° (0.3°
 * for the farm's own bounds), which keeps a request bounded in practice, but a
 * cap that lives only in the client is not a cap.
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

        const blocks = await fetchOrthoBlocks(ctx, parsed);
        return jsonResponse(
            {
                type: 'FeatureCollection' as const,
                year: blocks.year,
                truncated: blocks.truncated,
                features: blocks.features.map((b) => ({
                    type: 'Feature' as const,
                    geometry: b.geometry,
                    properties: { id: b.id, usage: b.usage, usageCode: b.usageCode },
                })),
            },
            { headers: { 'Cache-Control': 'private, max-age=3600' } },
        );
    },
);
