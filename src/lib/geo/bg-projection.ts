/**
 * The Bulgaria lon/lat → canvas projection, in one place.
 *
 * `public/geo/bg-map-geometry.json` ships a pre-computed equirectangular
 * fit of the country: a bounding box, a `cos` factor for the latitude
 * (so degrees of longitude are not drawn wider than degrees of
 * latitude), an origin offset and a scale. The transform itself used to
 * live inline inside `ExchangeMap` — fine while there was one consumer,
 * a liability the moment there are two.
 *
 * Two copies of a projection drift, and the symptom is not an obvious
 * crash: it is a marker in the wrong field, which a farmer reads as bad
 * DATA rather than as a bug. So this module is the single definition,
 * and `tests/guards/bg-projection-single-source.test.ts` fails CI if a
 * consumer re-inlines the arithmetic.
 *
 * Pure functions only — no React, no canvas, no DOM. That is what makes
 * the arithmetic testable without rendering anything, which matters
 * because jsdom implements no canvas rendering at all.
 */

/** The shape bundled in `public/geo/bg-map-geometry.json`. */
export interface BgProjection {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    /** cos(mid-latitude) — squares the aspect so the country isn't stretched. */
    cos: number;
    ox: number;
    oy: number;
    s: number;
}

export interface BgMapGeometry {
    W: number;
    H: number;
    proj: BgProjection;
    oblasti: { d: string; iso: string; name: string }[];
    outlinePath: string;
}

/** A lon/lat pair. Ordered lon-FIRST, matching GeoJSON and the settlement file. */
export type LonLat = readonly [lon: number, lat: number];
/** A projected point in the geometry's W×H space. */
export type Point = [x: number, y: number];

/** [west, south, east, north] — the GeoJSON bbox order. */
export type BBox = readonly [minLon: number, minLat: number, maxLon: number, maxLat: number];

/**
 * Build the lon/lat → [x, y] projector for a given `proj`.
 *
 * This is byte-for-byte the arithmetic that lived at
 * `ExchangeMap.tsx:217`; `tests/unit/geo/bg-projection.test.ts` pins the
 * outputs for known points so the extraction is provably
 * behaviour-preserving rather than merely believed to be.
 */
export function makeProjector(proj: BgProjection): (lon: number, lat: number) => Point {
    return (lon, lat) => [
        proj.ox + (lon - proj.minX) * proj.cos * proj.s,
        proj.oy + (proj.maxY - lat) * proj.s,
    ];
}

/**
 * The inverse, for hit-testing: given a canvas point, which lon/lat is
 * under the cursor. Exact inverse of `makeProjector` — a click that
 * lands on a marker must resolve to the coordinate that drew it.
 */
export function makeInverseProjector(proj: BgProjection): (x: number, y: number) => Point {
    return (x, y) => [
        proj.minX + (x - proj.ox) / (proj.cos * proj.s),
        proj.maxY - (y - proj.oy) / proj.s,
    ];
}

/**
 * Re-frame the projection around a bounding box.
 *
 * The bundled `proj` frames the WHOLE COUNTRY, which is right for the
 * marketplace overview and wrong for one farm: a holding occupying 0.5%
 * of Bulgaria drawn at national scale is a few pixels of dots. This
 * returns a `BgProjection` framing just `bbox`, preserving the same
 * `cos` aspect correction so shapes are not distorted relative to the
 * national view.
 *
 * `padding` insets the frame so markers on the extreme edge are not
 * drawn half-off the canvas.
 *
 * A degenerate bbox — one parcel, or several sharing a coordinate — has
 * zero width or height and would divide by zero. Such a box is widened
 * to `minSpanDeg` around its centre, so a single parcel renders centred
 * at a sane scale instead of at infinite zoom.
 */
export function fitToExtent(
    proj: BgProjection,
    bbox: BBox,
    width: number,
    height: number,
    options: { padding?: number; minSpanDeg?: number } = {},
): BgProjection {
    const padding = options.padding ?? 24;
    const minSpanDeg = options.minSpanDeg ?? 0.02; // ~2 km — one parcel

    let [minLon, minLat, maxLon, maxLat] = bbox;

    // Widen a degenerate box rather than dividing by zero.
    if (maxLon - minLon < minSpanDeg) {
        const midLon = (minLon + maxLon) / 2;
        minLon = midLon - minSpanDeg / 2;
        maxLon = midLon + minSpanDeg / 2;
    }
    if (maxLat - minLat < minSpanDeg) {
        const midLat = (minLat + maxLat) / 2;
        minLat = midLat - minSpanDeg / 2;
        maxLat = midLat + minSpanDeg / 2;
    }

    const innerW = Math.max(1, width - padding * 2);
    const innerH = Math.max(1, height - padding * 2);

    // Same `cos` correction the national projection uses, so the farm
    // view is not horizontally stretched relative to the country view.
    const spanX = (maxLon - minLon) * proj.cos;
    const spanY = maxLat - minLat;

    // The SMALLER scale wins — the whole box has to fit both axes.
    const s = Math.min(innerW / spanX, innerH / spanY);

    // Centre the box in the leftover space on the looser axis.
    const ox = padding + (innerW - spanX * s) / 2;
    const oy = padding + (innerH - spanY * s) / 2;

    return { ...proj, minX: minLon, maxX: maxLon, minY: minLat, maxY: maxLat, ox, oy, s };
}

/**
 * Bounding box of a set of lon/lat points, or `null` for an empty set.
 * `null` rather than a zero box: "no parcels have coordinates" is a
 * different statement from "all the parcels are at 0°N 0°E".
 */
export function bboxOf(points: readonly LonLat[]): BBox | null {
    if (points.length === 0) return null;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lon, lat] of points) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
    }
    return [minLon, minLat, maxLon, maxLat];
}
