/**
 * The parcel-overview map's arithmetic, executed.
 *
 * Everything here runs under jsdom's blind spot in the real component:
 * `getContext('2d')` returns null, so the draw and hit-test paths that
 * consume these functions never execute in a rendered test. That is
 * precisely why the functions live outside the component — a guard that
 * greps the source would prove they are CALLED and nothing about whether
 * they are RIGHT.
 *
 * Each `it()` names the production break it catches.
 */

import geometry from '../../../public/geo/bg-map-geometry.json';
import { fitToExtent, makeProjector, type BgProjection } from '@/lib/geo/bg-projection';
import {
    MAX_ZOOM_TIER,
    MIN_ZOOM_TIER,
    PARCEL_TIER_THRESHOLD,
    UNPOSITIONED_CLUSTER_ID,
    bboxSpanMetres,
    composeBridgeTransform,
    encodeClusterToken,
    parseClusterToken,
    projectionBridge,
    resolveClusterSelection,
    shouldDrawParcels,
    zoomTierForSpan,
} from '@/components/locations/parcel-overview-model';

const NATIONAL = (geometry as { proj: BgProjection }).proj;

// A small holding near Драгоево, Shumen oblast.
const FARM_BBOX = [26.86, 43.09, 26.94, 43.14] as const;

describe('cluster token codec', () => {
    // Break: a `?cluster=` link set at one zoom resolving to nothing at
    // another, so the table filters to zero rows and reports "no parcels".
    it('round-trips an id and the tier it was minted at', () => {
        const token = parseClusterToken(encodeClusterToken('c1abc', 8));
        expect(token).toEqual({ id: 'c1abc', zoomTier: 8 });
    });

    it('keeps the id intact when the id itself contains the separator', () => {
        // `clusterIdFor` returns `c<base36>` today, but the codec must not
        // quietly corrupt an id if that ever changes: the tier is parsed
        // from the LAST separator, not the first.
        const token = parseClusterToken(encodeClusterToken('c1@abc', 12));
        expect(token).toEqual({ id: 'c1@abc', zoomTier: 12 });
    });

    // Break: a hand-edited or truncated URL throwing on render.
    it.each<[string | null, string]>([
        ['', 'empty'],
        [null, 'absent'],
        ['c1abc', 'no tier'],
        ['c1abc@', 'trailing separator'],
        ['@8', 'no id'],
        ['c1abc@nope', 'non-numeric tier'],
        ['c1abc@8.5', 'fractional tier'],
        ['c1abc@2', 'tier below the clustering range'],
        ['c1abc@40', 'tier above the clustering range'],
    ])('rejects %p (%s) rather than throwing', (raw) => {
        expect(parseClusterToken(raw)).toBeNull();
    });
});

describe('zoom tiering', () => {
    // Break: asking the server for a pitch that puts every parcel in one
    // cell (nothing to pick) or every parcel in its own (the list again).
    it('stays inside the range cellMetresForZoom actually distinguishes', () => {
        for (const span of [1, 50, 500, 5_000, 50_000, 500_000, 5_000_000]) {
            const tier = zoomTierForSpan(span);
            expect(tier).toBeGreaterThanOrEqual(MIN_ZOOM_TIER);
            expect(tier).toBeLessThanOrEqual(MAX_ZOOM_TIER);
            expect(Number.isInteger(tier)).toBe(true);
        }
    });

    it('asks for a finer pitch as less ground is visible', () => {
        const wide = zoomTierForSpan(40_000);
        const mid = zoomTierForSpan(5_000);
        const tight = zoomTierForSpan(600);
        expect(wide).toBeLessThan(mid);
        expect(mid).toBeLessThan(tight);
    });

    it('saturates rather than throwing on a degenerate span', () => {
        expect(zoomTierForSpan(0)).toBe(MAX_ZOOM_TIER);
        expect(zoomTierForSpan(Number.NaN)).toBe(MAX_ZOOM_TIER);
        expect(zoomTierForSpan(-1)).toBe(MAX_ZOOM_TIER);
    });

    // Break: "zoom in and clusters split into parcels" never happening,
    // because cellMetresForZoom floors at 200 m and two parcels 150 m
    // apart stay merged at every tier.
    it('switches to individual parcels exactly where the grid stops splitting', () => {
        expect(shouldDrawParcels(PARCEL_TIER_THRESHOLD - 1)).toBe(false);
        expect(shouldDrawParcels(PARCEL_TIER_THRESHOLD)).toBe(true);
        expect(shouldDrawParcels(MAX_ZOOM_TIER)).toBe(true);
    });

    it('measures a bbox by its wider axis', () => {
        // ~6.5 km east-west, ~5.6 km north-south at 43°N.
        const span = bboxSpanMetres(FARM_BBOX);
        expect(span).toBeGreaterThan(5_000);
        expect(span).toBeLessThan(8_000);

        // A holding strung out east-west must be measured across, not down:
        // framing it by its height would put every parcel in one cell.
        const wideThin = bboxSpanMetres([26.0, 43.0, 27.0, 43.01]);
        expect(wideThin).toBeGreaterThan(70_000);
    });
});

describe('projection bridge', () => {
    // Break: oblast outlines drawn at national scale under a farm-scale
    // fit — i.e. context geometry in the wrong place, which reads as a
    // broken map rather than as a transform bug.
    it('places a nationally-projected point exactly where the farm projection would', () => {
        const fitted = fitToExtent(NATIONAL, FARM_BBOX, 1000, 600, { padding: 40 });
        const bridge = projectionBridge(NATIONAL, fitted);
        const projectNational = makeProjector(NATIONAL);
        const projectFarm = makeProjector(fitted);

        for (const [lon, lat] of [
            [26.86, 43.09],
            [26.94, 43.14],
            [26.9, 43.115],
            // Deliberately outside the farm box: the bridge is affine, so
            // it has to hold everywhere, not just inside the frame.
            [23.32, 42.7],
        ] as const) {
            const [nx, ny] = projectNational(lon, lat);
            const [fx, fy] = projectFarm(lon, lat);
            expect(bridge.scaleX * nx + bridge.tx).toBeCloseTo(fx, 6);
            expect(bridge.scaleY * ny + bridge.ty).toBeCloseTo(fy, 6);
        }
    });

    it('is the identity when both sides are the same projection', () => {
        const bridge = projectionBridge(NATIONAL, NATIONAL);
        expect(bridge.scaleX).toBeCloseTo(1, 12);
        expect(bridge.scaleY).toBeCloseTo(1, 12);
        expect(bridge.tx).toBeCloseTo(0, 9);
        expect(bridge.ty).toBeCloseTo(0, 9);
    });

    // Break: the composition order of DPR, pan/zoom and the bridge —
    // the one thing here that is genuinely easy to get backwards, and
    // invisible under jsdom because setTransform is never called.
    it('composes bridge → view → device pixel ratio in that order', () => {
        const bridge = { scaleX: 3, scaleY: 5, tx: 7, ty: 11 };
        const view = { k: 2, tx: 100, ty: 200 };
        const dpr = 2;
        const [a, b, c, d, e, f] = composeBridgeTransform(bridge, view, dpr);

        const pathX = 13;
        const pathY = 17;
        // What the matrix does…
        const gotX = a * pathX + c * pathY + e;
        const gotY = b * pathX + d * pathY + f;
        // …must equal bridging into world space, then panning/zooming,
        // then scaling to the backing store.
        const worldX = bridge.scaleX * pathX + bridge.tx;
        const worldY = bridge.scaleY * pathY + bridge.ty;
        expect(gotX).toBeCloseTo(dpr * (view.k * worldX + view.tx), 9);
        expect(gotY).toBeCloseTo(dpr * (view.k * worldY + view.ty), 9);
        expect(b).toBe(0);
        expect(c).toBe(0);
    });
});

describe('selection resolution', () => {
    const overview = {
        clusters: [
            { id: 'cA', parcelIds: ['p1', 'p2', 'p3'], label: 'Драгоево', count: 3 },
            { id: 'cB', parcelIds: ['p4'], label: null, count: 1 },
        ],
        unpositionedParcelIds: ['p9', 'p10'],
    };

    it('snapshots the member ids rather than aliasing the payload', () => {
        const sel = resolveClusterSelection(overview, { id: 'cA', zoomTier: 8 });
        expect(sel).toEqual({
            id: 'cA',
            zoomTier: 8,
            parcelIds: ['p1', 'p2', 'p3'],
            label: 'Драгоево',
            count: 3,
        });
        // Mutating the snapshot must not reach back into the payload —
        // the snapshot is what the table filters on for the rest of the
        // session, long after this payload has been replaced.
        sel!.parcelIds.push('p99');
        expect(overview.clusters[0].parcelIds).toEqual(['p1', 'p2', 'p3']);
    });

    // Break: filtering the table to zero rows and rendering that as an
    // empty holding, when the truth is "that group is gone".
    it('returns null for an id the payload does not contain', () => {
        expect(resolveClusterSelection(overview, { id: 'cZZZ', zoomTier: 8 })).toBeNull();
    });

    it('returns null with no payload or no token', () => {
        expect(resolveClusterSelection(null, { id: 'cA', zoomTier: 8 })).toBeNull();
        expect(resolveClusterSelection(overview, null)).toBeNull();
    });

    it('resolves the unpositioned pseudo-group to the un-geocoded parcels', () => {
        const sel = resolveClusterSelection(overview, { id: UNPOSITIONED_CLUSTER_ID, zoomTier: 9 });
        expect(sel).toMatchObject({
            id: UNPOSITIONED_CLUSTER_ID,
            parcelIds: ['p9', 'p10'],
            count: 2,
            label: null,
        });
    });

    it('does not offer an unpositioned group when every parcel is placed', () => {
        const placed = { ...overview, unpositionedParcelIds: [] };
        expect(resolveClusterSelection(placed, { id: UNPOSITIONED_CLUSTER_ID, zoomTier: 9 })).toBeNull();
    });
});
