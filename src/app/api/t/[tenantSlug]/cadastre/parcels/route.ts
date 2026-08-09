/**
 * GET /api/t/[tenantSlug]/cadastre/parcels?bbox=west,south,east,north
 *
 * Same-origin, bounded proxy for the FREE Bulgarian cadastre VECTOR parcels
 * layer (spp.api.bg CadBaseMap MapServer/2 — an ArcGIS FeatureServer-style
 * service). Its `/query` returns GeoJSON parcel polygons reprojected
 * server-side to EPSG:4326; MapLibre draws them as a thin boundary line layer
 * UNDER the tenant's own fields. This is the vector counterpart to the raster
 * WMS proxy (`../wms/[z]/[x]/[y]`) and the FREE default that actually renders.
 *
 * Why a server-side proxy: the upstream URL (`CADASTRE_PARCELS_URL`) stays
 * SERVER-ONLY — the browser only ever sees this same-origin endpoint + a
 * `configured` boolean. It also lets us bound abuse of a public national
 * dataset before it reaches the upstream.
 *
 * Bounds (documented caps — parcels are only useful zoomed in):
 *   - `bbox` must parse to four finite, well-ordered numbers, else 400.
 *   - The bbox must intersect Bulgaria's envelope (lon 22–29, lat 41–44.5) —
 *     an out-of-country request returns an empty FeatureCollection (200).
 *   - Each bbox span is capped at `MAX_PARCELS_BBOX_SPAN_DEG` (0.2° ≈ 15–22 km)
 *     so a low-zoom request can't pull the whole country's 1.2M parcels — over
 *     the cap returns an empty FeatureCollection (200).
 * Any upstream error / timeout also degrades to an empty FeatureCollection
 * (200) so the map simply shows no cadastre boundaries and stays usable.
 *
 * Responses are Redis-cached (1-day TTL) keyed by the rounded bbox, and carry
 * `Cache-Control: public, max-age=86400` so the browser + any CDN help too.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { resolveCadastreParcelsUrl } from '@/lib/geo/cadastre-source';
import {
    buildCadastreParcelsQueryUrl,
    cadastreParcelsCacheKey,
    emptyFeatureCollection,
    isBboxInBulgaria,
    isBboxWithinSpanCap,
    parseBbox,
    trimParcelFeatureCollection,
} from '@/lib/geo/cadastre-parcels';
import { jsonResponse } from '@/lib/api-response';
import { getRedis } from '@/lib/redis';
import type { FeatureCollection } from 'geojson';

const CACHE_TTL_SECONDS = 86_400; // 1 day — parcel boundaries are stable.
const CACHE_CONTROL = 'public, max-age=86400';
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Empty-collection 200 — the graceful-degrade payload (out-of-bounds/error). */
function emptyResponse(): ReturnType<typeof jsonResponse<FeatureCollection>> {
    return jsonResponse(emptyFeatureCollection(), {
        headers: { 'Cache-Control': CACHE_CONTROL },
    });
}

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        // Auth + tenant-access gate before any upstream work.
        await getTenantCtx(params, req);

        // Feature unconfigured → nothing to serve (the toggle is hidden client
        // side, but a direct request must still degrade cleanly).
        const upstreamBase = resolveCadastreParcelsUrl();
        if (!upstreamBase) return emptyResponse();

        // Malformed bbox → 400 (a bad request, distinct from an out-of-bounds
        // one). A valid-but-out-of-bounds bbox degrades to an empty collection.
        const bbox = parseBbox(req.nextUrl.searchParams.get('bbox'));
        if (!bbox) {
            return jsonResponse({ error: 'invalid bbox' }, { status: 400 });
        }

        // Bounds abuse — outside Bulgaria OR too large ⇒ empty collection (200).
        if (!isBboxInBulgaria(bbox) || !isBboxWithinSpanCap(bbox)) {
            return emptyResponse();
        }

        const cacheKey = cadastreParcelsCacheKey(bbox);
        const redis = getRedis();

        // Cache hit — the trimmed FeatureCollection is stored as a JSON string.
        if (redis) {
            try {
                const cached = await redis.get(cacheKey);
                if (cached) {
                    return jsonResponse(JSON.parse(cached) as FeatureCollection, {
                        headers: { 'Cache-Control': CACHE_CONTROL },
                    });
                }
            } catch {
                /* redis hiccup / bad JSON — fall through and fetch */
            }
        }

        const upstreamUrl = buildCadastreParcelsQueryUrl(upstreamBase, bbox);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

        let res: globalThis.Response;
        try {
            // Server-side fetch: never forward the caller's cookies/credentials
            // to the public upstream.
            res = await fetch(upstreamUrl, {
                headers: { Accept: 'application/json,*/*' },
                signal: controller.signal,
            });
        } catch {
            return emptyResponse();
        } finally {
            clearTimeout(timer);
        }

        // Upstream miss / error → empty collection so the map degrades cleanly.
        if (!res.ok) return emptyResponse();

        let payload: unknown;
        try {
            payload = await res.json();
        } catch {
            return emptyResponse();
        }

        // Trim to { upi, ekatte, nusetype } — drop every other upstream
        // attribute (privacy + payload weight).
        const fc = trimParcelFeatureCollection(payload);

        if (redis) {
            try {
                await redis.set(cacheKey, JSON.stringify(fc), 'EX', CACHE_TTL_SECONDS);
            } catch {
                /* redis hiccup — the collection is still returned, just uncached */
            }
        }

        return jsonResponse(fc, { headers: { 'Cache-Control': CACHE_CONTROL } });
    },
);
