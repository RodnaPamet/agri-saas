import { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { ParcelRepository } from '../repositories/ParcelRepository';
import {
    clusterParcels,
    labelClusters,
    type ParcelCluster,
    type PositionedParcel,
    type SettlementRow,
} from '@/lib/geo/parcel-clustering';
import { bboxOf, type BBox } from '@/lib/geo/bg-projection';
import settlementsJson from '../../../public/geo/bg-settlements.json';

/**
 * The parcel-overview payload: proximity clusters for a location, ready
 * to draw and to filter by.
 *
 * A location detail page can hold 100+ parcels. Rendering was already
 * solved; FINDABILITY was not. These clusters are what let a farmer see
 * "12 parcels near Драгоево, 8 near X" and click through, instead of
 * scanning a flat list of a hundred names.
 */

/**
 * 7239 settlements, `[name, lon, lat, rank]`. Loaded ONCE at module
 * scope: the file is ~300 KB, the lookup runs server-side, and shipping
 * it to a phone on rural LTE so the client could linear-scan it would
 * defeat the point of clustering at all.
 */
const SETTLEMENTS = settlementsJson as unknown as SettlementRow[];

/**
 * Grid pitch by zoom. Zooming in shrinks the cell so clusters split into
 * their members — the progressive reveal that makes 100+ navigable.
 * Clamped at both ends: below ~200 m every parcel is its own cluster
 * (which is just the list again), above ~20 km the whole holding
 * collapses into one dot (which answers nothing).
 */
export function cellMetresForZoom(zoom: number): number {
    const z = Math.min(14, Math.max(6, Math.round(zoom)));
    // 6 → 20 km, halving per zoom level, floored at 200 m.
    return Math.max(200, 20_000 / 2 ** (z - 6));
}

/**
 * One positioned parcel, as the map draws it.
 *
 * Ids and coordinates ONLY. Name, area and crop are deliberately absent:
 * the location detail page already holds all three for every parcel, so
 * repeating them here would be a second copy that can disagree with the
 * table sitting under the map. The join is by `id`.
 */
export interface OverviewParcelPoint {
    id: string;
    lon: number;
    lat: number;
}

export interface ParcelOverview {
    clusters: ParcelCluster[];
    /**
     * Every positioned parcel, so the view can stop drawing clusters and
     * start drawing PARCELS once it is zoomed in far enough.
     *
     * Without this the progressive reveal has a floor it can never pass:
     * `cellMetresForZoom` bottoms out at 200 m, so two parcels 150 m
     * apart stay merged at any zoom, and a cluster of one is still
     * labelled with a settlement name rather than the parcel's own. The
     * points are already computed for the clustering — serialising them
     * costs one array and removes a whole class of "I zoomed all the way
     * in and it still won't tell me which field that is".
     */
    parcels: OverviewParcelPoint[];
    /** [minLon, minLat, maxLon, maxLat] of the POSITIONED parcels, or null. */
    bbox: BBox | null;
    /** Parcels carrying a position — the ones the map can draw. */
    positionedCount: number;
    /**
     * Parcels with NULL geometry. Explicit, never dropped: a farm with
     * 30 un-geocoded parcels seeing "70 parcels" on a map labelled as
     * its holding is silent data loss, and the farmer has no way to know
     * the map is lying.
     */
    unpositionedCount: number;
    /** Ids of the unpositioned parcels, so the UI can offer a way to reach them. */
    unpositionedParcelIds: string[];
    /** True when the read hit its bound — the view is a subset. */
    truncated: boolean;
}

/** The read bound. Generous: a very large holding still fits in one response. */
export const PARCEL_OVERVIEW_CAP = 2000;

/**
 * Split raw rows into positioned / unpositioned. Exported so the
 * unpositioned-count rule is testable without a database — it is a
 * data-integrity rule, not an I/O detail.
 */
export function splitPositioned(
    rows: ReadonlyArray<{
        id: string;
        name: string;
        key: string | null;
        areaHa: string | null;
        cropType: string | null;
        lon: number | null;
        lat: number | null;
    }>,
): { positioned: PositionedParcel[]; unpositionedIds: string[] } {
    const positioned: PositionedParcel[] = [];
    const unpositionedIds: string[] = [];

    for (const r of rows) {
        // A parcel counts as positioned only with BOTH coordinates and
        // both finite. A NaN slipping through would place a marker at an
        // undrawable point and silently vanish from the map — the same
        // data loss the null case is guarding against, wearing a
        // different hat.
        if (
            r.lon === null || r.lat === null ||
            !Number.isFinite(Number(r.lon)) || !Number.isFinite(Number(r.lat))
        ) {
            unpositionedIds.push(r.id);
            continue;
        }
        positioned.push({
            id: r.id,
            name: r.name,
            key: r.key,
            areaHa: r.areaHa === null ? null : Number(r.areaHa),
            cropType: r.cropType,
            lon: Number(r.lon),
            lat: Number(r.lat),
        });
    }
    return { positioned, unpositionedIds };
}

export async function getParcelOverview(
    ctx: RequestContext,
    locationId: string,
    opts: { zoom?: number } = {},
): Promise<ParcelOverview> {
    assertCanRead(ctx);
    const cellMetres = cellMetresForZoom(opts.zoom ?? 8);

    return runInTenantContext(ctx, async (db) => {
        const rows = await ParcelRepository.listForOverview(
            db,
            ctx,
            locationId,
            PARCEL_OVERVIEW_CAP + 1,
        );
        const truncated = rows.length > PARCEL_OVERVIEW_CAP;
        const bounded = truncated ? rows.slice(0, PARCEL_OVERVIEW_CAP) : rows;

        const { positioned, unpositionedIds } = splitPositioned(bounded);
        const clusters = labelClusters(clusterParcels(positioned, cellMetres), SETTLEMENTS);

        return {
            clusters,
            parcels: positioned.map((p) => ({ id: p.id, lon: p.lon, lat: p.lat })),
            bbox: bboxOf(positioned.map((p) => [p.lon, p.lat] as const)),
            positionedCount: positioned.length,
            unpositionedCount: unpositionedIds.length,
            unpositionedParcelIds: unpositionedIds,
            truncated,
        };
    });
}
