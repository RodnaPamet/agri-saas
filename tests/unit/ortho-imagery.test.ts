/**
 * «Ортофотокарта» orchestration — #2421.
 *
 * The decision these cases exist for is **`absent` versus `unavailable`**.
 *
 * The phone caches a 204 as "no photo here, final" for the whole session and
 * retries a 5xx on the next redraw (agrent-ios #459). The sibling cadastre
 * proxy answers 204 for every failure including upstream 5xx — right for
 * MapLibre, and wrong here: one transient upstream failure would leave a farm
 * looking at bare ground until the app restarts. So "we could not find out"
 * must never be reported as "there is nothing here", and several cases below
 * assert exactly that distinction rather than a happy path.
 *
 * Redis is a fake map rather than absent, because the negative cache and the
 * tile ceiling are behaviour worth asserting and an absent Redis would skip
 * both silently — the shape that made a two-callers cache test vacuous in
 * #2395.
 */
const assertFlagMock = jest.fn();
const sourceMock = jest.fn();

jest.mock('@/lib/feature-flags', () => ({
    __esModule: true,
    assertFeatureEnabled: (...a: unknown[]) => assertFlagMock(...a),
}));

/** Partial: only the env read is doubled; every builder runs for real. */
jest.mock('@/lib/geo/ortho-source', () => {
    const actual = jest.requireActual(
        '@/lib/geo/ortho-source',
    ) as typeof import('@/lib/geo/ortho-source');
    return { ...actual, resolveOrthoSource: () => sourceMock() };
});

/** A Redis double with just the commands this module uses. */
const store = new Map<string, string>();
const redisDouble = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
    }),
    incr: jest.fn(async (k: string) => {
        const n = Number(store.get(k) ?? '0') + 1;
        store.set(k, String(n));
        return n;
    }),
    decr: jest.fn(async (k: string) => {
        const n = Number(store.get(k) ?? '0') - 1;
        store.set(k, String(n));
        return n;
    }),
};
let redisPresent = true;
jest.mock('@/lib/redis', () => ({
    __esModule: true,
    getRedis: () => (redisPresent ? redisDouble : null),
}));

import {
    __resetOrthoLimiterForTests,
    fetchOrthoBlocks,
    fetchOrthoTile,
    resolveOrthoCoverage,
} from '@/app-layer/usecases/ortho-imagery';
import type { RequestContext } from '@/app-layer/types';

const ctx = { tenantId: 't1', userId: 'u1' } as unknown as RequestContext;
/** A tile inside Bulgaria at a zoom the source serves. */
const TILE = { z: 15, x: 18_800, y: 11_900 };
const BBOX = { west: 24.39, south: 43.07, east: 24.41, north: 43.09 };

/** A GeoJSON answer with `n` coverage polygons. */
function coverageBody(n: number, date = '2023-10-13T21:00:00Z') {
    return {
        features: Array.from({ length: n }, () => ({ properties: { Date: date, Area: 1 } })),
    };
}

function jsonRes(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        headers: { get: () => null },
    } as unknown as Response;
}

function bytesRes(length: number, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        arrayBuffer: async () => new ArrayBuffer(length),
        headers: { get: (h: string) => (h === 'content-type' ? 'image/jpeg' : null) },
    } as unknown as Response;
}

/** Route each upstream URL to an answer, and record what was asked. */
function router(handlers: {
    dates?: (year: number) => Response | Promise<Response> | Error;
    tile?: (year: number) => Response | Promise<Response> | Error;
    blocks?: (year: number) => Response | Promise<Response> | Error;
}) {
    const seen: string[] = [];
    const impl = (async (url: string) => {
        const u = String(url);
        seen.push(u);
        const year = Number(/_(\d{4})/.exec(u)?.[1] ?? 0);
        const pick = u.includes('Dates_')
            ? handlers.dates
            : u.includes('Agricultural_Land_')
              ? handlers.blocks
              : handlers.tile;
        if (!pick) throw new Error(`no handler for ${u}`);
        const out = await pick(year);
        if (out instanceof Error) throw out;
        return out;
    }) as unknown as typeof fetch;
    return { impl, seen };
}

beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    redisPresent = true;
    __resetOrthoLimiterForTests();
    assertFlagMock.mockResolvedValue(undefined);
    sourceMock.mockReturnValue({ url: 'http://upstream.test/ows' });
});

describe('the gate (#2421)', () => {
    it('refuses when the flag is off for this caller, before any upstream call', async () => {
        // `assertFeatureEnabled` answers 404 rather than 403, deliberately, so
        // a dark surface is not discoverable.
        assertFlagMock.mockRejectedValue(new Error('Not found'));
        const { impl, seen } = router({});
        await expect(fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: impl })).rejects.toThrow(
            'Not found',
        );
        expect(seen).toHaveLength(0);
        expect(assertFlagMock).toHaveBeenCalledWith('agro.orthophoto', 'u1');
    });

    it('refuses when ORTHO_WMS_URL is unset — the shipped state', async () => {
        // Unset is how the licence position is enforced: until МЗХ answers,
        // production sets nothing and no imagery is fetched, stored or served.
        sourceMock.mockReturnValue(null);
        const { impl, seen } = router({});
        await expect(
            fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: impl }),
        ).rejects.toThrow();
        expect(seen).toHaveLength(0);
    });

    it('gates all three reads, not just the tile', async () => {
        // The server enforces the flag because the licence position cannot
        // rest on the client hiding a map mode — a stale or modified client
        // would otherwise still be served imagery.
        assertFlagMock.mockRejectedValue(new Error('Not found'));
        const { impl } = router({});
        await expect(resolveOrthoCoverage(ctx, BBOX, { fetchImpl: impl })).rejects.toThrow();
        await expect(fetchOrthoBlocks(ctx, BBOX, { fetchImpl: impl })).rejects.toThrow();
    });
});

describe('the year is the newest one that COVERS the area (#2421)', () => {
    it('skips newer years with no coverage polygon', async () => {
        // Measured at the probe point: Dates_2023 has coverage, 2025 and 2024
        // have none, and the imagery agrees. Taking the highest year number
        // would serve the blank tile and — under the 204 rule — tell the phone
        // there is no photograph of land that is photographed.
        const { impl, seen } = router({
            dates: (year) => jsonRes(coverageBody(year === 2023 ? 2 : 0)),
        });
        const c = await resolveOrthoCoverage(ctx, BBOX, { fetchImpl: impl });
        expect(c.year).toBe(2023);
        expect(c.flightDate).toBe('2023-10-14');
        // Asked 2025, 2024, 2023 and then STOPPED.
        expect(seen).toHaveLength(3);
        expect(seen[2]).toContain('Dates_2023');
        expect(seen.some((u) => u.includes('Dates_2022'))).toBe(false);
    });

    it('reports no year when nothing covers the area', async () => {
        const { impl, seen } = router({ dates: () => jsonRes(coverageBody(0)) });
        const c = await resolveOrthoCoverage(ctx, BBOX, { fetchImpl: impl });
        expect(c).toEqual({ year: null, flightDate: null, attribution: 'Ортофото: МЗХ' });
        expect(seen).toHaveLength(6);
    });

    it('never asks the Ministry about an area outside Bulgaria', async () => {
        const { impl, seen } = router({});
        const c = await resolveOrthoCoverage(
            ctx,
            { west: 25.0, south: 37.0, east: 25.1, north: 37.1 },
            { fetchImpl: impl },
        );
        expect(c.year).toBeNull();
        expect(seen).toHaveLength(0);
    });

    it('does NOT cache "no coverage" when the upstream was unreachable', async () => {
        // The dangerous direction. A null year cached as a fact would make an
        // outage look like permanently unphotographed land.
        const { impl } = router({ dates: () => new Error('ECONNREFUSED') });
        const c = await resolveOrthoCoverage(ctx, BBOX, { fetchImpl: impl });
        expect(c.year).toBeNull();
        expect(redisDouble.set).not.toHaveBeenCalled();
    });

    it('serves a second viewport from the cache', async () => {
        const { impl, seen } = router({ dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)) });
        await resolveOrthoCoverage(ctx, BBOX, { fetchImpl: impl });
        const before = seen.length;
        await resolveOrthoCoverage(ctx, BBOX, { fetchImpl: impl });
        expect(seen).toHaveLength(before);
    });
});

describe('absent vs unavailable — the decision this module exists for (#2421)', () => {
    it('an upstream ERROR is unavailable (503), never absent (204)', async () => {
        // If this returned `absent` the route would answer 204 and the phone
        // would draw plain ground for the rest of the session over land that
        // may well be photographed.
        const { impl } = router({
            dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)),
            tile: () => bytesRes(0, 500),
        });
        const t = await fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: impl });
        expect(t.kind).toBe('unavailable');
    });

    it('an upstream THROW is unavailable too', async () => {
        const { impl } = router({
            dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)),
            tile: () => new Error('socket hang up'),
        });
        const t = await fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: impl });
        expect(t.kind).toBe('unavailable');
    });

    it('an unavailable tile is NOT remembered as absent', async () => {
        // A cached negative after an outage would outlive the outage.
        const { impl } = router({
            dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)),
            tile: () => bytesRes(0, 503),
        });
        await fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: impl });
        expect([...store.keys()].some((k) => k.startsWith('ortho:absent:'))).toBe(false);
    });

    it('the 909-byte blank IS absent, and is remembered', async () => {
        const { impl } = router({
            dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)),
            tile: () => bytesRes(909),
        });
        const t = await fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: impl });
        expect(t.kind).toBe('absent');
        expect([...store.keys()].some((k) => k.startsWith('ortho:absent:'))).toBe(true);
    });

    it('no covering year is absent, and is remembered', async () => {
        const { impl } = router({ dates: () => jsonRes(coverageBody(0)) });
        const t = await fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: impl });
        expect(t.kind).toBe('absent');
        expect([...store.keys()].some((k) => k.startsWith('ortho:absent:'))).toBe(true);
    });

    it('a remembered absence answers without touching the upstream', async () => {
        // Or every uncovered tile re-asks six years of WFS, forever.
        const { impl } = router({ dates: () => jsonRes(coverageBody(0)) });
        await fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: impl });
        const { impl: second, seen } = router({});
        const t = await fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: second });
        expect(t.kind).toBe('absent');
        expect(seen).toHaveLength(0);
    });

    it('an out-of-range address is absent without a fetch', async () => {
        const { impl, seen } = router({});
        // Past the source's 25 cm ceiling.
        expect((await fetchOrthoTile(ctx, 21, 1, 1, { fetchImpl: impl })).kind).toBe('absent');
        // Outside the 2^z grid.
        expect((await fetchOrthoTile(ctx, 10, 9_999, 1, { fetchImpl: impl })).kind).toBe('absent');
        // Over Portugal.
        expect((await fetchOrthoTile(ctx, 15, 15_000, 11_900, { fetchImpl: impl })).kind).toBe(
            'absent',
        );
        expect(seen).toHaveLength(0);
    });
});

describe('serving and caching a tile (#2421)', () => {
    it('returns the bytes and the year they came from', async () => {
        const { impl } = router({
            dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)),
            tile: () => bytesRes(10_368),
        });
        const t = await fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: impl });
        expect(t).toMatchObject({ kind: 'image', year: 2023, contentType: 'image/jpeg' });
        if (t.kind === 'image') expect(t.bytes.byteLength).toBe(10_368);
    });

    it('serves the second request from the cache', async () => {
        const { impl } = router({
            dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)),
            tile: () => bytesRes(10_368),
        });
        await fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: impl });
        const { impl: second, seen } = router({});
        const t = await fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: second });
        expect(t.kind).toBe('image');
        expect(seen).toHaveLength(0);
    });

    it('counts what it stores, so the cache has a readable size', async () => {
        const { impl } = router({
            dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)),
            tile: () => bytesRes(10_368),
        });
        await fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: impl });
        expect(store.get('ortho:tilecount:v1')).toBe('1');
    });

    it('past the ceiling it SERVES but does not store, and the count stays honest', async () => {
        // Degrading to a slower map beats evicting someone else's working set
        // or filling the instance. The counter is given back so it reports the
        // cache's size rather than the number of attempts.
        store.set('ortho:tilecount:v1', String(200_000));
        const { impl } = router({
            dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)),
            tile: () => bytesRes(10_368),
        });
        const t = await fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: impl });
        expect(t.kind).toBe('image');
        expect(store.get('ortho:tilecount:v1')).toBe('200000');
        expect([...store.keys()].some((k) => k.startsWith('ortho:tile:v1:'))).toBe(false);
    });

    it('still serves with no Redis at all', async () => {
        redisPresent = false;
        const { impl } = router({
            dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)),
            tile: () => bytesRes(10_368),
        });
        const t = await fetchOrthoTile(ctx, TILE.z, TILE.x, TILE.y, { fetchImpl: impl });
        expect(t.kind).toBe('image');
    });
});

describe('the physical blocks (#2421)', () => {
    function blocksBody(n: number, withId = true) {
        return {
            features: Array.from({ length: n }, (_, i) => ({
                properties: {
                    ...(withId ? { PHBIDENT: `56722-${i}` } : {}),
                    USAGECODE: '010',
                    USAGEBUL: 'Обработваеми земи',
                },
                geometry: { type: 'MultiPolygon', coordinates: [] },
            })),
        };
    }

    it('maps the Ministry’s own field names', async () => {
        const { impl } = router({
            dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)),
            blocks: () => jsonRes(blocksBody(2)),
        });
        const r = await fetchOrthoBlocks(ctx, BBOX, { fetchImpl: impl });
        expect(r.year).toBe(2023);
        expect(r.truncated).toBe(false);
        expect(r.features[0]).toEqual({
            id: '56722-0',
            usage: 'Обработваеми земи',
            usageCode: '010',
            geometry: { type: 'MultiPolygon', coordinates: [] },
        });
    });

    it('caps the list and SAYS it was cut', async () => {
        // A cut list that does not say so reads as a complete one, and a
        // farmer would see a map missing blocks with nothing to indicate it.
        const { impl } = router({
            dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)),
            blocks: () => jsonRes(blocksBody(601)),
        });
        const r = await fetchOrthoBlocks(ctx, BBOX, { fetchImpl: impl });
        expect(r.features).toHaveLength(600);
        expect(r.truncated).toBe(true);
    });

    it('an exact full page is not reported as truncated', async () => {
        // The reason the upstream count is cap+1: without it a page of exactly
        // 600 would be indistinguishable from a cut one.
        const { impl } = router({
            dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)),
            blocks: () => jsonRes(blocksBody(600)),
        });
        const r = await fetchOrthoBlocks(ctx, BBOX, { fetchImpl: impl });
        expect(r.features).toHaveLength(600);
        expect(r.truncated).toBe(false);
    });

    it('drops a block with no PHBIDENT rather than drawing an unnamed outline', async () => {
        const { impl } = router({
            dates: (y) => jsonRes(coverageBody(y === 2023 ? 1 : 0)),
            blocks: () => jsonRes(blocksBody(3, false)),
        });
        const r = await fetchOrthoBlocks(ctx, BBOX, { fetchImpl: impl });
        expect(r.features).toEqual([]);
        // Not truncated — nothing was cut, the features were unusable.
        expect(r.truncated).toBe(false);
    });

    it('returns nothing when no year covers the area, without asking for blocks', async () => {
        const { impl, seen } = router({ dates: () => jsonRes(coverageBody(0)) });
        const r = await fetchOrthoBlocks(ctx, BBOX, { fetchImpl: impl });
        expect(r).toEqual({ year: null, features: [], truncated: false });
        expect(seen.some((u) => u.includes('Agricultural_Land'))).toBe(false);
    });
});
