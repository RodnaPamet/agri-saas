import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { fetchOrthoTile } from '@/app-layer/usecases/ortho-imagery';

export const runtime = 'nodejs';

/**
 * GET /api/t/[tenantSlug]/ortho/tiles/{z}/{x}/{y} — МЗХ orthophoto (#2421).
 *
 * A 256² Web Mercator JPEG, from the newest year whose flight polygon covers
 * the tile. Signed-in only, so this is not an open proxy onto a government
 * service, and the upstream URL never reaches the client.
 *
 * ## Three answers, and the difference between two of them is the whole point
 *
 * | answer | meaning | what the phone does |
 * | --- | --- | --- |
 * | `200` jpeg | imagery | draws it |
 * | `204` | no imagery here, FINAL | plain ground, kept for the session |
 * | `503` | we could not find out | re-requests on the next redraw |
 *
 * The sibling cadastre proxy answers 204 for every failure including upstream
 * 5xx, which is right for MapLibre and would be wrong here: the phone caches a
 * 204 for the session, so one transient upstream failure would leave a farm
 * looking at bare ground until the app restarts. `fetchOrthoTile` keeps
 * `absent` and `unavailable` apart for exactly that, and this route must not
 * flatten them on the way out.
 *
 * ## No ETag and no 304, deliberately
 *
 * `Cache-Control: immutable` gets the caching benefit through URLSession's own
 * cache without a conditional round-trip. An `ETag` invites `If-None-Match`,
 * and the client's documented answer-handling (agrent-ios #459) has branches
 * for 200-with-image, 204/404/501, and 5xx — but none for 304. A 304 would
 * fall into "not an image" and be drawn as plain ground, which is the same
 * silent-blank failure the 204/503 split exists to avoid. Worth revisiting
 * once the client has a 304 branch; not worth guessing it has one.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        {
            params: paramsPromise,
        }: { params: Promise<{ tenantSlug: string; z: string; x: string; y: string }> },
    ) => {
        const params = await paramsPromise;
        // Auth and tenant access before any upstream work.
        const ctx = await getTenantCtx(params, req);

        const z = Number.parseInt(params.z, 10);
        const x = Number.parseInt(params.x, 10);
        // A MapKit or MapLibre template may append an extension.
        const y = Number.parseInt(params.y.replace(/\.(jpe?g|png)$/i, ''), 10);

        const tile = await fetchOrthoTile(ctx, z, x, y);

        if (tile.kind === 'absent') {
            // Contentless on purpose: 204 has no body, and the phone reads the
            // status alone.
            return new Response(null, { status: 204 });
        }
        if (tile.kind === 'unavailable') {
            return new Response(null, {
                status: 503,
                // Nothing about a failure is cacheable, and the phone retries
                // on its next redraw rather than on a timer.
                headers: { 'Cache-Control': 'no-store' },
            });
        }

        return new Response(new Uint8Array(tile.bytes), {
            status: 200,
            headers: {
                'Content-Type': tile.contentType,
                'Content-Length': String(tile.bytes.byteLength),
                // Imagery for a past year does not change.
                'Cache-Control': 'public, max-age=604800, immutable',
                // Which flight year the pixels came from, so a client or an
                // operator can tell without re-asking /coverage.
                'X-Ortho-Year': String(tile.year),
            },
        });
    },
);
