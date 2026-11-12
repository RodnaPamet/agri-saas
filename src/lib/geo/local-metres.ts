/**
 * ONE definition of "metres" for lon/lat at Bulgarian latitudes.
 *
 * ## Why this file exists rather than a second copy
 *
 * `bg-projection.ts` opens with the reason, and it applies here verbatim:
 * "Two copies of a projection drift, and the symptom is not an obvious crash:
 * it is a marker in the wrong field, which a farmer reads as bad DATA rather
 * than as a bug." The constant and the distance function were inside
 * `parcel-clustering.ts`, which was right while clustering was the only
 * consumer and a liability the moment a second one appeared — #2948's track
 * simplifier needs point-to-SEGMENT distance in the same metres.
 *
 * `parcel-clustering` re-exports `distanceMetres` so its existing importers
 * and its own test are untouched.
 *
 * ## Why equirectangular and NOT UTM
 *
 * Measured while #2948 stage 3 was specified, because UTM was proposed:
 *
 *  - **Bulgaria spans TWO UTM zones.** 34N covers 18–24°E and 35N covers
 *    24–30°E, so Sofia (23.32°E) and Vidin (22.87°E) are zone 34 while
 *    Plovdiv (24.75°E) and Varna (27.91°E) are zone 35. One EPSG constant is
 *    wrong for half the country.
 *  - **The repo has no proj4 and no UTM implementation.** Adding a production
 *    dependency to project points that are then discarded is a poor trade.
 *  - **The accuracy argument does not favour UTM anyway at this scale.** Zone
 *    35 at Sofia's longitude is 301 km from its central meridian, a net scale
 *    factor of 1.000715 — 2.1 mm of error on a 3 m simplification tolerance.
 *
 * Equirectangular with a `cos(latitude)` correction is zone-free, exact enough
 * at farm scale, and far cheaper. It is NOT suitable for distances of hundreds
 * of kilometres; nothing here asks for that.
 */

/**
 * Metres per degree of latitude. Longitude degrees shrink with
 * cos(latitude), which every function here corrects for — at Bulgaria's ~43°N
 * a degree of longitude is about 73% of a degree of latitude, so ignoring it
 * stretches every east–west distance by a third.
 */
export const M_PER_DEG_LAT = 111_320;

/**
 * Great-circle-ish distance in metres. Equirectangular — exact enough at farm
 * scale, and far cheaper than haversine for a large scan.
 */
export function distanceMetres(aLon: number, aLat: number, bLon: number, bLat: number): number {
    const midLatRad = ((aLat + bLat) / 2) * (Math.PI / 180);
    const dx = (bLon - aLon) * Math.cos(midLatRad) * M_PER_DEG_LAT;
    const dy = (bLat - aLat) * M_PER_DEG_LAT;
    return Math.hypot(dx, dy);
}

/** A point in a local planar frame, metres east and north of some origin. */
export interface LocalPoint {
    x: number;
    y: number;
}

/**
 * Project lon/lat into metres relative to `originLat`'s latitude band.
 *
 * The cos factor comes from ONE latitude for the whole set, not per point.
 * That is deliberate: a per-point cos makes the transform non-affine, so two
 * points at the same longitude but different latitudes get different x — and
 * a perpendicular distance computed in such a frame is not a distance in any
 * plane. Over a farm the latitude span is small enough that one band is
 * exact to well under the tolerances anything here uses.
 */
export function toLocalMetres(lon: number, lat: number, originLon: number, originLat: number): LocalPoint {
    const cosLat = Math.cos(originLat * (Math.PI / 180));
    return {
        x: (lon - originLon) * cosLat * M_PER_DEG_LAT,
        y: (lat - originLat) * M_PER_DEG_LAT,
    };
}

/**
 * Perpendicular distance in metres from `p` to the SEGMENT `a`–`b`.
 *
 * Segment, not infinite line: Douglas–Peucker's correctness depends on it, and
 * a point beyond an endpoint must measure to that endpoint. It also handles a
 * degenerate segment (`a` equal to `b`, which a stationary machine produces in
 * quantity) by falling back to the point distance rather than dividing by
 * zero.
 *
 * Computed in a LOCAL PLANAR FRAME rather than from three great-circle
 * distances via Heron's formula: Heron is numerically unstable for thin
 * triangles, and the triangles Douglas–Peucker tests are exactly that shape.
 */
export function perpendicularMetres(
    p: readonly [lon: number, lat: number],
    a: readonly [lon: number, lat: number],
    b: readonly [lon: number, lat: number],
): number {
    const originLon = a[0];
    const originLat = a[1];
    const pp = toLocalMetres(p[0], p[1], originLon, originLat);
    const pa = toLocalMetres(a[0], a[1], originLon, originLat);
    const pb = toLocalMetres(b[0], b[1], originLon, originLat);

    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(pp.x - pa.x, pp.y - pa.y);

    // Clamped projection parameter — this is what makes it a segment.
    let t = ((pp.x - pa.x) * dx + (pp.y - pa.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(pp.x - (pa.x + t * dx), pp.y - (pa.y + t * dy));
}
