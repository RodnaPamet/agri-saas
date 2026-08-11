/**
 * Proximity clustering for the parcel-overview map, and the
 * nearest-settlement labelling that makes a cluster nameable.
 *
 * WHY PROXIMITY AND NOT OBLAST. The marketplace map aggregates by
 * administrative region, and that is right there: offers are spread
 * across the country. A single farm is not. Essentially every parcel of
 * one holding sits inside ONE oblast, so an oblast choropleth would
 * draw one shape containing everything and answer no question at all.
 * What a farmer actually asks is "which of my plots are near each
 * other" — that is distance, not administration.
 *
 * WHY THE LABEL IS A SETTLEMENT. "Cluster 3" means nothing. Bulgarian
 * operators locate land by the nearest village or town — "нивата до
 * Драгоево" — so each cluster is named for the settlement closest to
 * it. The lookup runs SERVER-side: `bg-settlements.json` is 7239
 * entries, and shipping it to a phone on rural LTE so the client can
 * do a linear scan would be absurd.
 *
 * Everything here is PURE: no Prisma, no fetch, no DOM. That is what
 * lets the arithmetic be tested without a database, which matters
 * because the correctness that counts (does 50m cluster, does 50km not,
 * do ties break by rank) is arithmetic, not I/O.
 */

/** One parcel that HAS a position. Unpositioned ones never reach here. */
export interface PositionedParcel {
    id: string;
    name: string;
    key: string | null;
    areaHa: number | null;
    cropType: string | null;
    lon: number;
    lat: number;
}

export interface ParcelCluster {
    /** Stable within one response — derived from the grid cell. */
    id: string;
    /** Mean position of the members, in lon/lat. */
    lon: number;
    lat: number;
    count: number;
    parcelIds: string[];
    /** Sum of member `areaHa`; null members contribute 0. */
    totalAreaHa: number;
    /** Nearest settlement name, or null when no settlement list was supplied. */
    label: string | null;
}

/**
 * A settlement row from `public/geo/bg-settlements.json`:
 * `[name, lon, lat, rank]`, where a LOWER rank is more significant
 * (0 = capital).
 */
export type SettlementRow = readonly [name: string, lon: number, lat: number, rank: number];

/**
 * Metres per degree of latitude. Longitude degrees shrink with
 * cos(latitude), which is corrected below — at Bulgaria's ~43°N a
 * degree of longitude is about 73% of a degree of latitude, so ignoring
 * it would stretch every east–west distance by a third and merge
 * clusters that are not actually close.
 */
const M_PER_DEG_LAT = 111_320;

/** Great-circle-ish distance in metres. Equirectangular — exact enough
 *  at farm scale, and far cheaper than haversine for a 7239-row scan. */
export function distanceMetres(
    aLon: number, aLat: number,
    bLon: number, bLat: number,
): number {
    const midLatRad = ((aLat + bLat) / 2) * (Math.PI / 180);
    const dx = (bLon - aLon) * Math.cos(midLatRad) * M_PER_DEG_LAT;
    const dy = (bLat - aLat) * M_PER_DEG_LAT;
    return Math.hypot(dx, dy);
}

/**
 * Grid-snap parcels into proximity clusters.
 *
 * `cellMetres` is the grid pitch: parcels landing in the same cell
 * cluster together. Callers derive it from the requested zoom, so
 * zooming in shrinks the cell and clusters split apart — that
 * progressive reveal is the mechanism that makes 100+ parcels
 * navigable.
 *
 * Grid-snapping rather than agglomerative clustering: it is O(n), it is
 * deterministic (no seed, no iteration order dependence, so the same
 * input always yields the same clusters — which matters because the
 * cluster id feeds a URL filter), and at farm scale the quality
 * difference is invisible.
 *
 * The known trade-off: two parcels either side of a cell boundary stay
 * separate even if metres apart. Accepted deliberately — the
 * alternative is non-deterministic cluster identity, which would make a
 * shared filter link resolve differently for two users.
 */
export function clusterParcels(
    parcels: readonly PositionedParcel[],
    cellMetres: number,
): ParcelCluster[] {
    if (parcels.length === 0) return [];

    // Degree pitch, corrected for longitude convergence at this latitude.
    const meanLat = parcels.reduce((s, p) => s + p.lat, 0) / parcels.length;
    const cosLat = Math.max(0.1, Math.cos(meanLat * (Math.PI / 180)));
    const latPitch = cellMetres / M_PER_DEG_LAT;
    const lonPitch = cellMetres / (M_PER_DEG_LAT * cosLat);

    const buckets = new Map<string, PositionedParcel[]>();
    for (const p of parcels) {
        const gx = Math.floor(p.lon / lonPitch);
        const gy = Math.floor(p.lat / latPitch);
        const key = `${gx}:${gy}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(p);
        else buckets.set(key, [p]);
    }

    const clusters: ParcelCluster[] = [];
    for (const [key, members] of buckets) {
        const lon = members.reduce((s, m) => s + m.lon, 0) / members.length;
        const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
        clusters.push({
            id: `c${key}`,
            lon,
            lat,
            count: members.length,
            parcelIds: members.map((m) => m.id),
            totalAreaHa: members.reduce((s, m) => s + (m.areaHa ?? 0), 0),
            label: null,
        });
    }

    // Deterministic order — biggest first, then by id so equal-sized
    // clusters never reorder between requests.
    clusters.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    return clusters;
}

/**
 * The settlement nearest to a point.
 *
 * TIES BREAK BY RANK, and that is the whole subtlety: a hamlet 200 m
 * closer than the town should not win the label, because "near
 * Драгоево" is how the land is actually described. `rankTolerance`
 * widens "tie" from exact-equality to a radius, so a materially more
 * significant settlement wins within it.
 *
 * Returns null for an empty list rather than inventing a name.
 */
export function nearestSettlement(
    lon: number,
    lat: number,
    settlements: readonly SettlementRow[],
    options: { rankToleranceMetres?: number } = {},
): SettlementRow | null {
    if (settlements.length === 0) return null;
    const tolerance = options.rankToleranceMetres ?? 3000;

    let best: SettlementRow | null = null;
    let bestDist = Infinity;

    for (const s of settlements) {
        const d = distanceMetres(lon, lat, s[1], s[2]);
        if (best === null || d < bestDist - tolerance) {
            // Decisively closer — wins outright.
            best = s;
            bestDist = d;
            continue;
        }
        if (d <= bestDist + tolerance) {
            // Within the tie band: prefer the MORE significant settlement
            // (lower rank). On equal rank, prefer the genuinely closer.
            const better = s[3] < best[3] || (s[3] === best[3] && d < bestDist);
            if (better) {
                best = s;
                bestDist = Math.min(bestDist, d);
            }
        }
    }
    return best;
}

/** Attach a nearest-settlement label to each cluster. */
export function labelClusters(
    clusters: readonly ParcelCluster[],
    settlements: readonly SettlementRow[],
): ParcelCluster[] {
    return clusters.map((c) => ({
        ...c,
        label: nearestSettlement(c.lon, c.lat, settlements)?.[0] ?? null,
    }));
}
