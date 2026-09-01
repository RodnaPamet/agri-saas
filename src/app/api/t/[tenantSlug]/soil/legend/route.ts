/**
 * GET /api/t/[tenantSlug]/soil/legend
 *
 * Same-origin proxy for the ISRIC WRB `GetLegendGraphic` image (#782).
 *
 * The legend is a sibling of the tile proxy and not an afterthought: it was an
 * `<img src="https://maps.isric.org/...">` in the rendered DOM, so proxying
 * only the tiles would have left the third-party origin on the page and the
 * `map-basemap-hermetic` allowlist entry still earning its keep. Both halves
 * move, or neither does.
 *
 * One image for the whole layer, so it is cached for a day and never bounced
 * per tenant.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { env } from '@/env';
import { buildSoilLegendUrl } from '@/lib/geo/soil-tiles';
import { soilFixtureLegend } from '@/lib/geo/soil-fixture-tile';

const LEGEND_CACHE = 'public, max-age=86400';
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

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        await getTenantCtx(params, req);

        if (env.E2E_SOIL_FIXTURE_TILES === '1') {
            const body = soilFixtureLegend();
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

        let res: globalThis.Response;
        try {
            res = await fetch(buildSoilLegendUrl(), {
                headers: { Accept: 'image/png,*/*' },
                signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            });
        } catch {
            return new Response(null, { status: 204, headers: { 'X-Soil-Source': 'upstream-unreachable' } });
        }

        if (!res.ok) {
            return new Response(null, { status: 204, headers: { 'X-Soil-Source': 'upstream-error' } });
        }

        const body = Buffer.from(await res.arrayBuffer());
        if (body.byteLength === 0) {
            return new Response(null, { status: 204, headers: { 'X-Soil-Source': 'upstream-empty' } });
        }

        return new Response(bytes(body), {
            status: 200,
            headers: {
                'Content-Type': res.headers.get('content-type') ?? 'image/png',
                'Cache-Control': LEGEND_CACHE,
                'X-Soil-Source': 'upstream',
                'Content-Length': String(body.byteLength),
            },
        });
    },
);
