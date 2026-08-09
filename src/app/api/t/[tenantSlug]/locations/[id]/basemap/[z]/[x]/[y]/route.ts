/**
 * GET /api/t/[tenantSlug]/locations/[id]/basemap/{z}/{x}/{y}
 *
 * Same-origin, bounded-per-location BASEMAP tile proxy (Roadmap-6 P1b).
 *
 * The operator map blanks at zero bars because every basemap source is
 * cross-origin and the service worker passes cross-origin requests through
 * untouched. This route re-serves a licence-permissive basemap SAME-ORIGIN,
 * so an installed field user can pre-download a location's backdrop and the
 * SW can cache it into its dedicated basemap cache.
 *
 * Source + licensing: the upstream is the MapLibre demotiles vector tiles
 * (Natural Earth, public domain) — the SAME source the app already renders as
 * its keyless fallback basemap. We deliberately do NOT proxy/cache live
 * MapTiler tiles: MapTiler's licence for a wholesale offline copy is unclear,
 * so a bounded user-initiated download of its imagery would be a licensing
 * risk. Natural-earth demotiles are unambiguously redistributable. See
 * `src/lib/offline/basemap-pack.ts` for the full rationale.
 *
 * Strictly bounded: the tile address is validated against the demotiles zoom
 * range AND (when the location has a bbox) against that bbox — a tile outside
 * the location's extent is a 404, so this endpoint can never fan out into an
 * unbounded crawl of the upstream source.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getLocationBounds } from '@/app-layer/usecases/location';
import { withApiErrorHandling } from '@/lib/errors/api';
import {
    BASEMAP_MAX_ZOOM,
    BASEMAP_MIN_ZOOM,
    BASEMAP_UPSTREAM_TILE_TEMPLATE,
    isTileInBbox,
} from '@/lib/offline/basemap-pack';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string; z: string; x: string; y: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);

        const z = Number.parseInt(params.z, 10);
        const x = Number.parseInt(params.x, 10);
        // The `{y}` may arrive with a `.pbf` extension (MapLibre tile URL).
        const y = Number.parseInt(params.y.replace(/\.pbf$/i, ''), 10);

        // Validate the tile address: the demotiles native zoom range and a
        // valid x/y within the 2^z grid. A bad address is a 400, never a fetch.
        if (
            !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) ||
            z < BASEMAP_MIN_ZOOM || z > BASEMAP_MAX_ZOOM ||
            x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z
        ) {
            return new Response('Invalid tile coordinates', { status: 400 });
        }

        // Bound to the location's bbox when it has one — the pack is a single
        // location's backdrop, not an open basemap proxy. A missing location
        // is a 404 (via the usecase).
        const bounds = await getLocationBounds(ctx, params.id);
        if (bounds && !isTileInBbox(bounds, z, x, y)) {
            return new Response(null, { status: 404 });
        }

        const upstream = BASEMAP_UPSTREAM_TILE_TEMPLATE
            .replace('{z}', String(z))
            .replace('{x}', String(x))
            .replace('{y}', String(y));

        let res: globalThis.Response;
        try {
            res = await fetch(upstream, {
                // Never forward the caller's cookies/credentials to the public
                // upstream; this is an anonymous natural-earth fetch.
                headers: { Accept: 'application/x-protobuf,*/*' },
            });
        } catch {
            // Upstream unreachable → 204 so MapLibre simply skips the tile.
            return new Response(null, { status: 204 });
        }

        // Upstream has no tile here (ocean / out of coverage) → 204.
        if (res.status === 204 || res.status === 404) {
            return new Response(null, { status: 204 });
        }
        if (!res.ok) {
            return new Response(null, { status: 502 });
        }

        const body = await res.arrayBuffer();
        return new Response(body, {
            status: 200,
            headers: {
                'Content-Type': 'application/x-protobuf',
                // Public-domain natural-earth geometry (no tenant data) and
                // immutable per tile — long-lived cache so a downloaded pack
                // stays warm. The SW's dedicated basemap cache is the offline
                // store; this header lets the HTTP cache help too.
                'Cache-Control': 'public, max-age=604800, immutable',
                'Content-Length': String(body.byteLength),
            },
        });
    },
);
