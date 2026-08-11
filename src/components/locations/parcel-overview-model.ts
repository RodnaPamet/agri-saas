/**
 * The arithmetic behind the parcel-overview map, with no canvas in sight.
 *
 * jsdom implements no 2D context, so anything that runs inside `draw()`
 * is unreachable by a rendered test — `ExchangeMap` has zero executing
 * coverage for exactly that reason. Everything here is therefore pure and
 * lives outside the component: zoom tiering, the cluster-token codec, the
 * bridge between two projections, and selection resolution. The component
 * is left holding refs, effects and paint.
 */

import { distanceMetres } from '@/lib/geo/parcel-clustering';
import { makeProjector } from '@/lib/geo/bg-projection';
import type { BBox, BgProjection } from '@/lib/geo/bg-projection';

/** The zoom range `cellMetresForZoom` actually distinguishes. */
export const MIN_ZOOM_TIER = 6;
export const MAX_ZOOM_TIER = 14;

/**
 * The tier at which `cellMetresForZoom` hits its 200 m floor.
 *
 * Past here the grid cannot split any further — tier 13 and tier 14
 * produce identical clusterings — so the grid stops being the answer and
 * the view draws individual parcels instead. This is the seam that makes
 * "zoom in and clusters split into parcels" true rather than aspirational.
 */
export const PARCEL_TIER_THRESHOLD = 13;

/** Roughly how many cluster cells should span the visible width. */
const TARGET_CELLS_ACROSS = 6;

/** The sentinel id for the "parcels with no location" pseudo-cluster. */
export const UNPOSITIONED_CLUSTER_ID = 'unpositioned';

/**
 * Widest ground distance the bbox covers, in metres.
 *
 * The wider axis decides: a holding strung out east-to-west is framed by
 * its width, and clustering that framing by its (small) height would put
 * every parcel in one cell.
 */
export function bboxSpanMetres(bbox: BBox): number {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const width = distanceMetres(minLon, minLat, maxLon, minLat);
    const height = distanceMetres(minLon, minLat, minLon, maxLat);
    return Math.max(width, height);
}

/**
 * Which zoom tier to ask the server for, given how much ground is visible.
 *
 * The endpoint's `zoom` is a grid pitch in disguise, not a slippy-map
 * zoom, so the client cannot just forward a canvas scale factor. It picks
 * the tier whose cell is about a sixth of the visible span — few enough
 * clusters to read, many enough to be worth clustering at all.
 */
export function zoomTierForSpan(spanMetres: number): number {
    if (!Number.isFinite(spanMetres) || spanMetres <= 0) return MAX_ZOOM_TIER;
    // cell(t) = 20_000 / 2**(t-6); solve cell = span / TARGET_CELLS_ACROSS.
    const tier = MIN_ZOOM_TIER + Math.log2((20_000 * TARGET_CELLS_ACROSS) / spanMetres);
    return Math.min(MAX_ZOOM_TIER, Math.max(MIN_ZOOM_TIER, Math.round(tier)));
}

/** Whether the view is zoomed past the point where clustering can help. */
export function shouldDrawParcels(zoomTier: number): boolean {
    return zoomTier >= PARCEL_TIER_THRESHOLD;
}

// ── Cluster token ────────────────────────────────────────────────────
//
// A cluster id is an FNV-1a hash of its member set, so it changes
// whenever the grid pitch changes the membership — which is every zoom
// tier. A bare `?cluster=c1abc` set at tier 8 therefore matches nothing
// at tier 12: the table would filter to zero rows and render its empty
// state, announcing "no parcels" on the strength of a lookup that failed.
//
// The token carries the tier the id was minted at, so a shared link
// re-resolves against the same clustering it was created from. One
// param, so the facet stays a single filter key and `hasActive` keeps
// counting truthfully.

const TOKEN_SEPARATOR = '@';

export interface ClusterToken {
    id: string;
    zoomTier: number;
}

export function encodeClusterToken(id: string, zoomTier: number): string {
    return `${id}${TOKEN_SEPARATOR}${zoomTier}`;
}

/** `null` for anything malformed — a hand-edited URL must not throw. */
export function parseClusterToken(token: string | null | undefined): ClusterToken | null {
    if (!token) return null;
    const at = token.lastIndexOf(TOKEN_SEPARATOR);
    if (at <= 0 || at === token.length - 1) return null;
    const id = token.slice(0, at);
    const zoomTier = Number(token.slice(at + 1));
    if (!Number.isInteger(zoomTier)) return null;
    if (zoomTier < MIN_ZOOM_TIER || zoomTier > MAX_ZOOM_TIER) return null;
    return { id, zoomTier };
}

// ── Selection ────────────────────────────────────────────────────────

export interface ClusterSelection {
    id: string;
    zoomTier: number;
    /**
     * The member ids, snapshotted at selection time.
     *
     * The table filters on THIS, never on a live re-lookup by id: the
     * user is free to keep zooming, and the group they picked has to stay
     * the group they picked.
     */
    parcelIds: string[];
    label: string | null;
    count: number;
}

/** The overview fields this module needs — structural, so tests need no fixture builder. */
export interface OverviewLike {
    clusters: ReadonlyArray<{
        id: string;
        parcelIds: string[];
        label: string | null;
        count: number;
    }>;
    unpositionedParcelIds: string[];
}

/**
 * Resolve a URL token against a payload fetched at the token's own tier.
 *
 * Returns `null` when the id is absent — a cluster that genuinely no
 * longer exists (the parcels moved, or were deleted) clears the filter
 * rather than filtering to nothing.
 */
export function resolveClusterSelection(
    overview: OverviewLike | null | undefined,
    token: ClusterToken | null,
): ClusterSelection | null {
    if (!overview || !token) return null;

    if (token.id === UNPOSITIONED_CLUSTER_ID) {
        if (overview.unpositionedParcelIds.length === 0) return null;
        return {
            id: UNPOSITIONED_CLUSTER_ID,
            zoomTier: token.zoomTier,
            parcelIds: [...overview.unpositionedParcelIds],
            label: null,
            count: overview.unpositionedParcelIds.length,
        };
    }

    const cluster = overview.clusters.find((c) => c.id === token.id);
    if (!cluster) return null;
    return {
        id: cluster.id,
        zoomTier: token.zoomTier,
        parcelIds: [...cluster.parcelIds],
        label: cluster.label,
        count: cluster.count,
    };
}

// ── Parcel geometry ──────────────────────────────────────────────────

/** A lon/lat ring, as GeoJSON orders it. */
export type Ring = ReadonlyArray<readonly [number, number]>;

/**
 * Every outer/inner ring of a Polygon or MultiPolygon, flattened.
 *
 * `Parcel.geometry` is a MultiPolygon in the database, but a single
 * Polygon arrives from some import paths, so both are handled. Anything
 * else — a Point, a null, a malformed blob — yields no rings rather than
 * throwing: one bad parcel must not blank the whole map.
 */
export function polygonRings(geometry: unknown): Ring[] {
    const g = geometry as { type?: string; coordinates?: unknown } | null | undefined;
    if (!g || typeof g.type !== 'string' || !Array.isArray(g.coordinates)) return [];

    // A single bad vertex REJECTS THE WHOLE RING rather than being
    // skipped. Skipping it would close the outline through the wrong
    // neighbours and draw a boundary that is confidently in the wrong
    // place — and a field boundary drawn wrong is worse than one not
    // drawn, because nothing on screen says it is wrong. The same
    // reasoning the endpoint applies when a non-finite coordinate makes a
    // parcel unpositioned rather than mis-positioned.
    const asRing = (candidate: unknown): Ring | null => {
        if (!Array.isArray(candidate)) return null;
        const ring: Array<readonly [number, number]> = [];
        for (const pt of candidate) {
            if (!Array.isArray(pt) || pt.length < 2) return null;
            const lon = Number(pt[0]);
            const lat = Number(pt[1]);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
            ring.push([lon, lat]);
        }
        return ring.length >= 3 ? ring : null;
    };

    const out: Ring[] = [];
    if (g.type === 'Polygon') {
        for (const ring of g.coordinates as unknown[]) {
            const r = asRing(ring);
            if (r) out.push(r);
        }
    } else if (g.type === 'MultiPolygon') {
        for (const poly of g.coordinates as unknown[]) {
            if (!Array.isArray(poly)) continue;
            for (const ring of poly) {
                const r = asRing(ring);
                if (r) out.push(r);
            }
        }
    }
    return out;
}

/**
 * Bounding box over parcel OUTLINES, not their centroids.
 *
 * The clusters payload's `bbox` spans the centroid points, so a parcel
 * on the edge of the holding is framed by its middle and drawn with half
 * of itself past the canvas edge. Fitting to the real geometry is what
 * makes the locator frame the same ground the satellite map does.
 */
export function polygonBBox(shapes: ReadonlyArray<{ geometry: unknown }>): BBox | null {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    let seen = false;
    for (const s of shapes) {
        for (const ring of polygonRings(s.geometry)) {
            for (const [lon, lat] of ring) {
                seen = true;
                if (lon < minLon) minLon = lon;
                if (lon > maxLon) maxLon = lon;
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
            }
        }
    }
    return seen ? [minLon, minLat, maxLon, maxLat] : null;
}

// ── Projection bridge ────────────────────────────────────────────────

/**
 * An affine map from one projection's pixel space into another's.
 *
 * `bg-map-geometry.json` ships oblast outlines already projected under
 * the NATIONAL `proj`. A farm view runs `fitToExtent`, which is a
 * different `proj` — so those paths need re-placing, and re-projecting
 * every vertex of a 5 KB path string is not the way. Both projections are
 * affine in lon/lat, so the composition of one with the other's inverse
 * is affine too: one scale and one offset per axis, computed once.
 *
 * MEASURED FROM `makeProjector`, not re-derived from its parameters.
 * Writing `(to.cos * to.s) / (from.cos * from.s)` here would work today
 * and would be a second copy of the projection's internals — the exact
 * drift `tests/guards/bg-projection-single-source.test.ts` exists to
 * prevent, just expressed as a ratio instead of a transform. Two probe
 * points through the real projector pin the affine map on each axis, so
 * if the projection ever changes shape this follows it for free.
 */
export interface ProjectionBridge {
    scaleX: number;
    scaleY: number;
    tx: number;
    ty: number;
}

export function projectionBridge(from: BgProjection, to: BgProjection): ProjectionBridge {
    const projectFrom = makeProjector(from);
    const projectTo = makeProjector(to);

    // One degree apart: always well-conditioned for any real projection,
    // and it never has to care whether the boxes overlap.
    const lon0 = from.minX;
    const lon1 = from.minX + 1;
    const lat0 = from.maxY;
    const lat1 = from.maxY - 1;

    const [fx0, fy0] = projectFrom(lon0, lat0);
    const [fx1] = projectFrom(lon1, lat0);
    const [, fy1] = projectFrom(lon0, lat1);
    const [tx0, ty0] = projectTo(lon0, lat0);
    const [tx1] = projectTo(lon1, lat0);
    const [, ty1] = projectTo(lon0, lat1);

    const scaleX = fx1 === fx0 ? 1 : (tx1 - tx0) / (fx1 - fx0);
    const scaleY = fy1 === fy0 ? 1 : (ty1 - ty0) / (fy1 - fy0);

    return {
        scaleX,
        scaleY,
        tx: tx0 - scaleX * fx0,
        ty: ty0 - scaleY * fy0,
    };
}

/**
 * Fold a bridge, the pan/zoom view and the device pixel ratio into the
 * six numbers `ctx.setTransform` wants.
 *
 * Kept here rather than inline in `draw` so the composition order — the
 * thing that is actually easy to get wrong — is covered by an executing
 * test instead of by eye.
 */
export function composeBridgeTransform(
    bridge: ProjectionBridge,
    view: { k: number; tx: number; ty: number },
    dpr: number,
): [number, number, number, number, number, number] {
    return [
        dpr * view.k * bridge.scaleX,
        0,
        0,
        dpr * view.k * bridge.scaleY,
        dpr * (view.k * bridge.tx + view.tx),
        dpr * (view.k * bridge.ty + view.ty),
    ];
}
