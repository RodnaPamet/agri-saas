/**
 * Unit tests for `src/lib/grain/bin-fill.ts` — the shared bin-fill
 * arithmetic behind `listBins`, `getBin` and the org grain summary.
 *
 * The bug this module exists to prevent: summing `quantityOnHand` across
 * lots without regard to each lot's unit, then dividing by a tonnes
 * capacity. A kg-denominated bin reported 1000x its true fill.
 */
import {
    EMPTY_BIN_TOTALS,
    fillFractionFor,
    summariseStoredByBin,
    type StoredGroup,
    type UnitRef,
} from '@/lib/grain/bin-fill';

const T: UnitRef = { id: 'u-t', key: 't', symbol: 't' };
const KG: UnitRef = { id: 'u-kg', key: 'kg', symbol: 'kg' };
const G: UnitRef = { id: 'u-g', key: 'g', symbol: 'g' };
const EACH: UnitRef = { id: 'u-each', key: 'each', symbol: 'ea' };
const LITRE: UnitRef = { id: 'u-l', key: 'l', symbol: 'L' };

function group(over: Partial<StoredGroup> = {}): StoredGroup {
    return { locationId: 'bin-1', unitId: T.id, quantity: 0, lotCount: 1, ...over };
}

describe('summariseStoredByBin — conversion', () => {
    it('converts kg to tonnes exactly', () => {
        const byBin = summariseStoredByBin([group({ unitId: KG.id, quantity: 320, lotCount: 2 })], [KG]);
        expect(byBin.get('bin-1')).toEqual({
            storedTonnes: 0.32,
            lotCount: 2,
            mixedUnits: false,
            unconvertible: [],
        });
    });

    it('converts grams to tonnes exactly (no float drift)', () => {
        const byBin = summariseStoredByBin([group({ unitId: G.id, quantity: 2_500_000 })], [G]);
        expect(byBin.get('bin-1')!.storedTonnes).toBe(2.5);
    });

    it('sums several WEIGHT units into one tonnage', () => {
        const byBin = summariseStoredByBin(
            [
                group({ unitId: T.id, quantity: 2, lotCount: 1 }),
                group({ unitId: KG.id, quantity: 500, lotCount: 3 }),
                group({ unitId: G.id, quantity: 250_000, lotCount: 1 }),
            ],
            [T, KG, G],
        );
        // 2 t + 0.5 t + 0.25 t
        expect(byBin.get('bin-1')).toMatchObject({ storedTonnes: 2.75, lotCount: 5, mixedUnits: false });
    });

    it('keeps bins separate', () => {
        const byBin = summariseStoredByBin(
            [
                group({ locationId: 'bin-1', unitId: KG.id, quantity: 1000 }),
                group({ locationId: 'bin-2', unitId: T.id, quantity: 7 }),
            ],
            [T, KG],
        );
        expect(byBin.get('bin-1')!.storedTonnes).toBe(1);
        expect(byBin.get('bin-2')!.storedTonnes).toBe(7);
    });
});

describe('summariseStoredByBin — stock with no tonnage', () => {
    it('reports COUNT stock separately and flags the bin', () => {
        const byBin = summariseStoredByBin(
            [
                group({ unitId: T.id, quantity: 40, lotCount: 1 }),
                group({ unitId: EACH.id, quantity: 12, lotCount: 2 }),
            ],
            [T, EACH],
        );
        expect(byBin.get('bin-1')).toEqual({
            storedTonnes: 40,
            lotCount: 3, // unconvertible lots still COUNT as lots
            mixedUnits: true,
            unconvertible: [{ unitKey: 'each', symbol: 'ea', quantity: 12, lotCount: 2 }],
        });
    });

    it('does not silently drop stock whose unit row is missing', () => {
        // A unitId with no matching Unit row must surface as unconvertible —
        // dropping it is how the original bug read as plausible.
        const byBin = summariseStoredByBin([group({ unitId: 'u-ghost', quantity: 5 })], []);
        expect(byBin.get('bin-1')).toMatchObject({
            storedTonnes: 0,
            mixedUnits: true,
            unconvertible: [{ unitKey: 'u-ghost', symbol: 'u-ghost', quantity: 5, lotCount: 1 }],
        });
    });

    it('merges repeated unconvertible units and sorts the breakdown', () => {
        const byBin = summariseStoredByBin(
            [
                group({ unitId: LITRE.id, quantity: 10, lotCount: 1 }),
                group({ unitId: EACH.id, quantity: 3, lotCount: 1 }),
                group({ unitId: LITRE.id, quantity: 5, lotCount: 2 }),
            ],
            [LITRE, EACH],
        );
        expect(byBin.get('bin-1')!.unconvertible).toEqual([
            { unitKey: 'each', symbol: 'ea', quantity: 3, lotCount: 1 },
            { unitKey: 'l', symbol: 'L', quantity: 15, lotCount: 3 },
        ]);
    });

    it('skips groups with no bin (unassigned stock belongs to no bin)', () => {
        const byBin = summariseStoredByBin([group({ locationId: null, quantity: 99 })], [T]);
        expect(byBin.size).toBe(0);
    });

    it('returns an empty map for no groups', () => {
        expect(summariseStoredByBin([], [T]).size).toBe(0);
    });
});

describe('fillFractionFor', () => {
    it('divides tonnes by capacity', () => {
        expect(fillFractionFor(45, 100, false)).toBe(0.45);
    });

    it('reports the true fraction above 100% rather than clamping', () => {
        expect(fillFractionFor(140, 100, false)).toBe(1.4);
    });

    it('is null without a capacity (the divide-by-zero guard)', () => {
        expect(fillFractionFor(10, null, false)).toBeNull();
        expect(fillFractionFor(10, 0, false)).toBeNull();
        expect(fillFractionFor(10, -5, false)).toBeNull();
    });

    it('is null when the bin holds stock with no tonnage', () => {
        // A percentage computed from only part of the contents is the same
        // class of lie as the 1000x error.
        expect(fillFractionFor(40, 100, true)).toBeNull();
    });

    it('EMPTY_BIN_TOTALS is a usable zero', () => {
        expect(EMPTY_BIN_TOTALS).toEqual({
            storedTonnes: 0,
            lotCount: 0,
            mixedUnits: false,
            unconvertible: [],
        });
        expect(fillFractionFor(EMPTY_BIN_TOTALS.storedTonnes, 100, EMPTY_BIN_TOTALS.mixedUnits)).toBe(0);
    });
});
