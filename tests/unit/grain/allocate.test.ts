/**
 * Allocation conserves the amount. That is the whole contract.
 *
 * ── Why this is the dangerous part ──────────────────────────────────
 *
 * Choosing a different basis REDISTRIBUTES a cost. It must never change
 * it. The obvious implementation — multiply the amount by each weight and
 * round each share to the cent — silently violates that: 100.00 across
 * three equal parcels gives 33.33 three times, and the farm total is
 * 99.99. A cost that shrinks when you look at it differently is worse
 * than no allocation feature at all, because every downstream figure
 * (cash cost, net worth, margin per decare) inherits the error and none
 * of them can tell you where it came from.
 *
 * So shares are computed in integer cents at full precision and the
 * remainder is handed out by the largest-remainder rule, deterministically
 * ordered, until the pennies are gone.
 */
import { allocateByWeights, computeAreaWeights } from '@/lib/grain/allocate';

/** Sum to the cent, immune to float addition order. */
const sumCents = (shares: Map<string, number>) =>
    Math.round([...shares.values()].reduce((s, v) => s + v, 0) * 100);

describe('allocateByWeights', () => {
    describe('conservation — the sum is the amount, always', () => {
        it('loses no cent on the classic three-way split', () => {
            // Naive per-share rounding gives 33.33 × 3 = 99.99.
            const weights = new Map([
                ['a', 1 / 3],
                ['b', 1 / 3],
                ['c', 1 / 3],
            ]);
            const shares = allocateByWeights(100, weights);

            expect(sumCents(shares)).toBe(10_000);
            expect([...shares.values()].sort()).toEqual([33.33, 33.33, 33.34]);
        });

        it('conserves across a long tail of awkward weights', () => {
            for (const amount of [100, 0.01, 999.99, 1_234.56, 7, 0.03]) {
                for (const n of [1, 2, 3, 7, 11, 97]) {
                    const weights = new Map(
                        Array.from({ length: n }, (_, i) => [`p${i}`, 1 / n] as const),
                    );
                    const shares = allocateByWeights(amount, weights);
                    expect({ amount, n, cents: sumCents(shares) }).toEqual({
                        amount,
                        n,
                        cents: Math.round(amount * 100),
                    });
                }
            }
        });

        it('conserves with lopsided weights, not just equal ones', () => {
            const weights = new Map([
                ['big', 0.9999],
                ['tiny', 0.0001],
            ]);
            expect(sumCents(allocateByWeights(1_000.01, weights))).toBe(100_001);
        });

        it('conserves a negative amount without inverting the split', () => {
            // Costs are entered positive, but a correction can be negative
            // and must not silently become a different magnitude.
            const weights = new Map([
                ['a', 1 / 3],
                ['b', 2 / 3],
            ]);
            const shares = allocateByWeights(-100, weights);
            expect(sumCents(shares)).toBe(-10_000);
            expect(shares.get('b')).toBeLessThan(0);
        });
    });

    describe('the remainder lands somewhere defensible', () => {
        it('gives the odd cent to the largest true share, not to whoever iterates first', () => {
            const weights = new Map([
                ['small', 0.2],
                ['large', 0.8],
            ]);
            // 10.01 → 200.2 and 800.8 cents. Floors 200 + 800 = 1000, one
            // cent short; the larger fractional part is `large`.
            const shares = allocateByWeights(10.01, weights);
            expect(shares.get('large')).toBe(8.01);
            expect(shares.get('small')).toBe(2.0);
        });

        it('breaks an exact tie by id, so the result cannot depend on Map order', () => {
            // Same weights inserted in opposite orders must allocate
            // identically — otherwise a refactor that reorders a query
            // changes a farmer's numbers.
            const forward = allocateByWeights(100, new Map([['a', 1 / 3], ['b', 1 / 3], ['c', 1 / 3]]));
            const backward = allocateByWeights(100, new Map([['c', 1 / 3], ['b', 1 / 3], ['a', 1 / 3]]));
            expect([...forward.entries()].sort()).toEqual([...backward.entries()].sort());
            expect(forward.get('a')).toBe(backward.get('a'));
        });
    });

    describe('degenerate input is refused, not fudged', () => {
        it('allocates nothing when there are no targets', () => {
            expect(allocateByWeights(100, new Map()).size).toBe(0);
        });

        it('gives the whole amount to a single target', () => {
            expect(allocateByWeights(100, new Map([['only', 1]])).get('only')).toBe(100);
        });

        it('allocates zero as zero, to every target', () => {
            const shares = allocateByWeights(0, new Map([['a', 0.5], ['b', 0.5]]));
            expect([...shares.values()]).toEqual([0, 0]);
        });

        it('never emits NaN, whatever the weights', () => {
            const shares = allocateByWeights(50, new Map([['a', Number.NaN], ['b', 1]]));
            for (const v of shares.values()) expect(Number.isFinite(v)).toBe(true);
            expect(sumCents(shares)).toBe(5_000);
        });
    });
});

describe('computeAreaWeights', () => {
    // Moved out of grain-net-worth.ts unchanged so allocation has ONE
    // weighting rule. These lock the behaviour the usecase already relied on.

    it('weights pro rata by area', () => {
        const w = computeAreaWeights([
            { id: 'a', areaHa: 30 },
            { id: 'b', areaHa: 10 },
        ]);
        expect(w.get('a')).toBeCloseTo(0.75, 10);
        expect(w.get('b')).toBeCloseTo(0.25, 10);
    });

    it('falls back to an even split when no target has area', () => {
        // A holding whose parcels all have null area must still allocate.
        // Dropping the cost would be the silent failure.
        const w = computeAreaWeights([
            { id: 'a', areaHa: 0 },
            { id: 'b', areaHa: 0 },
        ]);
        expect(w.get('a')).toBe(0.5);
        expect(w.get('b')).toBe(0.5);
    });

    it('treats a negative area as no area rather than a negative weight', () => {
        const w = computeAreaWeights([
            { id: 'a', areaHa: -5 },
            { id: 'b', areaHa: 15 },
        ]);
        expect(w.get('a')).toBe(0);
        expect(w.get('b')).toBe(1);
    });

    it('returns nothing for no targets', () => {
        expect(computeAreaWeights([]).size).toBe(0);
    });

    it('composes with allocateByWeights to conserve on a zero-area holding', () => {
        // The two halves of the brief's requirement, together: even split
        // AND exact conservation.
        const w = computeAreaWeights([
            { id: 'a', areaHa: 0 },
            { id: 'b', areaHa: 0 },
            { id: 'c', areaHa: 0 },
        ]);
        expect(sumCents(allocateByWeights(100, w))).toBe(10_000);
    });
});
