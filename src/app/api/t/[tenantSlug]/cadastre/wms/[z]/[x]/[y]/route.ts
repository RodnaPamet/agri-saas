/**
 * GET /api/t/[tenantSlug]/cadastre/wms/{z}/{x}/{y}
 *
 * Same-origin, bounded proxy for the Bulgarian cadastre (КККР / АГКК) WMS,
 * re-served as XYZ raster tiles so MapLibre's raster source can render it.
 *
 * Why a server-side proxy (not a direct browser WMS call like the ISRIC soil
 * layer): the paid №8002 cadastre licence is IP-BOUND to the VM's fixed
 * address, so tiles MUST originate server-side — a browser fetch would come
 * from the user's IP and be rejected/metered wrongly. The proxy also keeps the
 * upstream URL + any credentials entirely server-side (the client only ever
 * sees this same-origin template).
 *
 * Strictly bounded to bound abuse of an IP-metered upstream:
 *   - zoom FLOOR (z ≥ 10) — low-zoom tiles fan across the whole country;
 *   - Bulgaria envelope — a tile outside the national extent is refused;
 *   - x/y validated against the 2^z grid.
 * Any refusal, and any upstream 404/5xx/network failure, returns 204 so the
 * map simply skips the tile and degrades gracefully.
 *
 * Tiles are Redis-cached (7-day TTL) keyed `(source, z, x, y)` — mirroring the
 * agro index-tile cache — and carry `Cache-Control: public, max-age=604800,
 * immutable` so the browser + any CDN help too.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { resolveCadastreSource } from '@/lib/geo/cadastre-source';
import {
    buildCadastreWmsUrl,
    buildCadastreArcgisExportUrl,
    cadastreTileCacheKey,
    isCadastreZoomAllowed,
    isTileInBulgaria,
    tileTo3857Bbox,
} from '@/lib/geo/cadastre-tiles';
import { getRedis } from '@/lib/redis';

const TILE_CACHE_TTL_SECONDS = 604_800; // 7 days — parcel boundaries are stable
const IMMUTABLE_CACHE = 'public, max-age=604800, immutable';

/** Empty-tile response — MapLibre treats 204 as "no tile here" and moves on. */
function emptyTile(): Response {
    return new Response(null, { status: 204 });
}

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        {
            params: paramsPromise,
        }: { params: Promise<{ tenantSlug: string; z: string; x: string; y: string }> },
    ) => {
        const params = await paramsPromise;
        // Auth + tenant-access gate before any upstream work.
        await getTenantCtx(params, req);

        // Feature unconfigured → nothing to serve (the toggle is hidden client
        // side, but a direct request must still degrade cleanly).
        const src = resolveCadastreSource();
        if (!src) return emptyTile();

        const z = Number.parseInt(params.z, 10);
        const x = Number.parseInt(params.x, 10);
        // `{y}` may arrive with a `.png` suffix from a MapLibre tile template.
        const y = Number.parseInt(params.y.replace(/\.png$/i, ''), 10);

        // Structurally invalid address → 400 (never a fetch).
        if (
            !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) ||
            x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z
        ) {
            return new Response('Invalid tile coordinates', { status: 400 });
        }

        // Zoom floor / ceiling + Bulgaria envelope — bound the IP-metered
        // upstream. Out-of-bounds is a silent empty tile, not an error.
        if (!isCadastreZoomAllowed(z) || !isTileInBulgaria(z, x, y)) {
            return emptyTile();
        }

        const cacheKey = cadastreTileCacheKey(src.source, z, x, y);
        const redis = getRedis();

        // Cache hit — the tile bytes are stored base64 (Redis strings are safe
        // for text; binary round-trips can corrupt under the default encoding).
        if (redis) {
            try {
                const cached = await redis.get(cacheKey);
                if (cached) {
                    return new Response(Buffer.from(cached, 'base64'), {
                        status: 200,
                        headers: { 'Content-Type': 'image/png', 'Cache-Control': IMMUTABLE_CACHE },
                    });
                }
            } catch {
                /* redis hiccup — fall through and fetch */
            }
        }

        const bbox = tileTo3857Bbox(z, x, y);
        // ArcGIS REST `export` for a `…/MapServer` upstream (АГКК's parcels
        // are served this way — its WMS is disabled); classic WMS `GetMap`
        // otherwise. ArcGIS refuses without a same-domain Referer, so send the
        // upstream's own origin (any cadastre.bg referer is accepted).
        const upstream =
            src.mode === 'arcgis'
                ? buildCadastreArcgisExportUrl(src.url, bbox)
                : buildCadastreWmsUrl(src.url, src.layers, bbox);
        const upstreamHeaders: Record<string, string> = { Accept: 'image/png,*/*' };
        if (src.mode === 'arcgis') {
            upstreamHeaders.Referer = new URL(src.url).origin + '/';
        }

        let res: globalThis.Response;
        try {
            // Server-side fetch: never forward the caller's cookies/credentials
            // to the upstream (the licence is IP-bound to this VM, not the user).
            res = await fetch(upstream, { headers: upstreamHeaders });
        } catch {
            return emptyTile();
        }

        // Upstream miss / error → empty tile so the map degrades gracefully.
        if (!res.ok || res.status === 204) return emptyTile();

        const body = Buffer.from(await res.arrayBuffer());
        if (body.byteLength === 0) return emptyTile();

        if (redis) {
            try {
                await redis.set(cacheKey, body.toString('base64'), 'EX', TILE_CACHE_TTL_SECONDS);
            } catch {
                /* redis hiccup — the tile is still returned, just uncached */
            }
        }

        return new Response(body, {
            status: 200,
            headers: {
                'Content-Type': res.headers.get('content-type') ?? 'image/png',
                'Cache-Control': IMMUTABLE_CACHE,
                'Content-Length': String(body.byteLength),
            },
        });
    },
);
