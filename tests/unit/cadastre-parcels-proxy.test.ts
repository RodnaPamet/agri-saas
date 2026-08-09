/**
 * Unit tests — Bulgarian cadastre (КККР) VECTOR parcels overlay.
 *
 *   1. Pure helpers (cadastre-parcels.ts): bbox parse/validate, the Bulgaria
 *      envelope clamp, the bbox-span cap, the cache-key shape, the ArcGIS
 *      /query URL builder, and the property-trimming of the FeatureCollection.
 *   2. The same-origin proxy route: unconfigured → empty 200, malformed bbox
 *      → 400, out-of-envelope → empty 200, oversized bbox → empty 200, cache
 *      miss (fetch + Redis write + trim), cache hit (no fetch), upstream error
 *      → empty 200, upstream throw/timeout → empty 200, no-Redis path.
 *
 * The tenant ctx, the env-reading source resolver, Redis, and `fetch` are all
 * mocked — no network, DB, or env. NO upstream URL is committed here (a mock
 * base is used).
 */
import {
    CADASTRE_PARCELS_ENVELOPE,
    MAX_PARCELS_BBOX_SPAN_DEG,
    buildCadastreParcelsQueryUrl,
    cadastreParcelsCacheKey,
    isBboxInBulgaria,
    isBboxWithinSpanCap,
    parseBbox,
    trimParcelFeatureCollection,
    type Bbox,
} from '@/lib/geo/cadastre-parcels';

describe('cadastre parcels helpers (pure)', () => {
    it('parses a well-formed bbox and rejects malformed / degenerate ones', () => {
        expect(parseBbox('23.0,42.0,23.1,42.1')).toEqual([23.0, 42.0, 23.1, 42.1]);
        expect(parseBbox(' 23 , 42 , 23.1 , 42.1 ')).toEqual([23, 42, 23.1, 42.1]);
        expect(parseBbox(null)).toBeNull();
        expect(parseBbox('')).toBeNull();
        expect(parseBbox('1,2,3')).toBeNull(); // too few
        expect(parseBbox('1,2,3,4,5')).toBeNull(); // too many
        expect(parseBbox('a,2,3,4')).toBeNull(); // non-numeric
        expect(parseBbox('23.1,42,23.0,42.1')).toBeNull(); // west >= east
        expect(parseBbox('23,42.1,23.1,42.0')).toBeNull(); // south >= north
    });

    it('accepts a bbox over Bulgaria and rejects one far outside it', () => {
        expect(isBboxInBulgaria([23.3, 42.6, 23.4, 42.7])).toBe(true); // Sofia
        expect(isBboxInBulgaria([-30, 40, -29.9, 40.1])).toBe(false); // Atlantic
        expect(isBboxInBulgaria([70, 42, 70.1, 42.1])).toBe(false); // central Asia
    });

    it('keeps the parcels envelope inside sane country bounds', () => {
        expect(CADASTRE_PARCELS_ENVELOPE.west).toBeLessThan(CADASTRE_PARCELS_ENVELOPE.east);
        expect(CADASTRE_PARCELS_ENVELOPE.south).toBeLessThan(CADASTRE_PARCELS_ENVELOPE.north);
    });

    it('enforces the per-axis bbox-span cap', () => {
        const small: Bbox = [23.0, 42.0, 23.01, 42.01];
        expect(isBboxWithinSpanCap(small)).toBe(true);
        const wideLon: Bbox = [23.0, 42.0, 23.0 + MAX_PARCELS_BBOX_SPAN_DEG + 0.01, 42.01];
        expect(isBboxWithinSpanCap(wideLon)).toBe(false);
        const wideLat: Bbox = [23.0, 42.0, 23.01, 42.0 + MAX_PARCELS_BBOX_SPAN_DEG + 0.01];
        expect(isBboxWithinSpanCap(wideLat)).toBe(false);
    });

    it('rounds the bbox into a stable cache key', () => {
        expect(cadastreParcelsCacheKey([23.12345, 42.98765, 23.13, 42.99])).toBe(
            'cadastre:parcels:23.123,42.988,23.130,42.990',
        );
    });

    it('builds the ArcGIS /query URL with the verified param shape', () => {
        const url = buildCadastreParcelsQueryUrl('https://example.test/MapServer/2', [23.0, 42.0, 23.1, 42.1]);
        expect(url).toContain('https://example.test/MapServer/2/query?');
        expect(url).toContain('where=1%3D1');
        expect(url).toContain('geometry=23%2C42%2C23.1%2C42.1');
        expect(url).toContain('geometryType=esriGeometryEnvelope');
        expect(url).toContain('inSR=4326');
        expect(url).toContain('outSR=4326');
        expect(url).toContain('spatialRel=esriSpatialRelIntersects');
        expect(url).toContain('returnGeometry=true');
        expect(url).toContain('outFields=upi%2Cekatte%2Cnusetype');
        expect(url).toContain('resultRecordCount=3000');
        expect(url).toContain('f=geojson');
        // A trailing slash on the base is trimmed (no //query).
        expect(buildCadastreParcelsQueryUrl('https://x/MapServer/2/', [0, 0, 1, 1])).toContain(
            '/MapServer/2/query?',
        );
    });

    it('trims features to { upi, ekatte, nusetype } and drops other props', () => {
        const upstream = {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
                    properties: { upi: '43298.502.517', ekatte: '43298', nusetype: '3', secret: 'x', OBJECTID: 9 },
                },
                // A feature with no geometry is dropped.
                { type: 'Feature', geometry: null, properties: { upi: 'z' } },
            ],
        };
        const trimmed = trimParcelFeatureCollection(upstream);
        expect(trimmed.features).toHaveLength(1);
        expect(trimmed.features[0].properties).toEqual({
            upi: '43298.502.517',
            ekatte: '43298',
            nusetype: '3',
        });
        // Non-FeatureCollection input degrades to an empty collection.
        expect(trimParcelFeatureCollection({ error: 'boom' }).features).toEqual([]);
        expect(trimParcelFeatureCollection(null).features).toEqual([]);
    });
});

// ── Proxy route ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (p: unknown, r: unknown) => getTenantCtxMock(p, r),
}));

const resolveCadastreParcelsUrlMock = jest.fn<string | null, []>();
jest.mock('@/lib/geo/cadastre-source', () => ({
    resolveCadastreParcelsUrl: () => resolveCadastreParcelsUrlMock(),
}));

const redisGet = jest.fn<Promise<string | null>, [string]>();
const redisSet = jest.fn<Promise<unknown>, unknown[]>();
let redisInstance: { get: typeof redisGet; set: typeof redisSet } | null = { get: redisGet, set: redisSet };
jest.mock('@/lib/redis', () => ({
    getRedis: () => redisInstance,
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/cadastre/parcels/route';

const MOCK_BASE = 'https://example.test/MapServer/2';
// A small, in-Bulgaria, within-cap bbox.
const OK_BBOX = '23.30,42.60,23.31,42.61';

function call(bbox: string | null) {
    const qs = bbox === null ? '' : `?bbox=${encodeURIComponent(bbox)}`;
    const req = new NextRequest(`http://localhost/api/t/acme/cadastre/parcels${qs}`);
    return GET(req, { params: Promise.resolve({ tenantSlug: 'acme' }) });
}

const UPSTREAM_FC = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [[[23.3, 42.6], [23.3, 42.61], [23.31, 42.61], [23.3, 42.6]]] },
            properties: { upi: '68134.8360.729', ekatte: '68134', nusetype: '3', junk: 'drop-me' },
        },
    ],
};

function jsonResponseOk(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
    jest.clearAllMocks();
    redisInstance = { get: redisGet, set: redisSet };
    getTenantCtxMock.mockResolvedValue({ tenantId: 'tenant-1', userId: 'u1', role: 'EDITOR' });
    resolveCadastreParcelsUrlMock.mockReturnValue(MOCK_BASE);
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    global.fetch = jest.fn().mockResolvedValue(jsonResponseOk(UPSTREAM_FC));
});

it('returns an empty FeatureCollection (200, no fetch) when unconfigured', async () => {
    resolveCadastreParcelsUrlMock.mockReturnValue(null);
    const res = await call(OK_BBOX);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 'FeatureCollection', features: [] });
    expect(global.fetch).not.toHaveBeenCalled();
});

it('rejects a missing/malformed bbox with 400 (no fetch)', async () => {
    const res = await call(null);
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();

    const bad = await call('not,a,bbox,x');
    expect(bad.status).toBe(400);
});

it('returns empty (200, no fetch) for a bbox outside Bulgaria', async () => {
    const res = await call('-30.0,40.0,-29.99,40.01');
    expect(res.status).toBe(200);
    expect((await res.json()).features).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
});

it('returns empty (200, no fetch) for an oversized bbox', async () => {
    // Span well above the per-axis cap.
    const res = await call('22.0,41.0,25.0,43.0');
    expect(res.status).toBe(200);
    expect((await res.json()).features).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
});

it('fetches upstream, trims properties, and caches on a cache miss', async () => {
    const res = await call(OK_BBOX);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');

    const body = await res.json();
    expect(body.features).toHaveLength(1);
    // Only the three allowed props survive.
    expect(body.features[0].properties).toEqual({ upi: '68134.8360.729', ekatte: '68134', nusetype: '3' });

    // The upstream /query URL is built from the configured base + bbox.
    const fetchedUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(fetchedUrl).toContain('https://example.test/MapServer/2/query?');
    expect(fetchedUrl).toContain('geometryType=esriGeometryEnvelope');

    // Cached as JSON string with a 1-day TTL under the rounded-bbox key.
    expect(redisSet).toHaveBeenCalledWith(
        cadastreParcelsCacheKey([23.3, 42.6, 23.31, 42.61]),
        expect.any(String),
        'EX',
        86_400,
    );
});

it('serves from cache without fetching on a cache hit', async () => {
    redisGet.mockResolvedValue(JSON.stringify({ type: 'FeatureCollection', features: [{ cached: true }] }));
    const res = await call(OK_BBOX);
    expect(res.status).toBe(200);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
    expect((await res.json()).features).toEqual([{ cached: true }]);
});

it('degrades to an empty collection when the upstream throws (network/timeout)', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('aborted'));
    const res = await call(OK_BBOX);
    expect(res.status).toBe(200);
    expect((await res.json()).features).toEqual([]);
    expect(redisSet).not.toHaveBeenCalled();
});

it('degrades to an empty collection when the upstream returns 5xx', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(new Response(null, { status: 502 }));
    const res = await call(OK_BBOX);
    expect(res.status).toBe(200);
    expect((await res.json()).features).toEqual([]);
    expect(redisSet).not.toHaveBeenCalled();
});

it('still serves (uncached) when Redis is unavailable', async () => {
    redisInstance = null;
    const res = await call(OK_BBOX);
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((await res.json()).features).toHaveLength(1);
});
