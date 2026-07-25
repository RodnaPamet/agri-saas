/**
 * Unit test — GET /api/t/[tenantSlug]/agro/ndvi-tiles.
 *
 * Proves the route wiring around the Google Earth Engine NDVI service:
 *   - reports `configured:false` when GEE has no creds (no EE call);
 *   - returns `tileUrl:''` when the location has no mapped field;
 *   - on a cache MISS, generates a tile URL + writes the
 *     `{ tileUrl, acquiredDate }` pair to Redis under the `clip3` key;
 *   - on a cache HIT, returns the cached URL + cached acquisition date
 *     without calling GEE;
 *   - degrades softly (`error:'generation_failed'`) when GEE throws.
 *
 * This is the CANONICAL tile-route test — the other four index routes are thin
 * mirrors of the shared-handler wiring, so the acquisition-date contract is
 * covered once, here:
 *   - the response `date` is the date Earth Engine reported for the imagery,
 *     NOT the `?date=` the client asked for (the adaptive EE window legitimately
 *     falls back to older imagery, and labelling that with a fresh date lies);
 *   - `acquiredDate:null` (EE couldn't report one) falls back to the requested
 *     window end;
 *   - a legacy/unparseable cache entry (e.g. a `clip2`-era bare URL string)
 *     falls through and regenerates instead of throwing.
 *
 * GEE, the parcels source, and Redis are all mocked — no network/DB.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (p: unknown, r: unknown) => getTenantCtxMock(p, r),
}));

const isGeeConfiguredMock = jest.fn<boolean, []>();
// `get<Index>TileUrl` resolves an `IndexTileResult` — the tile template PLUS the
// real acquisition date of the composite it was rendered from.
const getNdviTileUrlMock = jest.fn<
    Promise<{ tileUrl: string; acquiredDate: string | null }>,
    [unknown, unknown, unknown?]
>();
jest.mock('@/lib/agro/earth-engine', () => ({
    isGeeConfigured: () => isGeeConfiguredMock(),
    getNdviTileUrl: (aoi: unknown, win: unknown, clip?: unknown) => getNdviTileUrlMock(aoi, win, clip),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const listLocationParcelsMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/usecases/location', () => ({
    listLocationParcels: (ctx: unknown, id: unknown) => listLocationParcelsMock(ctx, id),
}));

const redisGet = jest.fn<Promise<string | null>, [string]>();
const redisSet = jest.fn<Promise<unknown>, unknown[]>();
let redisInstance: { get: typeof redisGet; set: typeof redisSet } | null = {
    get: redisGet,
    set: redisSet,
};
jest.mock('@/lib/redis', () => ({
    getRedis: () => redisInstance,
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/agro/ndvi-tiles/route';

function call(qs: string) {
    const req = new NextRequest(`http://localhost/api/t/acme/agro/ndvi-tiles?${qs}`);
    return GET(req, { params: Promise.resolve({ tenantSlug: 'acme' }) });
}

const TILE_URL = 'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}';

beforeEach(() => {
    jest.clearAllMocks();
    redisInstance = { get: redisGet, set: redisSet };
    getTenantCtxMock.mockResolvedValue({ tenantId: 'tenant-1', userId: 'u1', role: 'EDITOR' });
    isGeeConfiguredMock.mockReturnValue(true);
    listLocationParcelsMock.mockResolvedValue({ bounds: [10, 40, 11, 41], parcels: [] });
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    // Default: EE reports imagery from exactly the requested window end, so the
    // response `date` and the `?date=` agree (the divergent cases get their own
    // tests below).
    getNdviTileUrlMock.mockResolvedValue({ tileUrl: TILE_URL, acquiredDate: '2026-06-15' });
});

it('reports not-configured without calling GEE when creds are absent', async () => {
    isGeeConfiguredMock.mockReturnValue(false);
    const res = await call('locationId=loc-1');
    expect(await res.json()).toEqual({ configured: false, tileUrl: '' });
    expect(getNdviTileUrlMock).not.toHaveBeenCalled();
});

it('returns an empty tileUrl when the location has no mapped field', async () => {
    listLocationParcelsMock.mockResolvedValue({ bounds: null, parcels: [] });
    const res = await call('locationId=loc-1');
    expect(await res.json()).toEqual({ configured: true, tileUrl: '' });
    expect(getNdviTileUrlMock).not.toHaveBeenCalled();
});

it('generates + caches a tile URL on a cache miss', async () => {
    const res = await call('locationId=loc-1&date=2026-06-15');
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.tileUrl).toContain('earthengine.googleapis.com');
    expect(body.date).toBe('2026-06-15');
    // AOI from bounds; 30-day window ending on the requested date. No parcel
    // geometry in this fixture (parcels: []), so the clip arg is undefined and
    // the EE side falls back to the bbox.
    expect(getNdviTileUrlMock).toHaveBeenCalledWith(
        { west: 10, south: 40, east: 11, north: 41 },
        { start: '2026-05-16', end: '2026-06-15' },
        undefined,
    );
    // The cached VALUE is the `{ tileUrl, acquiredDate }` pair (not a bare URL),
    // under the `clip3` key generation that shape change forced.
    expect(redisSet).toHaveBeenCalledWith(
        'ndvi:tile:tenant-1:loc-1:clip3:2026-06-15',
        JSON.stringify({ tileUrl: body.tileUrl, acquiredDate: '2026-06-15' }),
        'EX',
        21_600,
    );
});

it("clips the raster to the parcels' polygons (union), not the bbox", async () => {
    const poly = { type: 'Polygon', coordinates: [[[10, 40], [11, 40], [11, 41], [10, 41], [10, 40]]] };
    const multi = { type: 'MultiPolygon', coordinates: [[[[11.2, 40.2], [11.3, 40.2], [11.3, 40.3], [11.2, 40.2]]]] };
    listLocationParcelsMock.mockResolvedValue({
        bounds: [10, 40, 11.3, 41],
        parcels: [{ geometry: poly }, { geometry: multi }, { geometry: null }],
    });
    await call('locationId=loc-1&date=2026-06-15');
    // The 3rd arg is the union of the parcels' polygons as one MultiPolygon —
    // so the EE composite is clipped to the fields, not the location bbox.
    expect(getNdviTileUrlMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { type: 'MultiPolygon', coordinates: [poly.coordinates, ...multi.coordinates] },
    );
});

it('returns the cached URL + cached acquisition date without calling GEE on a cache hit', async () => {
    redisGet.mockResolvedValue(
        JSON.stringify({
            tileUrl: 'https://earthengine.googleapis.com/cached/{z}/{x}/{y}',
            acquiredDate: '2026-06-09',
        }),
    );
    const res = await call('locationId=loc-1&date=2026-06-15');
    const body = await res.json();
    expect(body.tileUrl).toBe('https://earthengine.googleapis.com/cached/{z}/{x}/{y}');
    // The date rides along in the cache entry — a hit must not relabel stale
    // imagery with the requested date.
    expect(body.date).toBe('2026-06-09');
    expect(getNdviTileUrlMock).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
});

it('reports the EE acquisition date, not the requested date, when the two differ', async () => {
    // The adaptive EE window falls back to the latest available imagery when the
    // requested window is empty (wall clock ahead of the S2 archive, or a cloudy
    // stretch) — so the composite is genuinely older than what was asked for.
    getNdviTileUrlMock.mockResolvedValue({ tileUrl: TILE_URL, acquiredDate: '2026-06-02' });
    const res = await call('locationId=loc-1&date=2026-06-15');
    const body = await res.json();
    expect(body.date).toBe('2026-06-02');
    expect(body.tileUrl).toBe(TILE_URL);
    // ...and the honest date is what gets cached, keyed by the REQUESTED end.
    expect(redisSet).toHaveBeenCalledWith(
        'ndvi:tile:tenant-1:loc-1:clip3:2026-06-15',
        JSON.stringify({ tileUrl: TILE_URL, acquiredDate: '2026-06-02' }),
        'EX',
        21_600,
    );
});

it('falls back to the requested window end when EE reports no acquisition date', async () => {
    getNdviTileUrlMock.mockResolvedValue({ tileUrl: TILE_URL, acquiredDate: null });
    const res = await call('locationId=loc-1&date=2026-06-15');
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.tileUrl).toBe(TILE_URL);
    expect(body.date).toBe('2026-06-15');
    // `null` is cached verbatim — a later hit re-applies the same fallback.
    expect(redisSet).toHaveBeenCalledWith(
        'ndvi:tile:tenant-1:loc-1:clip3:2026-06-15',
        JSON.stringify({ tileUrl: TILE_URL, acquiredDate: null }),
        'EX',
        21_600,
    );
});

it('regenerates instead of throwing when a legacy/unreadable cache entry is read', async () => {
    // A `clip2`-era entry was a BARE URL string — `JSON.parse` throws on it. The
    // key generation bumped to `clip3` precisely so this cannot happen, but the
    // handler must still fall through and regenerate rather than 500.
    redisGet.mockResolvedValue('https://earthengine.googleapis.com/legacy/{z}/{x}/{y}');
    const res = await call('locationId=loc-1&date=2026-06-15');
    const body = await res.json();
    expect(body.tileUrl).toBe(TILE_URL);
    expect(body.date).toBe('2026-06-15');
    expect(getNdviTileUrlMock).toHaveBeenCalledTimes(1);
    expect(redisSet).toHaveBeenCalledWith(
        'ndvi:tile:tenant-1:loc-1:clip3:2026-06-15',
        JSON.stringify({ tileUrl: TILE_URL, acquiredDate: '2026-06-15' }),
        'EX',
        21_600,
    );
});

it('regenerates when a cached entry parses but carries no tileUrl', async () => {
    // Parses cleanly, wrong shape — must not be served as a tile URL.
    redisGet.mockResolvedValue(JSON.stringify({ acquiredDate: '2026-06-09' }));
    const res = await call('locationId=loc-1&date=2026-06-15');
    const body = await res.json();
    expect(body.tileUrl).toBe(TILE_URL);
    expect(getNdviTileUrlMock).toHaveBeenCalledTimes(1);
});

it('degrades softly when GEE generation throws', async () => {
    getNdviTileUrlMock.mockRejectedValue(new Error('EE getMap failed'));
    const res = await call('locationId=loc-1&date=2026-06-15');
    expect(await res.json()).toEqual({
        configured: true,
        tileUrl: '',
        date: '2026-06-15',
        error: 'generation_failed',
    });
});

it('still works (uncached) when Redis is unavailable', async () => {
    redisInstance = null;
    const res = await call('locationId=loc-1&date=2026-06-15');
    const body = await res.json();
    expect(body.tileUrl).toContain('earthengine.googleapis.com');
    expect(getNdviTileUrlMock).toHaveBeenCalledTimes(1);
});
