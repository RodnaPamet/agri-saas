/**
 * GET /api/t/[tenantSlug]/locations/[id]/tiles/{z}/{x}/{y}.pbf
 *
 * Mapbox Vector Tile (MVT) endpoint for a location's parcels — the map's
 * vector source at zoom ≥ 6. The geometry is reprojected + clipped +
 * quantised in PostGIS (via the geo helper) so the wire payload is a
 * compact protobuf tile instead of a full GeoJSON FeatureCollection,
 * keeping a 50-field location fast to pan/zoom.
 *
 * Tenant- + location-scoped in the repository, so a tile can never carry
 * another tenant's or field's parcels. `{y}` arrives with the `.pbf`
 * extension (the maplibre tile URL template) — stripped before parsing.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getLocationParcelTile } from '@/app-layer/usecases/location';
import { withApiErrorHandling } from '@/lib/errors/api';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string; z: string; x: string; y: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);

        const z = Number.parseInt(params.z, 10);
        const x = Number.parseInt(params.x, 10);
        const y = Number.parseInt(params.y.replace(/\.pbf$/i, ''), 10);

        // Validate the tile address: integer z in [0,24] and x/y within the
        // 2^z grid. A bad address is a 400, never a query.
        if (
            !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) ||
            z < 0 || z > 24 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z
        ) {
            return new Response('Invalid tile coordinates', { status: 400 });
        }

        const tile = await getLocationParcelTile(ctx, params.id, z, x, y);

        // Empty tile (no parcel touches it) → 204 so the map skips it.
        if (tile.length === 0) {
            return new Response(null, { status: 204 });
        }

        return new Response(new Uint8Array(tile), {
            status: 200,
            headers: {
                'Content-Type': 'application/vnd.mapbox-vector-tile',
                // Tenant-scoped + auth'd, and parcels can change — private +
                // short TTL so an edit shows up within minutes.
                'Cache-Control': 'private, max-age=300',
                'Content-Length': String(tile.length),
            },
        });
    },
);
