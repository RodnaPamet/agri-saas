/**
 * The unpositioned-parcel rule, and the zoom→cell mapping.
 *
 * `splitPositioned` is exported precisely so this can be tested without
 * a database: whether a NULL-geometry parcel is COUNTED or DROPPED is a
 * data-integrity rule, not an I/O detail. A farm with 30 un-geocoded
 * parcels seeing "70 parcels" on a map labelled as its holding has been
 * silently lied to, and has no way to notice.
 */
import {
    splitPositioned,
    cellMetresForZoom,
    PARCEL_OVERVIEW_CAP,
} from '@/app-layer/usecases/parcel-overview';

const row = (
    id: string,
    lon: number | null,
    lat: number | null,
    areaHa: string | null = '1.5',
) => ({ id, name: `Parcel ${id}`, key: id.toUpperCase(), areaHa, cropType: 'WHEAT', lon, lat });

describe('splitPositioned — NULL geometry is counted, never dropped', () => {
    it('routes a null-geometry parcel into the unpositioned list', () => {
        const { positioned, unpositionedIds } = splitPositioned([
            row('a', 26.6, 43.1),
            row('b', null, null),
        ]);
        expect(positioned.map((p) => p.id)).toEqual(['a']);
        expect(unpositionedIds).toEqual(['b']);
    });

    it('never loses a parcel — every row lands in exactly one bucket', () => {
        // The invariant that makes the count trustworthy.
        const rows = [
            row('a', 26.6, 43.1),
            row('b', null, null),
            row('c', 26.7, 43.2),
            row('d', null, 43.3),
            row('e', 26.9, null),
        ];
        const { positioned, unpositionedIds } = splitPositioned(rows);
        expect(positioned.length + unpositionedIds.length).toBe(rows.length);
        expect([...positioned.map((p) => p.id), ...unpositionedIds].sort())
            .toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('treats a HALF-null coordinate as unpositioned', () => {
        // lon without lat cannot be drawn; counting it as positioned
        // would put it in the cluster maths as NaN.
        const { positioned, unpositionedIds } = splitPositioned([row('a', 26.6, null)]);
        expect(positioned).toHaveLength(0);
        expect(unpositionedIds).toEqual(['a']);
    });

    it('treats a NON-FINITE coordinate as unpositioned', () => {
        // A NaN slipping through would place a marker at an undrawable
        // point and vanish from the map — the same data loss as a null,
        // wearing a different hat.
        const { positioned, unpositionedIds } = splitPositioned([
            { ...row('a', 26.6, 43.1), lon: NaN },
            { ...row('b', 26.6, 43.1), lat: Infinity },
        ]);
        expect(positioned).toHaveLength(0);
        expect(unpositionedIds.sort()).toEqual(['a', 'b']);
    });

    it('coerces the decimal areaHa string to a number', () => {
        // Postgres numerics arrive as strings; leaving them would make
        // totalAreaHa a concatenation instead of a sum.
        const { positioned } = splitPositioned([row('a', 26.6, 43.1, '12.75')]);
        expect(positioned[0].areaHa).toBe(12.75);
    });

    it('keeps a null areaHa null rather than coercing to 0', () => {
        // "Area unknown" and "area is zero hectares" are different facts.
        const { positioned } = splitPositioned([row('a', 26.6, 43.1, null)]);
        expect(positioned[0].areaHa).toBeNull();
    });

    it('handles an empty set', () => {
        expect(splitPositioned([])).toEqual({ positioned: [], unpositionedIds: [] });
    });
});

describe('cellMetresForZoom', () => {
    it('shrinks the cell as zoom increases (clusters split)', () => {
        expect(cellMetresForZoom(7)).toBeLessThan(cellMetresForZoom(6));
        expect(cellMetresForZoom(10)).toBeLessThan(cellMetresForZoom(8));
    });

    it('clamps both ends', () => {
        // Below the floor every parcel is its own cluster — that is just
        // the list again. Above the ceiling the whole holding collapses
        // to one dot, which answers nothing.
        expect(cellMetresForZoom(-5)).toBe(cellMetresForZoom(6));
        expect(cellMetresForZoom(99)).toBe(cellMetresForZoom(14));
        expect(cellMetresForZoom(99)).toBeGreaterThanOrEqual(200);
    });

    it('never returns 0 or a negative pitch', () => {
        // A zero pitch divides by zero in the grid maths.
        for (const z of [-100, 0, 1, 6, 14, 20, 1000]) {
            expect(cellMetresForZoom(z)).toBeGreaterThan(0);
        }
    });
});

describe('PARCEL_OVERVIEW_CAP', () => {
    it('is a positive bound', () => {
        expect(PARCEL_OVERVIEW_CAP).toBeGreaterThan(0);
    });
});
