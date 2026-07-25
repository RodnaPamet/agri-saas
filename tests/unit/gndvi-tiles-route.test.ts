/**
 * Unit test — GET /api/t/[tenantSlug]/agro/gndvi-tiles.
 *
 * Mirrors the NDVI route test: proves the wiring around the Google
 * Earth Engine GNDVI (green-band chlorophyll) service via the shared
 * `handleIndexTiles` handler:
 *   - reports `configured:false` when GEE has no creds (no EE call);
 *   - returns `tileUrl:''` when the location has no mapped field;
 *   - on a cache MISS, generates a tile URL + writes the
 *     `{ tileUrl, acquiredDate }` pair to Redis under the `gndvi:` cache-key
 *     prefix (proves the route passes the right index);
 *   - on a cache HIT, returns the cached URL + cached acquisition date without
 *     calling GEE;
 *   - degrades softly (`error:'generation_failed'`) when GEE throws.
 *
 * GEE, the parcels source, and Redis are all mocked — no network/DB.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (p: unknown, r: unknown) => getTenantCtxMock(p, r),
}));

const isGeeConfiguredMock = jest.fn<boolean, []>();
const getGndviTileUrlMock = jest.fn<
    Promise<{ tileUrl: string; acquiredDate: string | null }>,
    [unknown, unknown]
>();
jest.mock('@/lib/agro/earth-engine', () => ({
    isGeeConfigured: () => isGeeConfiguredMock(),
    getGndviTileUrl: (aoi: unknown, win: unknown) => getGndviTileUrlMock(aoi, win),
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
import { GET } from '@/app/api/t/[tenantSlug]/agro/gndvi-tiles/route';

function call(qs: string) {
    const req = new NextRequest(`http://localhost/api/t/acme/agro/gndvi-tiles?${qs}`);
    return GET(req, { params: Promise.resolve({ tenantSlug: 'acme' }) });
}

beforeEach(() => {
    jest.clearAllMocks();
    redisInstance = { get: redisGet, set: redisSet };
    getTenantCtxMock.mockResolvedValue({ tenantId: 'tenant-1', userId: 'u1', role: 'EDITOR' });
    isGeeConfiguredMock.mockReturnValue(true);
    listLocationParcelsMock.mockResolvedValue({ bounds: [10, 40, 11, 41], parcels: [] });
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    getGndviTileUrlMock.mockResolvedValue({
        tileUrl: 'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}',
        acquiredDate: '2026-06-15',
    });
});

it('reports not-configured without calling GEE when creds are absent', async () => {
    isGeeConfiguredMock.mockReturnValue(false);
    const res = await call('locationId=loc-1');
    expect(await res.json()).toEqual({ configured: false, tileUrl: '' });
    expect(getGndviTileUrlMock).not.toHaveBeenCalled();
});

it('returns an empty tileUrl when the location has no mapped field', async () => {
    listLocationParcelsMock.mockResolvedValue({ bounds: null, parcels: [] });
    const res = await call('locationId=loc-1');
    expect(await res.json()).toEqual({ configured: true, tileUrl: '' });
    expect(getGndviTileUrlMock).not.toHaveBeenCalled();
});

it('generates + caches a tile URL on a cache miss', async () => {
    const res = await call('locationId=loc-1&date=2026-06-15');
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.tileUrl).toContain('earthengine.googleapis.com');
    expect(body.date).toBe('2026-06-15');
    expect(getGndviTileUrlMock).toHaveBeenCalledWith(
        { west: 10, south: 40, east: 11, north: 41 },
        { start: '2026-05-16', end: '2026-06-15' },
    );
    expect(redisSet).toHaveBeenCalledWith(
        'gndvi:tile:tenant-1:loc-1:clip3:2026-06-15',
        JSON.stringify({ tileUrl: body.tileUrl, acquiredDate: '2026-06-15' }),
        'EX',
        21_600,
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
    expect(body.date).toBe('2026-06-09');
    expect(getGndviTileUrlMock).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
});

it('degrades softly when GEE generation throws', async () => {
    getGndviTileUrlMock.mockRejectedValue(new Error('EE getMap failed'));
    const res = await call('locationId=loc-1&date=2026-06-15');
    expect(await res.json()).toEqual({
        configured: true,
        tileUrl: '',
        date: '2026-06-15',
        error: 'generation_failed',
    });
});
