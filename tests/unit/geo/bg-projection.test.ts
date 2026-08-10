/**
 * The shared Bulgaria projector.
 *
 * The headline assertion is the PIN: the extracted `makeProjector`
 * reproduces, to the digit, what the inline arithmetic at
 * `ExchangeMap.tsx:217` produced before the refactor. Those expected
 * values were computed FROM THE OLD CODE and written down first, so
 * "behaviour-preserving" is measured here rather than asserted in a
 * commit message. If someone rewrites the formula and these move, the
 * marketplace map has silently shifted every marker.
 *
 * These execute the arithmetic. The structural guard
 * (`tests/guards/bg-projection-single-source.test.ts`) only proves no
 * consumer re-inlines it and contributes no runtime coverage — the two
 * are complementary, and neither substitutes for the other.
 */
import {
    makeProjector,
    makeInverseProjector,
    fitToExtent,
    bboxOf,
    type BgProjection,
} from '@/lib/geo/bg-projection';
import geometry from '../../../public/geo/bg-map-geometry.json';

const proj = geometry.proj as BgProjection;

/**
 * Captured from the PRE-REFACTOR inline formula. Do not "fix" these to
 * match new output — a mismatch means the projection changed.
 */
const PINNED: ReadonlyArray<[label: string, lon: number, lat: number, x: number, y: number]> = [
    ['Sofia', 23.3242, 42.6975, 191.50299872269636, 304.7609563640004],
    ['Varna', 27.9147, 43.2141, 848.7252539855403, 204.08558674399964],
    ['Plovdiv', 24.7453, 42.1354, 394.9620003464905, 414.3033978340006],
    ['Dragoevo', 26.6167, 43.1833, 662.8904892908076, 210.08791230399947],
    ['SW corner', 22.3482, 41.23384, 51.769, 590.0000417259998],
    ['NE corner', 28.60972, 44.21002, 948.231323444811, 10.0],
];

describe('makeProjector — pinned against the pre-refactor inline formula', () => {
    const project = makeProjector(proj);

    it.each(PINNED)('%s projects to the pinned point', (_label, lon, lat, x, y) => {
        const [px, py] = project(lon, lat);
        expect(px).toBeCloseTo(x, 10);
        expect(py).toBeCloseTo(y, 10);
    });

    it('puts the bbox corners on the canvas edges (orientation sanity)', () => {
        // Catches a flipped axis, which the per-point pins alone would
        // not make obvious: north must map to a SMALLER y than south.
        const [, northY] = project(proj.minX, proj.maxY);
        const [, southY] = project(proj.minX, proj.minY);
        expect(northY).toBeLessThan(southY);

        const [westX] = project(proj.minX, proj.maxY);
        const [eastX] = project(proj.maxX, proj.maxY);
        expect(westX).toBeLessThan(eastX);
    });
});

describe('makeInverseProjector', () => {
    const project = makeProjector(proj);
    const invert = makeInverseProjector(proj);

    it.each(PINNED)('round-trips %s back to its lon/lat', (_label, lon, lat) => {
        // Hit-testing depends on this: a click landing on a marker must
        // resolve to the coordinate that drew it.
        const [x, y] = project(lon, lat);
        const [rLon, rLat] = invert(x, y);
        expect(rLon).toBeCloseTo(lon, 10);
        expect(rLat).toBeCloseTo(lat, 10);
    });
});

describe('fitToExtent', () => {
    it('frames a small box across the canvas instead of at national scale', () => {
        // A farm occupying a fraction of a degree must not be drawn at
        // country scale — that is the whole reason this helper exists.
        const farm: [number, number, number, number] = [26.60, 43.17, 26.64, 43.20];
        const fitted = fitToExtent(proj, farm, 800, 600, { padding: 20 });
        const project = makeProjector(fitted);

        const [x0, y0] = project(26.60, 43.20); // NW corner of the box
        const [x1, y1] = project(26.64, 43.17); // SE corner

        // Both corners inside the canvas…
        for (const v of [x0, x1]) expect(v).toBeGreaterThanOrEqual(0);
        for (const v of [x0, x1]) expect(v).toBeLessThanOrEqual(800);
        for (const v of [y0, y1]) expect(v).toBeGreaterThanOrEqual(0);
        for (const v of [y0, y1]) expect(v).toBeLessThanOrEqual(600);

        // …and actually USING the canvas: the box should span most of an
        // axis, not sit as a few pixels in the corner.
        expect(Math.abs(x1 - x0)).toBeGreaterThan(400);
    });

    it('respects padding on the constraining axis', () => {
        const box: [number, number, number, number] = [26.0, 43.0, 27.0, 43.5];
        const fitted = fitToExtent(proj, box, 400, 400, { padding: 50 });
        const project = makeProjector(fitted);
        const [xW] = project(26.0, 43.5);
        expect(xW).toBeGreaterThanOrEqual(50 - 1e-9);
    });

    it('widens a DEGENERATE box rather than dividing by zero', () => {
        // One parcel, or several sharing a coordinate. Without the widen
        // this is 0/0 and every marker lands at NaN — a blank map with no
        // error, which is the worst failure mode available.
        const single: [number, number, number, number] = [26.6167, 43.1833, 26.6167, 43.1833];
        const fitted = fitToExtent(proj, single, 400, 300);
        const [x, y] = makeProjector(fitted)(26.6167, 43.1833);

        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
        // …and roughly centred, since the box was grown around the point.
        expect(x).toBeGreaterThan(100);
        expect(x).toBeLessThan(300);
    });
});

describe('bboxOf', () => {
    it('returns null for an empty set rather than a zero box', () => {
        // "No parcels have coordinates" is a different claim from "every
        // parcel is at 0°N 0°E", and only one of them is true.
        expect(bboxOf([])).toBeNull();
    });

    it('spans every point', () => {
        expect(bboxOf([
            [26.6, 43.1],
            [26.2, 43.4],
            [27.0, 42.9],
        ])).toEqual([26.2, 42.9, 27.0, 43.4]);
    });

    it('handles a single point (degenerate, but valid)', () => {
        expect(bboxOf([[26.6, 43.1]])).toEqual([26.6, 43.1, 26.6, 43.1]);
    });
});
