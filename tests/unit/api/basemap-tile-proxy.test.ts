/**
 * Unit tests — the per-location basemap tile proxy
 * (`/api/t/[tenantSlug]/locations/[id]/basemap/[z]/[x]/[y]`).
 *
 * NET-NEW: nothing under `tests/` touched this handler before. It is the
 * SERVER half of #764 — the half Playwright route interception structurally
 * cannot see, because the `fetch` runs in the Next process rather than the
 * browser.
 *
 * The load-bearing assertion is `expect(fetchSpy).not.toHaveBeenCalled()` in
 * fixture mode. Everything else about that branch (a 200 with a body) is
 * ALSO true when the flag is off and the CDN simply happens to be up, so
 * without it the test would be green about a fix that had not applied.
 *
 * The 502/204 cases are the ones that make the outage behaviour concrete:
 * the soft-204 fires only when `fetch` THROWS, so a 5xx from the upstream
 * surfaces as a 502 from our own API.
 */
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (p: unknown, r: unknown) => getTenantCtxMock(p, r),
}));

const getLocationBoundsMock = jest.fn<Promise<[number, number, number, number] | null>, unknown[]>();
jest.mock('@/app-layer/usecases/location', () => ({
    getLocationBounds: (...a: unknown[]) => getLocationBoundsMock(...a),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/locations/[id]/basemap/[z]/[x]/[y]/route';
import { basemapFixtureTile } from '@/lib/offline/basemap-fixture-tile';
import { BASEMAP_UPSTREAM_TILE_TEMPLATE } from '@/lib/offline/basemap-pack';

function call(z: number | string, x: number | string, y: number | string) {
    const req = new NextRequest(
        `http://localhost/api/t/acme/locations/loc-1/basemap/${z}/${x}/${y}`,
    );
    return GET(req, {
        params: Promise.resolve({
            tenantSlug: 'acme',
            id: 'loc-1',
            z: String(z),
            x: String(x),
            y: String(y),
        }),
    });
}

const TILE_BYTES = Buffer.from([0x1a, 0x00]);
let fetchSpy: jest.SpyInstance;

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue({ tenantId: 't1', userId: 'u1', role: 'EDITOR' });
    // No bbox ⇒ the bbox gate is skipped, so each test opts into it explicitly.
    getLocationBoundsMock.mockResolvedValue(null);
    delete process.env.E2E_BASEMAP_FIXTURE_TILES;
    fetchSpy = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.E2E_BASEMAP_FIXTURE_TILES;
});

describe('tile-address validation (ahead of any fetch)', () => {
    it.each([
        ['non-numeric zoom', 'a', 0, 0],
        ['zoom above the demotiles native max', 7, 0, 0],
        ['negative x', 1, -1, 0],
        ['x outside the 2^z grid', 1, 2, 0],
    ])('%s → 400 and never fetches', async (_label, z, x, y) => {
        const res = await call(z as number, x as number, y as number);
        expect(res.status).toBe(400);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a tile outside the location bbox with 404', async () => {
        // A tiny bbox in Bulgaria; tile (1,0,0) is the western hemisphere.
        getLocationBoundsMock.mockResolvedValue([23.3, 42.6, 23.4, 42.8]);
        const res = await call(1, 0, 0);
        expect(res.status).toBe(404);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('upstream mode (the production path)', () => {
    it('substitutes the tile address into the upstream template and bounds the fetch', async () => {
        fetchSpy.mockResolvedValue(new Response(TILE_BYTES, { status: 200 }));
        await call(3, 4, 5);
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(
            BASEMAP_UPSTREAM_TILE_TEMPLATE.replace('{z}', '3').replace('{x}', '4').replace('{y}', '5'),
        );
        // The route had no timeout while DownloadBasemapButton walks up to 256
        // tiles sequentially — a hanging upstream was a production stall.
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('returns the bytes with the immutable cache header and upstream provenance', async () => {
        fetchSpy.mockResolvedValue(new Response(TILE_BYTES, { status: 200 }));
        const res = await call(0, 0, 0);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/x-protobuf');
        expect(res.headers.get('Cache-Control')).toBe('public, max-age=604800, immutable');
        expect(res.headers.get('Content-Length')).toBe(String(TILE_BYTES.byteLength));
        expect(res.headers.get('X-Basemap-Source')).toBe('upstream');
        expect(Buffer.from(await res.arrayBuffer())).toEqual(TILE_BYTES);
    });

    it('soft-fails to 204 when the upstream throws', async () => {
        fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
        expect((await call(0, 0, 0)).status).toBe(204);
    });

    it.each([204, 404])('maps upstream %i to 204 (ocean / no coverage)', async (status) => {
        fetchSpy.mockResolvedValue(new Response(null, { status }));
        expect((await call(0, 0, 0)).status).toBe(204);
    });

    it('turns a failing upstream into a 502 from our own API', async () => {
        // The soft-204 above fires ONLY on a throw. A 5xx/429/403 from the CDN
        // becomes a 502 here — which is why an outage is not as harmless as
        // the 204 escape hatch suggests.
        fetchSpy.mockResolvedValue(new Response(null, { status: 503 }));
        expect((await call(0, 0, 0)).status).toBe(502);
    });
});

describe('E2E fixture mode', () => {
    beforeEach(() => {
        process.env.E2E_BASEMAP_FIXTURE_TILES = '1';
    });

    it('serves the fixture tile and never reaches the network', async () => {
        const res = await call(0, 0, 0);
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Basemap-Source')).toBe('fixture');
        expect(Buffer.from(await res.arrayBuffer())).toEqual(basemapFixtureTile());
        // The whole point of the flag, asserted rather than assumed.
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('keeps the same headers as the upstream path', async () => {
        const res = await call(0, 0, 0);
        expect(res.headers.get('Content-Type')).toBe('application/x-protobuf');
        expect(res.headers.get('Cache-Control')).toBe('public, max-age=604800, immutable');
        expect(res.headers.get('Content-Length')).toBe(String(basemapFixtureTile().byteLength));
    });

    it('still honours the address and bbox gates', async () => {
        // The fixture branch sits AFTER every validation, so fixture mode is
        // exactly as bounded as the real one — it is not a bypass.
        expect((await call(9, 0, 0)).status).toBe(400);
        getLocationBoundsMock.mockResolvedValue([23.3, 42.6, 23.4, 42.8]);
        expect((await call(1, 0, 0)).status).toBe(404);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('is off unless the flag is exactly "1"', async () => {
        process.env.E2E_BASEMAP_FIXTURE_TILES = '0';
        fetchSpy.mockResolvedValue(new Response(TILE_BYTES, { status: 200 }));
        const res = await call(0, 0, 0);
        expect(res.headers.get('X-Basemap-Source')).toBe('upstream');
        expect(fetchSpy).toHaveBeenCalled();
    });
});
