/**
 * GET /api/t/[tenantSlug]/soil/wms/{z}/{x}/{y}
 *
 * Same-origin, bounded proxy for the ISRIC SoilGrids WRB WMS, re-served as XYZ
 * raster tiles (#782).
 *
 * Before this route, `MapCanvas` pointed a raster `<Source>` straight at
 * `maps.isric.org`, justified in a comment by the upstream being CORS-open.
 * CORS-open is exactly what made it a third-party dependency of the RENDERING
 * path: an operator opening Soil view fetched from ISRIC live — no timeout, no
 * fallback, no cache — and the first E2E spec to enable Soil view would have
 * put a third-party origin on a test's critical path. That is the class #764
 * closed for the basemap; this is its second instance.
 *
 * Bounds, and one deliberate NON-bound:
 *   - zoom ceiling (z ≤ SOIL_TILE_MAX_ZOOM), mirrored by the `<Source>`'s
 *     `maxzoom` so MapLibre overzooms instead of requesting a refused tile;
 *   - x/y validated against the 2^z grid;
 *   - **no geographic envelope.** The cadastre proxy has one because its
 *     upstream is a paid IP-metered licence. ISRIC is free, global and CC-BY,
 *     and the feature works anywhere today — an envelope here would silently
 *     regress the product, not bound a cost.
 *
 * Any refusal, upstream error, timeout or empty body returns 204, which
 * MapLibre reads as "no tile here" and skips. `X-Soil-Source` says which of
 * those happened, so a blank overlay is diagnosable from a response header
 * rather than by archaeology — the lesson from #781, where "the code reads the
 * env var" could not distinguish two states.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { env } from '@/env';
import { buildSoilWmsUrl, isSoilZoomAllowed, soilTileCacheKey } from '@/lib/geo/soil-tiles';
import { soilFixtureTile } from '@/lib/geo/soil-fixture-tile';
import { getRedis } from '@/lib/redis';

const TILE_CACHE_TTL_SECONDS = 604_800; // 7 days — soil classes do not move
const IMMUTABLE_CACHE = 'public, max-age=604800, immutable';

/**
 * Upstream budget. The cadastre proxy has no timeout, which is a live gap
 * there (#780 names the same shape for the basemap proxy): a hanging upstream
 * holds a Next worker for as long as it likes. A soil tile is decoration —
 * it is never worth waiting on.
 */
const UPSTREAM_TIMEOUT_MS = 8_000;

/**
 * `BodyInit` requires an `ArrayBuffer`-backed view, but a value DECLARED as
 * `Buffer` is `Buffer<ArrayBufferLike>` — and `ArrayBufferLike` admits
 * `SharedArrayBuffer`, so TypeScript refuses it even though the runtime
 * accepts a Buffer perfectly well. Re-viewing it with
 * `new Uint8Array(b.buffer, …)` does NOT help: that inherits the same
 * `ArrayBufferLike` parameter and fails identically.
 *
 * `Uint8Array.from` copies into a fresh `ArrayBuffer`, which types exactly and
 * needs no cast. The copy is one allocation of a few KB per response, next to
 * a network round trip and (on the cache path) a base64 decode that already
 * allocates — so paying it to keep the type honest is the right trade here.
 */
function bytes(b: Buffer): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(b);
}

function emptyTile(reason: string): Response {
    return new Response(null, { status: 204, headers: { 'X-Soil-Source': reason } });
}

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        {
            params: paramsPromise,
        }: { params: Promise<{ tenantSlug: string; z: string; x: string; y: string }> },
    ) => {
        const params = await paramsPromise;
        await getTenantCtx(params, req);

        const z = Number.parseInt(params.z, 10);
        const x = Number.parseInt(params.x, 10);
        // `{y}` may arrive with a `.png` suffix from a MapLibre tile template.
        const y = Number.parseInt(params.y.replace(/\.png$/i, ''), 10);

        if (
            !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) ||
            x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z
        ) {
            return new Response('Invalid tile coordinates', { status: 400 });
        }

        if (!isSoilZoomAllowed(z)) return emptyTile('out-of-zoom');

        // E2E: real PNG bytes, no network. Checked BEFORE the cache so a run
        // can never be served a real tile left in Redis by another run.
        if (env.E2E_SOIL_FIXTURE_TILES === '1') {
            const body = soilFixtureTile();
            return new Response(bytes(body), {
                status: 200,
                headers: {
                    'Content-Type': 'image/png',
                    'Cache-Control': 'no-store',
                    'X-Soil-Source': 'fixture',
                    'Content-Length': String(body.byteLength),
                },
            });
        }

        const cacheKey = soilTileCacheKey(z, x, y);
        const redis = getRedis();
        if (redis) {
            try {
                const cached = await redis.get(cacheKey);
                if (cached) {
                    return new Response(bytes(Buffer.from(cached, 'base64')), {
                        status: 200,
                        headers: {
                            'Content-Type': 'image/png',
                            'Cache-Control': IMMUTABLE_CACHE,
                            'X-Soil-Source': 'cache',
                        },
                    });
                }
            } catch {
                /* redis hiccup — fall through and fetch */
            }
        }

        let res: globalThis.Response;
        try {
            // Never forward the caller's cookies to a third party.
            res = await fetch(buildSoilWmsUrl(z, x, y), {
                headers: { Accept: 'image/png,*/*' },
                signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            });
        } catch {
            return emptyTile('upstream-unreachable');
        }

        if (!res.ok || res.status === 204) return emptyTile('upstream-error');

        const body = Buffer.from(await res.arrayBuffer());
        if (body.byteLength === 0) return emptyTile('upstream-empty');

        if (redis) {
            try {
                await redis.set(cacheKey, body.toString('base64'), 'EX', TILE_CACHE_TTL_SECONDS);
            } catch {
                /* redis hiccup — the tile is still returned, just uncached */
            }
        }

        return new Response(bytes(body), {
            status: 200,
            headers: {
                'Content-Type': res.headers.get('content-type') ?? 'image/png',
                'Cache-Control': IMMUTABLE_CACHE,
                'X-Soil-Source': 'upstream',
                'Content-Length': String(body.byteLength),
            },
        });
    },
);
