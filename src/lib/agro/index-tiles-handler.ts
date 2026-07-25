/**
 * Shared handler for the satellite-index tile routes
 * (`/api/t/[tenantSlug]/agro/<index>-tiles`).
 *
 * NDVI / NDMI / NDRE / GNDVI / EVI all have the SAME request shape and
 * caching behaviour — only the Earth-Engine tile function + the cache-key
 * prefix differ. Each route file stays a thin `GET` that calls
 * `handleIndexTiles(index, getTileUrl, req, params)`; the route imports its
 * own `get<Index>TileUrl` so the per-route unit tests keep mocking a single
 * named function.
 *
 *   GET ?locationId=<id>&date=<YYYY-MM-DD>
 *     → { configured: boolean, tileUrl: string, date?: string, error?: string }
 *
 * `configured:false` ⇒ this deployment has no GEE credentials (the client
 * shows a muted hint). `tileUrl:''` with `configured:true` ⇒ configured but
 * nothing to show (no field geometry, or a transient generation failure in
 * `error`) — the overlay simply stays off without breaking the map.
 *
 * `date` is the imagery's REAL acquisition date, not the requested one. The
 * Earth-Engine composite falls back to the latest available window when the
 * requested one holds no imagery, so the two legitimately differ (the wall
 * clock outruns the published Sentinel-2 archive, or a cloudy stretch emptied
 * the window). Reporting the request back would label old imagery with a fresh
 * date; the client shows this value verbatim. Falls back to the requested end
 * date only when EE could not report an acquisition date at all.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { listLocationParcels } from '@/app-layer/usecases/location';
import { isGeeConfigured } from '@/lib/agro/earth-engine';
import type { IndexTileResult, NdviAoi, NdviWindow } from '@/lib/agro/earth-engine';
import type { VegetationIndex } from '@/lib/agro/vegetation-indices';
import { getRedis } from '@/lib/redis';
import { jsonResponse } from '@/lib/api-response';

const QuerySchema = z.object({
    locationId: z.string().min(1),
    // Optional inspection date; defaults to today. The composite window is
    // the 30 days ENDING on this date.
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const CACHE_TTL_SECONDS = 21_600; // 6h — comfortably inside the EE mapid lifetime
const WINDOW_DAYS = 30;

function ymd(d: Date): string {
    return d.toISOString().slice(0, 10);
}

/**
 * Run the shared tile-route pipeline for `index`, generating the composite
 * via `getTileUrl` (the index's `get<Index>TileUrl` from `earth-engine.ts`).
 */
/**
 * Union the location's parcel polygons into a single GeoJSON MultiPolygon so
 * the Earth-Engine composite can be clipped to the fields' exact shape (not
 * the bounding box). Returns `null` when no parcel carries a usable polygon —
 * the caller then falls back to the bbox clip.
 */
function parcelClipGeometry(
    parcels: Array<{ geometry?: unknown }>,
): { type: 'MultiPolygon'; coordinates: unknown[] } | null {
    const coordinates: unknown[] = [];
    for (const p of parcels) {
        const g = p.geometry as { type?: string; coordinates?: unknown } | null | undefined;
        if (!g || !Array.isArray(g.coordinates)) continue;
        if (g.type === 'Polygon') coordinates.push(g.coordinates);
        else if (g.type === 'MultiPolygon') coordinates.push(...(g.coordinates as unknown[]));
    }
    return coordinates.length > 0 ? { type: 'MultiPolygon', coordinates } : null;
}

export async function handleIndexTiles(
    index: VegetationIndex,
    getTileUrl: (aoi: NdviAoi, win: NdviWindow, clipGeometry?: unknown) => Promise<IndexTileResult>,
    req: NextRequest,
    paramsPromise: Promise<{ tenantSlug: string }>,
) {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);

    // No GEE creds on this deploy → tell the client to stay quiet.
    if (!isGeeConfigured()) {
        return jsonResponse({ configured: false, tileUrl: '' });
    }

    const query = QuerySchema.parse(
        Object.fromEntries(req.nextUrl.searchParams.entries()),
    );

    // Resolve the location's field bounds [west, south, east, north].
    // `bounds` is a Prisma Json column — validate the tuple shape before
    // use so a malformed/absent value just skips the overlay.
    const { bounds, parcels } = await listLocationParcels(ctx, query.locationId);
    const box = bounds as unknown as number[] | null;
    if (!box || !Array.isArray(box) || box.length < 4) {
        // Configured, but the location has no mapped field yet.
        return jsonResponse({ configured: true, tileUrl: '' });
    }
    const [west, south, east, north] = box;
    // Clip the raster to the parcels' polygons (falls back to the bbox when a
    // location has no usable parcel geometry).
    const clipGeometry = parcelClipGeometry(parcels as Array<{ geometry?: unknown }>);

    const endDate = query.date ? new Date(`${query.date}T00:00:00Z`) : new Date();
    const end = ymd(endDate);
    const startDate = new Date(endDate.getTime() - WINDOW_DAYS * 86_400_000);
    const start = ymd(startDate);

    // The cached VALUE is now a `{ tileUrl, acquiredDate }` JSON pair rather
    // than a bare URL string, so the key generation moves `clip2` → `clip3`:
    // a `clip2` entry written by the previous deploy would `JSON.parse`-throw
    // (or worse, parse a URL-shaped string) if read under the new shape.
    const cacheKey = `${index}:tile:${ctx.tenantId}:${query.locationId}:clip3:${end}`;
    const redis = getRedis();

    // Cache hit — return the still-valid tile URL with the date of the imagery
    // it was generated from (NOT the requested date).
    if (redis) {
        try {
            const cached = await redis.get(cacheKey);
            if (cached) {
                const hit = JSON.parse(cached) as { tileUrl?: string; acquiredDate?: string | null };
                if (hit?.tileUrl) {
                    return jsonResponse({
                        configured: true,
                        tileUrl: hit.tileUrl,
                        date: hit.acquiredDate ?? end,
                    });
                }
            }
        } catch {
            /* redis hiccup or an unreadable entry — fall through and generate */
        }
    }

    let result: IndexTileResult;
    try {
        result = await getTileUrl({ west, south, east, north }, { start, end }, clipGeometry ?? undefined);
    } catch {
        // A GEE failure must not break the map — report it softly so the
        // overlay stays off and the rest of the page works.
        return jsonResponse({ configured: true, tileUrl: '', date: end, error: 'generation_failed' });
    }

    if (redis) {
        try {
            await redis.set(
                cacheKey,
                JSON.stringify({ tileUrl: result.tileUrl, acquiredDate: result.acquiredDate }),
                'EX',
                CACHE_TTL_SECONDS,
            );
        } catch {
            /* redis hiccup — the URL is still returned, just uncached */
        }
    }

    // The real acquisition date is the honest label; the requested `end` is
    // only a fallback for when EE couldn't report one.
    return jsonResponse({ configured: true, tileUrl: result.tileUrl, date: result.acquiredDate ?? end });
}
