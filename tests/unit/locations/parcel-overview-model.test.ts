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
    PARCEL_SHAPE_MIN_PANE_SHARE,
    PARCEL_TIER_THRESHOLD,
    UNPOSITIONED_CLUSTER_ID,
    bboxSpanMetres,
    bridgedExtent,
    centreOn,
    clampExtentFor,
    clampTranslation,
    composeBridgeTransform,
    encodeClusterToken,
    farmExtent,
    fitScaleForExtent,
    minZoomScale,
    nextStepIndex,
    orderParcelsForStepping,
    parseClusterToken,
    polygonBBox,
    polygonRings,
    projectionBridge,
    resolveClusterSelection,
    shouldDrawParcels,
    shouldDrawParcelShapes,
    unionExtent,
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

describe('parcel outlines', () => {
    const SQUARE = {
        type: 'MultiPolygon',
        coordinates: [[[[26.9, 43.1], [27.0, 43.1], [27.0, 43.2], [26.9, 43.2], [26.9, 43.1]]]],
    };

    it('reads rings from a MultiPolygon and a bare Polygon alike', () => {
        // Parcel.geometry is a MultiPolygon in the database, but some
        // import paths deliver a plain Polygon — drawing one and not the
        // other means a farm whose fields silently do not render.
        expect(polygonRings(SQUARE)).toHaveLength(1);
        expect(polygonRings({ type: 'Polygon', coordinates: SQUARE.coordinates[0] })).toHaveLength(1);
    });

    it('keeps interior rings, so a field with a hole draws its hole', () => {
        const withHole = {
            type: 'Polygon',
            coordinates: [
                [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
                [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]],
            ],
        };
        expect(polygonRings(withHole)).toHaveLength(2);
    });

    // Break: one malformed parcel taking the whole map down with it.
    // Typed explicitly: a mixed literal table widens into a UNION of
    // tuple types that the callback signature cannot satisfy, and jest
    // runs it happily while `tsc` rejects it — which is how it reaches CI.
    it.each<[unknown, string]>([
        [null, 'null'],
        [undefined, 'undefined'],
        [{ type: 'Point', coordinates: [1, 2] }, 'a Point'],
        [{ type: 'Polygon' }, 'no coordinates'],
        [{ type: 'Polygon', coordinates: 'nope' }, 'garbage coordinates'],
        [{ type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }, 'a ring too short to be an area'],
        [{ type: 'Polygon', coordinates: [[[0, 0], [1, 'x'], [2, 2], [3, 3]]] }, 'a non-numeric vertex'],
    ])('yields no rings for %p (%s) rather than throwing', (geometry) => {
        expect(() => polygonRings(geometry)).not.toThrow();
        expect(polygonRings(geometry)).toEqual([]);
    });

    // Break: framing the holding by its parcel CENTROIDS, which draws the
    // edge fields half off the canvas.
    it('spans the outlines, not their middles', () => {
        expect(polygonBBox([{ geometry: SQUARE }])).toEqual([26.9, 43.1, 27.0, 43.2]);
    });

    it('spans every parcel, and ignores the ones with no geometry', () => {
        const other = {
            type: 'Polygon',
            coordinates: [[[26.5, 43.05], [26.6, 43.05], [26.6, 43.15], [26.5, 43.15], [26.5, 43.05]]],
        };
        expect(polygonBBox([{ geometry: SQUARE }, { geometry: null }, { geometry: other }])).toEqual([
            26.5, 43.05, 27.0, 43.2,
        ]);
    });

    it('returns null when nothing has an outline, so the caller can fall back', () => {
        expect(polygonBBox([])).toBeNull();
        expect(polygonBBox([{ geometry: null }, { geometry: { type: 'Point', coordinates: [1, 2] } }])).toBeNull();
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

describe('how far out the view may zoom', () => {
    const FITTED = fitToExtent(NATIONAL, FARM_BBOX, 1000, 600, { padding: 40 });
    const BRIDGE = projectionBridge(NATIONAL, FITTED);
    const COUNTRY = bridgedExtent(BRIDGE, 1000, 600);
    const FARM = farmExtent(1000, 600);
    // A pane the size the locator actually gets on the Map tab.
    const CW = 800;
    const CH = 480;
    const FIT = Math.min(CW / 1000, CH / 600) * 0.98;

    // Break: the whole reason for this work — a holding that cannot be
    // seen in its national context because the zoom floor stops long
    // before the country is in frame.
    it('the country is very much larger than the holding in this world space', () => {
        // Not an incidental fact: it is why `fit * 0.35` was nowhere near
        // enough, and why the floor has to be measured rather than picked.
        const countryWidth = COUNTRY.maxX - COUNTRY.minX;
        expect(countryWidth / (FARM.maxX - FARM.minX)).toBeGreaterThan(10);
    });

    it('lets the zoom reach a scale that frames the whole country', () => {
        const floor = minZoomScale(FIT, COUNTRY, CW, CH);
        // At the floor the country fits the pane on both axes.
        expect((COUNTRY.maxX - COUNTRY.minX) * floor).toBeLessThanOrEqual(CW);
        expect((COUNTRY.maxY - COUNTRY.minY) * floor).toBeLessThanOrEqual(CH);
        // …and the OLD floor did not, which is the regression this fixes.
        const oldFloor = FIT * 0.35;
        expect((COUNTRY.maxX - COUNTRY.minX) * oldFloor).toBeGreaterThan(CW);
    });

    it('never narrows the range that shipped', () => {
        // Whatever the country works out to, the floor is at most the old
        // one — a geometry change must not silently take zoom-out away.
        expect(minZoomScale(FIT, COUNTRY, CW, CH)).toBeLessThanOrEqual(FIT * 0.35);
        // No geometry yet → exactly the old behaviour.
        expect(minZoomScale(FIT, null, CW, CH)).toBeCloseTo(FIT * 0.35, 12);
        // A pane with no size cannot be measured against.
        expect(minZoomScale(FIT, COUNTRY, 0, 0)).toBeCloseTo(FIT * 0.35, 12);
    });

    // Break: panning at farm zoom wandering off the holding into empty
    // world space, because the clamp was widened to the country for every
    // magnification instead of only the new range.
    it('clamps to the holding while zoomed in, to the country once out past it', () => {
        expect(clampExtentFor(FIT, FIT, FARM, COUNTRY)).toEqual(FARM);
        expect(clampExtentFor(FIT * 4, FIT, FARM, COUNTRY)).toEqual(FARM);
        expect(clampExtentFor(FIT * 0.5, FIT, FARM, COUNTRY)).toEqual(
            unionExtent(FARM, COUNTRY),
        );
        // Nothing to widen to before the geometry loads.
        expect(clampExtentFor(FIT * 0.5, FIT, FARM, null)).toEqual(FARM);
    });

    it('centres an extent smaller than the pane instead of pinning it', () => {
        // What makes "zoom all the way out" land on a centred country
        // rather than one shoved into whichever corner the holding is in.
        const k = fitScaleForExtent(COUNTRY, CW, CH) * 0.9;
        const { tx, ty } = clampTranslation(COUNTRY, k, CW, CH, 99999, -99999);
        const left = COUNTRY.minX * k + tx;
        const right = COUNTRY.maxX * k + tx;
        expect(left).toBeCloseTo(CW - right, 6);
        const top = COUNTRY.minY * k + ty;
        const bottom = COUNTRY.maxY * k + ty;
        expect(top).toBeCloseTo(CH - bottom, 6);
    });

    it('holds a larger-than-pane extent at its edges', () => {
        const k = FIT * 4; // farm box far wider than the pane
        const pulled = clampTranslation(FARM, k, CW, CH, 5000, 5000);
        expect(pulled.tx).toBeCloseTo(0, 6); // cannot drag the left edge inward
        const pushed = clampTranslation(FARM, k, CW, CH, -99999, -99999);
        expect(pushed.tx).toBeCloseTo(CW - (FARM.maxX - FARM.minX) * k, 6);
    });

    it('centreOn puts a world point in the middle of the pane', () => {
        const { tx, ty } = centreOn(250, 125, 2, CW, CH);
        expect(250 * 2 + tx).toBeCloseTo(CW / 2, 9);
        expect(125 * 2 + ty).toBeCloseTo(CH / 2, 9);
    });

    // Break: a hundred parcels drawn as a hundred one-pixel marks over
    // the country outline, which reads as damage rather than as fields.
    it('stops drawing outlines once the holding spans a fifth of the pane', () => {
        expect(shouldDrawParcelShapes(CW * PARCEL_SHAPE_MIN_PANE_SHARE, CW)).toBe(true);
        expect(shouldDrawParcelShapes(CW * PARCEL_SHAPE_MIN_PANE_SHARE - 1, CW)).toBe(false);
        // Whatever else is wrong, an unmeasurable pane must not blank the map.
        expect(shouldDrawParcelShapes(0, 0)).toBe(true);

        // The two predicates answer different questions and neither
        // implies the other: at country scale the tier is at its floor
        // (clustered) AND the shapes are too small — but a large holding
        // can sit at that same floor while filling the pane.
        expect(shouldDrawParcels(MIN_ZOOM_TIER)).toBe(false);
        expect(shouldDrawParcelShapes(1000 * FIT, CW)).toBe(true);
        expect(shouldDrawParcelShapes(1000 * minZoomScale(FIT, COUNTRY, CW, CH), CW)).toBe(false);
    });

    // Break: the threshold quietly changing the zoom range that shipped —
    // outlines vanishing at a magnification the user could already reach.
    it('still draws outlines at the OLD maximum zoom-out, on every pane', () => {
        for (const [cw, ch] of [
            [290, 220], // the compact locator on a small phone
            [360, 500], // the mobile map slot
            [800, 480],
            [900, 480], // wide desktop slot — height-bound fit
            [1200, 480],
        ] as const) {
            const fit = Math.min(cw / 1000, ch / 600) * 0.98;
            expect(shouldDrawParcelShapes(1000 * (fit * 0.35), cw)).toBe(true);

            // …and does not, at the new one.
            const country = bridgedExtent(
                projectionBridge(NATIONAL, fitToExtent(NATIONAL, FARM_BBOX, 1000, 600, { padding: 40 })),
                1000,
                600,
            );
            expect(
                shouldDrawParcelShapes(1000 * minZoomScale(fit, country, cw, ch), cw),
            ).toBe(false);
        }
    });

    // The same, for a holding large enough to shrink the country ratio —
    // the case that squeezes the two boundaries closest together. A 40 km
    // holding makes the country only ~6.7× its box, not the ~78× a 6 km
    // one does, so an "it is always at least ten times" assumption is
    // simply false and this is the case that says so.
    it('holds for a holding big enough to shrink the country ratio', () => {
        const BIG = [26.0, 42.8, 26.5, 43.2] as const; // ~40 km across
        const fitted = fitToExtent(NATIONAL, BIG, 1000, 600, { padding: 40 });
        const country = bridgedExtent(projectionBridge(NATIONAL, fitted), 1000, 600);
        expect((country.maxX - country.minX) / 1000).toBeLessThan(10);

        for (const [cw, ch] of [[290, 220], [800, 480], [1200, 480]] as const) {
            const fit = Math.min(cw / 1000, ch / 600) * 0.98;
            expect(shouldDrawParcelShapes(1000 * (fit * 0.35), cw)).toBe(true);
            expect(
                shouldDrawParcelShapes(1000 * minZoomScale(fit, country, cw, ch), cw),
            ).toBe(false);
        }
    });

    // Break: reading the rule as "outlines vanish when you zoom out",
    // which it deliberately is not. A holding spanning a third of the
    // country is still legible at full zoom-out, and blanking its fields
    // there would be the bug, not the feature.
    it('keeps the outlines for a holding too large to shrink', () => {
        const HUGE = [24.0, 42.0, 27.5, 43.8] as const; // most of the country
        const fitted = fitToExtent(NATIONAL, HUGE, 1000, 600, { padding: 40 });
        const country = bridgedExtent(projectionBridge(NATIONAL, fitted), 1000, 600);
        const [cw, ch] = [800, 480];
        const fit = Math.min(cw / 1000, ch / 600) * 0.98;
        expect(
            shouldDrawParcelShapes(1000 * minZoomScale(fit, country, cw, ch), cw),
        ).toBe(true);
    });
});

describe('stepping through parcels', () => {
    // Deliberately NOT in north-to-south order, so a pass cannot come
    // from the input already being sorted.
    const PARCELS = [
        { id: 'p1', lon: 26.9, lat: 43.11 },
        { id: 'p4', lon: 26.7, lat: 43.2 },
        { id: 'p3', lon: 26.902, lat: 43.112 },
        { id: 'p2', lon: 26.901, lat: 43.111 },
    ];

    // Break: a stepper that walks creation order, which records when a
    // parcel was typed in and says nothing about where it is — so the
    // button reads as a shuffle.
    it('walks north to south', () => {
        expect(orderParcelsForStepping(PARCELS)).toEqual(['p4', 'p3', 'p2', 'p1']);
    });

    it('breaks a shared latitude west to east, then by id', () => {
        const sameLine = [
            { id: 'b', lon: 27.0, lat: 43.0 },
            { id: 'a', lon: 26.0, lat: 43.0 },
            { id: 'c', lon: 26.0, lat: 43.0 },
        ];
        expect(orderParcelsForStepping(sameLine)).toEqual(['a', 'c', 'b']);
    });

    it('is total — the same input always gives the same walk', () => {
        const once = orderParcelsForStepping(PARCELS);
        const again = orderParcelsForStepping([...PARCELS].reverse());
        expect(again).toEqual(once);
    });

    it('does not mutate the callers array', () => {
        const input = [...PARCELS];
        orderParcelsForStepping(input);
        expect(input.map((p) => p.id)).toEqual(['p1', 'p4', 'p3', 'p2']);
    });

    // Break: stepping wandering outside an active cluster filter, so the
    // map and the table below it are answering different questions.
    it('walks only the selected group when there is one', () => {
        expect(orderParcelsForStepping(PARCELS, new Set(['p1', 'p3']))).toEqual(['p3', 'p1']);
        expect(orderParcelsForStepping(PARCELS, new Set())).toEqual([]);
    });

    it('skips a parcel with no usable coordinate rather than flying to NaN', () => {
        const broken = [...PARCELS, { id: 'bad', lon: Number.NaN, lat: 43.5 }];
        expect(orderParcelsForStepping(broken)).not.toContain('bad');
    });

    // Break: a stepper that stops responding at the last parcel, which is
    // indistinguishable from a broken button.
    it('wraps at the end and starts from nothing-visited', () => {
        expect(nextStepIndex(-1, 4)).toBe(0);
        expect(nextStepIndex(0, 4)).toBe(1);
        expect(nextStepIndex(3, 4)).toBe(0);
        expect(nextStepIndex(-1, 0)).toBe(-1);
        expect(nextStepIndex(2, 0)).toBe(-1);
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
