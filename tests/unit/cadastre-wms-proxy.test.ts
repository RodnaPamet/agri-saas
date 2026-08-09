/**
 * Unit tests — Bulgarian cadastre (КККР) WMS overlay.
 *
 *   1. Pure tile math (cadastre-tiles.ts): z/x/y → EPSG:3857 bbox, the
 *      Bulgaria envelope clamp, the zoom floor, the WMS URL builder, the
 *      cache-key shape.
 *   2. The same-origin proxy route: unconfigured → 204, zoom floor / envelope
 *      reject → 204, invalid coords → 400, cache miss (fetch + Redis write),
 *      cache hit (no fetch), upstream error → 204, no-Redis path.
 *
 * The tenant ctx, the env-reading source resolver, Redis, and `fetch` are all
 * mocked — no network, DB, or env.
 */
import {
    BULGARIA_ENVELOPE,
    CADASTRE_MIN_ZOOM,
    buildCadastreWmsUrl,
    buildCadastreArcgisExportUrl,
    isArcgisMapServer,
    cadastreTileCacheKey,
    isCadastreZoomAllowed,
    isTileInBulgaria,
    tileTo3857Bbox,
} from '@/lib/geo/cadastre-tiles';

const ORIGIN_SHIFT = 20_037_508.342_789_244;

/** Slippy tile x/y containing a lon/lat point at zoom z (standard formula). */
function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
    const n = 2 ** z;
    const x = Math.floor(((lon + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
    );
    return { x, y };
}

describe('cadastre tile math (pure)', () => {
    it('maps the root tile to the full Web-Mercator extent', () => {
        const [minX, minY, maxX, maxY] = tileTo3857Bbox(0, 0, 0);
        expect(minX).toBeCloseTo(-ORIGIN_SHIFT, 3);
        expect(minY).toBeCloseTo(-ORIGIN_SHIFT, 3);
        expect(maxX).toBeCloseTo(ORIGIN_SHIFT, 3);
        expect(maxY).toBeCloseTo(ORIGIN_SHIFT, 3);
    });

    it('produces a well-ordered, correctly-sized bbox at a deep zoom', () => {
        const z = 14;
        const { x, y } = lonLatToTile(23.32, 42.7, z); // Sofia
        const [minX, minY, maxX, maxY] = tileTo3857Bbox(z, x, y);
        expect(maxX).toBeGreaterThan(minX);
        expect(maxY).toBeGreaterThan(minY);
        // Each tile edge is (2·ORIGIN_SHIFT)/2^z metres.
        const expectedSize = (2 * ORIGIN_SHIFT) / 2 ** z;
        expect(maxX - minX).toBeCloseTo(expectedSize, 3);
        expect(maxY - minY).toBeCloseTo(expectedSize, 3);
    });

    it('accepts a tile over Bulgaria and rejects one far outside it', () => {
        const z = 12;
        const sofia = lonLatToTile(23.32, 42.7, z);
        expect(isTileInBulgaria(z, sofia.x, sofia.y)).toBe(true);
        // A tile in the Atlantic (well west of the envelope) is refused.
        const atlantic = lonLatToTile(-30, 40, z);
        expect(isTileInBulgaria(z, atlantic.x, atlantic.y)).toBe(false);
        // And one far east (central Asia).
        const asia = lonLatToTile(70, 42, z);
        expect(isTileInBulgaria(z, asia.x, asia.y)).toBe(false);
    });

    it('keeps the Bulgaria envelope inside the country bounds', () => {
        expect(BULGARIA_ENVELOPE.west).toBeLessThan(BULGARIA_ENVELOPE.east);
        expect(BULGARIA_ENVELOPE.south).toBeLessThan(BULGARIA_ENVELOPE.north);
    });

    it('enforces the zoom floor', () => {
        expect(isCadastreZoomAllowed(CADASTRE_MIN_ZOOM - 1)).toBe(false);
        expect(isCadastreZoomAllowed(9)).toBe(false);
        expect(isCadastreZoomAllowed(10)).toBe(true);
        expect(isCadastreZoomAllowed(16)).toBe(true);
        expect(isCadastreZoomAllowed(9.5)).toBe(false); // non-integer
    });

    it('builds a WMS 1.1.1 GetMap URL with the tile bbox', () => {
        const url = buildCadastreWmsUrl(
            'https://cadastre.example/geoserver/wms',
            'CP.CadastralParcel',
            [1, 2, 3, 4],
        );
        expect(url).toContain('SERVICE=WMS');
        expect(url).toContain('REQUEST=GetMap');
        expect(url).toContain('SRS=EPSG%3A3857');
        expect(url).toContain('LAYERS=CP.CadastralParcel');
        expect(url).toContain('BBOX=1%2C2%2C3%2C4');
        // Base with no query gets a `?` separator.
        expect(url.startsWith('https://cadastre.example/geoserver/wms?')).toBe(true);
    });

    it('appends with & when the base URL already carries a query', () => {
        const url = buildCadastreWmsUrl('https://x/wms?map=/cad.map', 'L', [0, 0, 1, 1]);
        expect(url).toContain('/wms?map=/cad.map&SERVICE=WMS');
    });

    it('shapes the cache key as (source, z, x, y)', () => {
        expect(cadastreTileCacheKey('premium', 14, 100, 200)).toBe('cadastre:tile:premium:14:100:200');
        expect(cadastreTileCacheKey('base', 10, 1, 2)).toBe('cadastre:tile:base:10:1:2');
    });

    it('detects an ArcGIS REST MapServer URL vs a WMS URL', () => {
        expect(isArcgisMapServer('https://arcgis.cadastre.bg/x/rest/services/ExternalKais/ParcelsCache/MapServer')).toBe(true);
        expect(isArcgisMapServer('https://arcgis.cadastre.bg/.../MapServer/')).toBe(true);
        expect(isArcgisMapServer('https://inspire.example/geoserver/wms')).toBe(false);
        // A GetMap query string on a MapServer path is still ArcGIS (path wins).
        expect(isArcgisMapServer('https://x/ParcelsCache/MapServer?f=json')).toBe(true);
    });

    it('builds an ArcGIS export URL (3857 bbox, reproject, raw PNG)', () => {
        const url = buildCadastreArcgisExportUrl(
            'https://arcgis.cadastre.bg/x/ParcelsCache/MapServer/',
            [1, 2, 3, 4],
        );
        expect(url).toContain('/MapServer/export?');
        expect(url).not.toContain('MapServer//export'); // trailing slash trimmed
        expect(url).toContain('bbox=1%2C2%2C3%2C4');
        expect(url).toContain('bboxSR=3857');
        expect(url).toContain('imageSR=3857');
        expect(url).toContain('size=256%2C256');
        expect(url).toContain('f=image');
        expect(url).toContain('transparent=true');
    });
});

// ── Proxy route ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (p: unknown, r: unknown) => getTenantCtxMock(p, r),
}));

const resolveCadastreSourceMock = jest.fn();
jest.mock('@/lib/geo/cadastre-source', () => ({
    resolveCadastreSource: () => resolveCadastreSourceMock(),
}));

const redisGet = jest.fn<Promise<string | null>, [string]>();
const redisSet = jest.fn<Promise<unknown>, unknown[]>();
let redisInstance: { get: typeof redisGet; set: typeof redisSet } | null = { get: redisGet, set: redisSet };
jest.mock('@/lib/redis', () => ({
    getRedis: () => redisInstance,
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/cadastre/wms/[z]/[x]/[y]/route';

const SOFIA = lonLatToTile(23.32, 42.7, 14); // a valid in-Bulgaria, above-floor tile

function call(z: number | string, x: number | string, y: number | string) {
    const req = new NextRequest(`http://localhost/api/t/acme/cadastre/wms/${z}/${x}/${y}`);
    return GET(req, {
        params: Promise.resolve({ tenantSlug: 'acme', z: String(z), x: String(x), y: String(y) }),
    });
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic

beforeEach(() => {
    jest.clearAllMocks();
    redisInstance = { get: redisGet, set: redisSet };
    getTenantCtxMock.mockResolvedValue({ tenantId: 'tenant-1', userId: 'u1', role: 'EDITOR' });
    resolveCadastreSourceMock.mockReturnValue({
        url: 'https://cadastre.example/wms',
        layers: 'CP.CadastralParcel',
        source: 'base',
    });
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    global.fetch = jest.fn().mockResolvedValue(
        new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
});

it('returns 204 (no fetch) when the cadastre is unconfigured', async () => {
    resolveCadastreSourceMock.mockReturnValue(null);
    const res = await call(14, SOFIA.x, SOFIA.y);
    expect(res.status).toBe(204);
    expect(global.fetch).not.toHaveBeenCalled();
});

it('rejects below the zoom floor with 204 (no fetch)', async () => {
    const res = await call(9, 1, 1);
    expect(res.status).toBe(204);
    expect(global.fetch).not.toHaveBeenCalled();
});

it('rejects a tile outside the Bulgaria envelope with 204 (no fetch)', async () => {
    const atlantic = lonLatToTile(-30, 40, 12);
    const res = await call(12, atlantic.x, atlantic.y);
    expect(res.status).toBe(204);
    expect(global.fetch).not.toHaveBeenCalled();
});

it('rejects structurally invalid coordinates with 400', async () => {
    const res = await call(10, 2 ** 10, 5); // x out of the 2^z grid
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
});

it('speaks ArcGIS export + sends a Referer when the upstream is a MapServer', async () => {
    resolveCadastreSourceMock.mockReturnValue({
        url: 'https://arcgis.cadastre.bg/arcgisnopki/rest/services/ExternalKais/ParcelsCache/MapServer',
        layers: 'ignored-in-arcgis',
        source: 'base',
        mode: 'arcgis',
    });
    const res = await call(14, SOFIA.x, SOFIA.y);
    expect(res.status).toBe(200);
    const [calledUrl, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(calledUrl).toContain('/MapServer/export?');
    expect(calledUrl).toContain('bboxSR=3857');
    expect(calledUrl).not.toContain('REQUEST=GetMap'); // NOT the WMS path
    expect((init.headers as Record<string, string>).Referer).toBe('https://arcgis.cadastre.bg/');
});

it('fetches upstream + caches on a cache miss', async () => {
    const res = await call(14, SOFIA.x, SOFIA.y);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=604800, immutable');
    // The upstream WMS URL is built from the configured base + the tile bbox.
    const fetchedUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(fetchedUrl).toContain('https://cadastre.example/wms?');
    expect(fetchedUrl).toContain('REQUEST=GetMap');
    expect(fetchedUrl).toContain('LAYERS=CP.CadastralParcel');
    // Cached under (source, z, x, y) as base64, 7-day TTL.
    expect(redisSet).toHaveBeenCalledWith(
        `cadastre:tile:base:14:${SOFIA.x}:${SOFIA.y}`,
        PNG_BYTES.toString('base64'),
        'EX',
        604_800,
    );
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(PNG_BYTES)).toBe(true);
});

it('serves from cache without fetching on a cache hit', async () => {
    redisGet.mockResolvedValue(PNG_BYTES.toString('base64'));
    const res = await call(14, SOFIA.x, SOFIA.y);
    expect(res.status).toBe(200);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(PNG_BYTES)).toBe(true);
});

it('degrades to 204 when the upstream throws (network error)', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await call(14, SOFIA.x, SOFIA.y);
    expect(res.status).toBe(204);
    expect(redisSet).not.toHaveBeenCalled();
});

it('degrades to 204 when the upstream returns 5xx', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(new Response(null, { status: 502 }));
    const res = await call(14, SOFIA.x, SOFIA.y);
    expect(res.status).toBe(204);
    expect(redisSet).not.toHaveBeenCalled();
});

it('still serves (uncached) when Redis is unavailable', async () => {
    redisInstance = null;
    const res = await call(14, SOFIA.x, SOFIA.y);
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
});

it('strips a .png suffix from the y coordinate', async () => {
    const res = await call(14, SOFIA.x, `${SOFIA.y}.png`);
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
});
