/**
 * Clustering + nearest-settlement arithmetic.
 *
 * These EXECUTE the functions. The structural guards in this roadmap
 * only read source text and prove no consumer re-inlines the
 * projection — per CLAUDE.md's "Green is not the same as executed",
 * they contribute zero runtime coverage, so correctness has to be
 * proven here.
 *
 * The four cases the brief names are the first four describes below:
 * 50 m clusters, 50 km does not, unpositioned parcels are counted
 * separately (tested at the usecase boundary — see
 * `splitPositioned`), and settlement ties break by rank.
 */
import {
    clusterIdFor,
    clusterParcels,
    nearestSettlement,
    labelClusters,
    distanceMetres,
    type PositionedParcel,
    type SettlementRow,
} from '@/lib/geo/parcel-clustering';

const at = (id: string, lon: number, lat: number, areaHa = 1): PositionedParcel => ({
    id, name: `Parcel ${id}`, key: id.toUpperCase(), areaHa, cropType: 'WHEAT', lon, lat,
});

// Дragoevo, Shumen oblast — a real farm neighbourhood.
const BASE_LON = 26.6167;
const BASE_LAT = 43.1833;

/** Offset a point by metres, correcting longitude for latitude. */
function offset(lon: number, lat: number, eastM: number, northM: number): [number, number] {
    const dLat = northM / 111_320;
    const dLon = eastM / (111_320 * Math.cos(lat * (Math.PI / 180)));
    return [lon + dLon, lat + dLat];
}

describe('clusterParcels — proximity, not administrative unit', () => {
    it('clusters two parcels 50 m apart', () => {
        const [lon2, lat2] = offset(BASE_LON, BASE_LAT, 50, 0);
        const clusters = clusterParcels([at('a', BASE_LON, BASE_LAT), at('b', lon2, lat2)], 1000);
        // One cluster holding both — 50 m is well inside a 1 km cell.
        expect(clusters).toHaveLength(1);
        expect(clusters[0].count).toBe(2);
        expect(clusters[0].parcelIds.sort()).toEqual(['a', 'b']);
    });

    it('does NOT cluster two parcels 50 km apart', () => {
        const [lon2, lat2] = offset(BASE_LON, BASE_LAT, 50_000, 0);
        const clusters = clusterParcels([at('a', BASE_LON, BASE_LAT), at('b', lon2, lat2)], 1000);
        expect(clusters).toHaveLength(2);
        for (const c of clusters) expect(c.count).toBe(1);
    });

    it('splits a cluster as the cell shrinks (the zoom mechanism)', () => {
        // 2 km apart: together in a 5 km cell, separate in a 500 m one.
        // This progressive reveal is what makes 100+ parcels navigable.
        const [lon2, lat2] = offset(BASE_LON, BASE_LAT, 2000, 0);
        const parcels = [at('a', BASE_LON, BASE_LAT), at('b', lon2, lat2)];
        expect(clusterParcels(parcels, 5000)).toHaveLength(1);
        expect(clusterParcels(parcels, 500)).toHaveLength(2);
    });

    it('sums areaHa and treats a null area as 0, not NaN', () => {
        const a = at('a', BASE_LON, BASE_LAT, 12.5);
        const b = { ...at('b', BASE_LON, BASE_LAT), areaHa: null };
        const [c] = clusterParcels([a, b], 1000);
        expect(c.totalAreaHa).toBe(12.5);
        expect(Number.isNaN(c.totalAreaHa)).toBe(false);
    });

    it('is deterministic — same input, same cluster ids and order', () => {
        // The cluster id feeds a URL filter, so two users opening the
        // same link must resolve the same members.
        const parcels = [
            at('a', BASE_LON, BASE_LAT),
            at('b', ...offset(BASE_LON, BASE_LAT, 60, 0)),
            at('c', ...offset(BASE_LON, BASE_LAT, 40_000, 0)),
        ];
        const first = clusterParcels(parcels, 1000);
        const second = clusterParcels([...parcels].reverse(), 1000);
        expect(second.map((c) => c.id)).toEqual(first.map((c) => c.id));
        expect(second.map((c) => c.count)).toEqual(first.map((c) => c.count));
    });

    it('returns [] for no parcels', () => {
        expect(clusterParcels([], 1000)).toEqual([]);
    });

    it('corrects longitude for latitude', () => {
        // A degree of longitude at 43°N is ~73% of a degree of latitude.
        // Without the cos correction, an east–west pair would be judged
        // a third further apart than it is and wrongly split.
        const [lonE] = offset(BASE_LON, BASE_LAT, 900, 0);
        const eastWest = clusterParcels([at('a', BASE_LON, BASE_LAT), at('b', lonE, BASE_LAT)], 2000);
        expect(eastWest).toHaveLength(1);
    });
});

describe('clusterIdFor — identity follows MEMBERSHIP, not the grid cell', () => {
    it('gives the same id for the same members in any order', () => {
        expect(clusterIdFor(['a', 'b', 'c'])).toBe(clusterIdFor(['c', 'a', 'b']));
    });

    it('gives a different id for different members', () => {
        expect(clusterIdFor(['a', 'b'])).not.toBe(clusterIdFor(['a', 'c']));
    });

    it('is not fooled by concatenation ambiguity', () => {
        // Without a separator, ['ab','c'] and ['a','bc'] hash identically
        // — two genuinely different clusters sharing a filter value.
        expect(clusterIdFor(['ab', 'c'])).not.toBe(clusterIdFor(['a', 'bc']));
    });

    it('stays URL-sized for a large cluster', () => {
        // Member ids are cuids; joining 300 of them would be kilobytes of
        // query string. The id must stay a short token.
        const many = Array.from({ length: 300 }, (_, i) => `clx${i}abcdefghijklmnop`);
        expect(clusterIdFor(many).length).toBeLessThan(12);
    });

    it('SURVIVES a zoom change when the membership does not change', () => {
        // The bug this replaced: the id used to be the grid cell key, so
        // the same two parcels clustered under a DIFFERENT id at a
        // different pitch — and a shared `?cluster=` link resolved to
        // nothing. Same members must mean the same id at any pitch.
        const parcels = [at('a', BASE_LON, BASE_LAT), at('b', ...offset(BASE_LON, BASE_LAT, 50, 0))];
        const coarse = clusterParcels(parcels, 5000);
        const fine = clusterParcels(parcels, 1000);
        expect(coarse).toHaveLength(1);
        expect(fine).toHaveLength(1);
        expect(fine[0].id).toBe(coarse[0].id);
    });
});

describe('nearestSettlement — ties break by rank', () => {
    // A hamlet marginally closer than the town it sits beside.
    const HAMLET: SettlementRow = ['Малко село', BASE_LON + 0.001, BASE_LAT, 5];
    const TOWN: SettlementRow = ['Драгоево', BASE_LON + 0.010, BASE_LAT, 1];

    it('prefers the higher-rank settlement when both are near', () => {
        // The hamlet is ~800 m closer, but "near Драгоево" is how the
        // land is actually described.
        const found = nearestSettlement(BASE_LON, BASE_LAT, [HAMLET, TOWN]);
        expect(found?.[0]).toBe('Драгоево');
    });

    it('is order-independent', () => {
        expect(nearestSettlement(BASE_LON, BASE_LAT, [TOWN, HAMLET])?.[0]).toBe('Драгоево');
    });

    it('still picks the decisively closer settlement outside the tie band', () => {
        // A high-rank city 60 km away must NOT win over the local hamlet.
        const FAR_CITY: SettlementRow = ['София', BASE_LON - 3, BASE_LAT, 0];
        expect(nearestSettlement(BASE_LON, BASE_LAT, [HAMLET, FAR_CITY])?.[0]).toBe('Малко село');
    });

    it('breaks an equal-rank tie by distance', () => {
        const near: SettlementRow = ['Близко', BASE_LON + 0.001, BASE_LAT, 3];
        const far: SettlementRow = ['Далечно', BASE_LON + 0.020, BASE_LAT, 3];
        expect(nearestSettlement(BASE_LON, BASE_LAT, [far, near])?.[0]).toBe('Близко');
    });

    it('returns null for an empty list rather than inventing a name', () => {
        expect(nearestSettlement(BASE_LON, BASE_LAT, [])).toBeNull();
    });
});

describe('labelClusters', () => {
    it('labels each cluster with its nearest settlement', () => {
        const settlements: SettlementRow[] = [['Драгоево', BASE_LON, BASE_LAT, 1]];
        const labelled = labelClusters(clusterParcels([at('a', BASE_LON, BASE_LAT)], 1000), settlements);
        expect(labelled[0].label).toBe('Драгоево');
    });

    it('leaves the label null when no settlements are supplied', () => {
        const labelled = labelClusters(clusterParcels([at('a', BASE_LON, BASE_LAT)], 1000), []);
        expect(labelled[0].label).toBeNull();
    });
});

describe('distanceMetres', () => {
    it('measures a known north-south offset', () => {
        const [lon, lat] = offset(BASE_LON, BASE_LAT, 0, 1000);
        expect(distanceMetres(BASE_LON, BASE_LAT, lon, lat)).toBeCloseTo(1000, 0);
    });

    it('measures a known east-west offset', () => {
        const [lon, lat] = offset(BASE_LON, BASE_LAT, 1000, 0);
        expect(distanceMetres(BASE_LON, BASE_LAT, lon, lat)).toBeCloseTo(1000, 0);
    });

    it('is symmetric', () => {
        expect(distanceMetres(26.6, 43.1, 26.7, 43.2))
            .toBeCloseTo(distanceMetres(26.7, 43.2, 26.6, 43.1), 6);
    });
});
