/**
 * Unit test — the Earth Engine index pipeline feeds each index's band math
 * AND its display window into `getMap`.
 *
 * Complements the pure `vegetation-index-recipes` ratchet: that asserts the
 * recipe DATA is sane; this asserts `getIndexTileUrl` actually APPLIES it —
 * the right band pair / expression reaches `normalizedDifference` /
 * `expression`, and the recipe's `{min,max,palette}` reaches `getMap`. That
 * is the closest we can get to "the overlay renders as intended" without a
 * live Earth Engine call. In particular it locks the 2026-07-02 clamp fix
 * (originally hit on the since-removed NDWI overlay): the `getMap` window
 * handed to EE for a negative-over-land index like NDMI has `min < 0`, so
 * land pixels are no longer clamped to one colour.
 *
 * It also covers the ACQUISITION-DATE seam: `getIndexTileUrl` resolves an
 * `{ tileUrl, acquiredDate }` pair, where `acquiredDate` comes from
 * `collection.aggregate_max('system:time_start')`. That lookup is fail-soft BY
 * CONTRACT — an EE error or a non-numeric value must yield `acquiredDate:null`
 * while STILL resolving the tile URL, because a missing date label must never
 * sink an otherwise-good composite.
 *
 * `@google/earthengine` is replaced with a recording fake — no network.
 */

interface VisRec {
    min: number;
    max: number;
    palette: string[];
}
/**
 * `aggregate_max(...).evaluate(cb)` behaviour, per test. `mode` drives the
 * three branches `resolveAcquiredDate` has to survive:
 *   `value` — `cb(millis)`, the happy path;
 *   `error` — `cb(null, err)`, EE reported a failure;
 *   `throw` — `aggregate_max` itself blows up (member missing / EE internal).
 */
interface AggregateRec {
    mode: 'value' | 'error' | 'throw';
    value: unknown;
}
const mockRec: {
    nd: string[][];
    expr: { formula: string; vars: string[] }[];
    getMapVis: VisRec[];
    /** Every property name handed to `aggregate_max`. */
    aggregateProps: string[];
    aggregate: AggregateRec;
} = {
    nd: [],
    expr: [],
    getMapVis: [],
    aggregateProps: [],
    // 2026-06-12T10:00:00Z — deliberately NOT the requested window end, so a
    // test asserting the date proves it came from EE and not from `win.end`.
    aggregate: { mode: 'value', value: Date.UTC(2026, 5, 12, 10, 0, 0) },
};

/** The `YYYY-MM-DD` the default `mockRec.aggregate.value` must render as. */
const ACQUIRED_DATE = '2026-06-12';

jest.mock('@/env', () => ({
    env: {
        GEE_PROJECT_ID: 'proj',
        GEE_SERVICE_ACCOUNT_KEY: JSON.stringify({ type: 'service_account' }),
    },
}));

jest.mock('@google/earthengine', () => {
    const img: Record<string, (...a: unknown[]) => unknown> = {};
    const ret = () => img;
    img.select = ret;
    img.neq = ret;
    img.and = ret;
    img.updateMask = ret;
    img.divide = ret;
    img.rename = ret;
    img.clip = ret;
    img.get = ret;
    img.normalizedDifference = (...a: unknown[]) => {
        mockRec.nd.push(a[0] as string[]);
        return img;
    };
    img.expression = (...a: unknown[]) => {
        mockRec.expr.push({ formula: a[0] as string, vars: Object.keys(a[1] as object) });
        return img;
    };
    img.getMap = (...a: unknown[]) => {
        mockRec.getMapVis.push(a[0] as VisRec);
        (a[1] as (m: { urlFormat: string }) => void)({
            urlFormat: 'https://earthengine.googleapis.com/v1/tiles/{z}/{x}/{y}',
        });
    };
    const collection: Record<string, (...a: unknown[]) => unknown> = {};
    collection.filterBounds = () => collection;
    collection.filterDate = () => collection;
    collection.filter = () => collection;
    // Adaptive-window helper: latest-acquisition anchor + size()>0 conditional.
    collection.sort = () => collection;
    collection.first = () => img;
    collection.size = () => ({ gt: () => ({}) });
    collection.map = (...a: unknown[]) => {
        (a[0] as (i: unknown) => unknown)(img);
        return collection;
    };
    collection.median = () => img;
    // Acquisition-date lookup. Reads `mockRec` lazily (inside the closures) —
    // the mock factory body runs before the `const mockRec` initializer.
    collection.aggregate_max = (...a: unknown[]) => {
        mockRec.aggregateProps.push(a[0] as string);
        if (mockRec.aggregate.mode === 'throw') {
            throw new Error('aggregate_max exploded');
        }
        return {
            evaluate: (cb: (v: unknown, err?: unknown) => void) => {
                if (mockRec.aggregate.mode === 'error') {
                    cb(null, new Error('EE aggregate failed'));
                    return;
                }
                cb(mockRec.aggregate.value);
            },
        };
    };
    return {
        __esModule: true,
        default: {
            data: {
                authenticateViaPrivateKey: (_k: unknown, ok: () => void) => ok(),
            },
            initialize: (_a: unknown, _b: unknown, ok: () => void) => ok(),
            Geometry: { Rectangle: () => ({}) },
            Filter: { lt: () => ({}) },
            ImageCollection: () => collection,
            // Adaptive-window helper members (missing from the EE type defs).
            Date: () => ({ advance: () => ({}) }),
            Algorithms: { If: (_cond: unknown, whenTrue: unknown) => whenTrue },
        },
    };
});

import { getIndexTileUrl } from '@/lib/agro/earth-engine';
import { INDEX_RECIPES } from '@/lib/agro/index-recipes';
import type { VegetationIndex } from '@/lib/agro/vegetation-indices';

const AOI = { west: 10, south: 40, east: 11, north: 41 };
const WIN = { start: '2026-05-16', end: '2026-06-15' };

beforeEach(() => {
    mockRec.nd = [];
    mockRec.expr = [];
    mockRec.getMapVis = [];
    mockRec.aggregateProps = [];
    mockRec.aggregate = { mode: 'value', value: Date.UTC(2026, 5, 12, 10, 0, 0) };
});

describe.each<VegetationIndex>(['ndvi', 'ndmi', 'ndre', 'gndvi'])(
    'ratio index %s',
    (id) => {
        it('feeds its band pair + recipe display window into getMap', async () => {
            const { tileUrl, acquiredDate } = await getIndexTileUrl(id, AOI, WIN);
            expect(tileUrl).toContain('{z}/{x}/{y}');
            // The date is EE's, read off the collection — not the requested
            // `WIN.end` (2026-06-15), which is what makes it honest.
            expect(acquiredDate).toBe(ACQUIRED_DATE);
            expect(mockRec.aggregateProps).toEqual(['system:time_start']);

            const recipe = INDEX_RECIPES[id];
            // normalizedDifference was called with the recipe's band pair.
            if (recipe.math.kind === 'normalizedDifference') {
                expect(mockRec.nd).toContainEqual(recipe.math.bands);
            }
            // getMap received the recipe's exact display window.
            expect(mockRec.getMapVis).toHaveLength(1);
            expect(mockRec.getMapVis[0]).toEqual({
                min: recipe.min,
                max: recipe.max,
                palette: recipe.palette,
            });
        });
    },
);

it('EVI feeds the enhanced-VI expression (3 bands) + display window into getMap', async () => {
    const { tileUrl, acquiredDate } = await getIndexTileUrl('evi', AOI, WIN);
    expect(tileUrl).toContain('{z}/{x}/{y}');
    expect(acquiredDate).toBe(ACQUIRED_DATE);
    expect(mockRec.expr).toHaveLength(1);
    expect(mockRec.expr[0].formula).toContain('2.5');
    expect(mockRec.expr[0].vars.sort()).toEqual(['BLUE', 'NIR', 'RED']);
    expect(mockRec.getMapVis[0]).toEqual({
        min: INDEX_RECIPES.evi.min,
        max: INDEX_RECIPES.evi.max,
        palette: INDEX_RECIPES.evi.palette,
    });
});

it('NDMI display window includes negatives so land pixels are not clamped', async () => {
    // The 2026-07-02 regression class (first hit on the since-removed NDWI
    // overlay): a min ≥ 0 clamps every negative land pixel to the single
    // low-end colour → one flat block.
    await getIndexTileUrl('ndmi', AOI, WIN);
    expect(mockRec.getMapVis[0].min).toBeLessThan(0);
});

describe('acquisition date is fail-soft', () => {
    // The date is a LABEL. Losing it must degrade to `null` — never reject the
    // tile request, which is the whole reason the overlay renders at all.

    it('resolves acquiredDate:null (tile URL intact) when EE reports an error', async () => {
        mockRec.aggregate = { mode: 'error', value: null };
        const { tileUrl, acquiredDate } = await getIndexTileUrl('ndvi', AOI, WIN);
        expect(tileUrl).toContain('{z}/{x}/{y}');
        expect(acquiredDate).toBeNull();
    });

    it.each<[string, unknown]>([
        ['null', null],
        ['undefined (empty collection)', undefined],
        ['a string', '2026-06-12'],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('resolves acquiredDate:null when EE yields %s', async (_label, value) => {
        mockRec.aggregate = { mode: 'value', value };
        const { tileUrl, acquiredDate } = await getIndexTileUrl('ndvi', AOI, WIN);
        expect(tileUrl).toContain('{z}/{x}/{y}');
        expect(acquiredDate).toBeNull();
    });

    it('resolves acquiredDate:null when aggregate_max itself throws', async () => {
        mockRec.aggregate = { mode: 'throw', value: null };
        const { tileUrl, acquiredDate } = await getIndexTileUrl('ndvi', AOI, WIN);
        expect(tileUrl).toContain('{z}/{x}/{y}');
        expect(acquiredDate).toBeNull();
        // getMap still ran with the recipe window — the failed date lookup did
        // not short-circuit the render.
        expect(mockRec.getMapVis).toHaveLength(1);
    });
});
