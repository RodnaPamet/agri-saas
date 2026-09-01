/**
 * Unit tests — the ISRIC soil WMS proxy (#782).
 *
 * NET-NEW: before #782 there was no route at all; `MapCanvas` pointed a raster
 * `<Source>` straight at `maps.isric.org`. Nothing under `tests/` could
 * observe that, and Playwright route interception structurally cannot see the
 * replacement either, because the `fetch` now runs in the Next process.
 *
 * The load-bearing assertion is `expect(fetchSpy).not.toHaveBeenCalled()` in
 * fixture mode. Everything else about that branch — a 200 with PNG bytes — is
 * equally true when the flag is off and ISRIC simply happens to be up, so
 * without it the suite would be green about a fix that had not applied. That
 * is the #764/#783 lesson applied to the second origin.
 */
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (p: unknown, r: unknown) => getTenantCtxMock(p, r),
}));
jest.mock('@/lib/redis', () => ({ getRedis: () => null }));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/soil/wms/[z]/[x]/[y]/route';
import { GET as LEGEND } from '@/app/api/t/[tenantSlug]/soil/legend/route';
import { buildSoilWmsUrl, SOIL_TILE_MAX_ZOOM } from '@/lib/geo/soil-tiles';
import { soilFixtureTile, soilFixtureLegend } from '@/lib/geo/soil-fixture-tile';

function call(z: number | string, x: number | string, y: number | string) {
    const req = new NextRequest(`http://localhost/api/t/acme/soil/wms/${z}/${x}/${y}`);
    return GET(req, {
        params: Promise.resolve({ tenantSlug: 'acme', z: String(z), x: String(x), y: String(y) }),
    });
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
let fetchSpy: jest.SpyInstance;

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue({ tenantId: 't1', userId: 'u1', role: 'EDITOR' });
    delete process.env.E2E_SOIL_FIXTURE_TILES;
    fetchSpy = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.E2E_SOIL_FIXTURE_TILES;
});

describe('tile-address validation (ahead of any fetch)', () => {
    it.each([
        ['non-numeric zoom', 'a', 0, 0],
        ['negative x', 1, -1, 0],
        ['x outside the 2^z grid', 1, 2, 0],
        ['y outside the 2^z grid', 1, 0, 2],
    ])('%s → 400 and never fetches', async (_label, z, x, y) => {
        const res = await call(z as number, x as number, y as number);
        expect(res.status).toBe(400);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses a zoom above the ceiling as an empty tile, not an error', async () => {
        const res = await call(SOIL_TILE_MAX_ZOOM + 1, 0, 0);
        expect(res.status).toBe(204);
        expect(res.headers.get('X-Soil-Source')).toBe('out-of-zoom');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('serves the whole world — there is deliberately NO geographic envelope', async () => {
        // The cadastre proxy refuses non-Bulgarian tiles because its upstream
        // is a paid IP-metered licence. ISRIC is free, global and CC-BY, and
        // the feature works anywhere, so an envelope here would be a silent
        // product regression. Tile (1,0,0) is the western hemisphere.
        fetchSpy.mockResolvedValue(new Response(PNG, { status: 200 }));
        const res = await call(1, 0, 0);
        expect(res.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalled();
    });
});

describe('E2E fixture mode', () => {
    it('serves real PNG bytes WITHOUT touching the third party', async () => {
        process.env.E2E_SOIL_FIXTURE_TILES = '1';
        const res = await call(10, 585, 385);
        expect(res.status).toBe(200);
        // The assertion the whole file exists for.
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(res.headers.get('X-Soil-Source')).toBe('fixture');
        expect(Buffer.from(await res.arrayBuffer())).toEqual(soilFixtureTile());
    });

    it('serves a fixture legend too — proxying only the tiles would leave the origin in the DOM', async () => {
        process.env.E2E_SOIL_FIXTURE_TILES = '1';
        const req = new NextRequest('http://localhost/api/t/acme/soil/legend');
        const res = await LEGEND(req, { params: Promise.resolve({ tenantSlug: 'acme' }) });
        expect(res.status).toBe(200);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(Buffer.from(await res.arrayBuffer())).toEqual(soilFixtureLegend());
    });

    it('fixture bytes are a real PNG with non-zero dimensions', async () => {
        // A 0-byte 200 or a 1x1 would satisfy every assertion above while the
        // legend `<img className="w-full">` — which has no intrinsic height —
        // rendered as an invisible sliver, making a Playwright toBeVisible()
        // pass on nothing.
        const png = soilFixtureLegend();
        expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        expect(png.readUInt32BE(16)).toBeGreaterThan(1); // IHDR width
        expect(png.readUInt32BE(20)).toBeGreaterThan(1); // IHDR height
    });
});

describe('upstream mode (the production path)', () => {
    it('requests the built WMS URL and bounds the fetch with a timeout', async () => {
        fetchSpy.mockResolvedValue(new Response(PNG, { status: 200 }));
        await call(10, 585, 385);
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(buildSoilWmsUrl(10, 585, 385));
        // A soil raster is decoration; it is never worth holding a worker for.
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('never forwards the caller’s cookies to the third party', async () => {
        fetchSpy.mockResolvedValue(new Response(PNG, { status: 200 }));
        await call(10, 585, 385);
        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(JSON.stringify(init.headers ?? {})).not.toMatch(/cookie/i);
    });

    it('returns the bytes with provenance and an immutable cache header', async () => {
        fetchSpy.mockResolvedValue(new Response(PNG, { status: 200 }));
        const res = await call(10, 585, 385);
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Soil-Source')).toBe('upstream');
        expect(res.headers.get('Cache-Control')).toBe('public, max-age=604800, immutable');
        expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    });

    it.each([
        ['a throw (DNS / connection refused)', 'unreachable' as const, 'upstream-unreachable'],
        ['a 5xx', 500, 'upstream-error'],
        ['a 200 with no body', 0, 'upstream-empty'],
    ])('degrades to an empty tile on %s, and SAYS which', async (_label, mode, expected) => {
        // Every failure is a 204 so the map skips the tile — but a blank
        // overlay must be diagnosable from a header rather than by
        // archaeology. That is the #781 lesson: an observation that cannot
        // distinguish two states is not evidence.
        if (mode === 'unreachable') fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
        else if (mode === 0) fetchSpy.mockResolvedValue(new Response(Buffer.alloc(0), { status: 200 }));
        else fetchSpy.mockResolvedValue(new Response(null, { status: mode as number }));

        const res = await call(10, 585, 385);
        expect(res.status).toBe(204);
        expect(res.headers.get('X-Soil-Source')).toBe(expected);
    });
});
