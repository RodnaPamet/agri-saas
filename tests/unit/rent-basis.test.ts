/**
 * Unit tests for `src/lib/grain/rent-basis.ts` — resolving `ParcelLease`
 * rent to a comparable annual per-hectare figure.
 *
 * Money (€/дка) and produce (кг/дка) are different DIMENSIONS — a
 * currency and a mass — so every branch below is checked for both the
 * resolved shape (`kind` + the matching field) AND the honest refusal
 * shape (`resolved: false` + a reason naming the raw unit text).
 *
 * `лв/дка` is a THIRD outcome since #2793 and has its own block at the
 * bottom: recognised, money, and refused. Every case that is about something
 * else — area independence, the `kind` narrowing, a genuine zero, `rentUnit`
 * precedence — was moved onto `€/дка` in that change, and NOT because lev
 * looked untidy there. Two of them would have gone vacuous on it: comparing
 * two lev results for area independence compares two identical refusals, and
 * a zero-rent case asserting `resolved: false` would have stopped saying
 * anything about zero at all.
 */
import { resolveRentBasis, type RentBasisResult } from '@/lib/grain/rent-basis';
import { RENT_UNIT_EUR, RENT_UNIT_KG, RENT_UNIT_LEVA } from '@/lib/agro/rent-units';
import { DCA_PER_HA } from '@/lib/agro/rate-calc';

describe('resolveRentBasis — money per decare, reported in EURO', () => {
    /*
     * Owner ruling 2026-10-31: money rent is reported in euro. `€/дка` passes
     * through, and it is now the ONLY money unit that resolves — #2793 removed
     * the fixed peg that converted `лв/дка` (owner ruling 2026-11-08, with 0
     * leases in production), so a lev lease is refused instead.
     *
     * These expectations have changed TWICE and in opposite directions: they
     * asserted an un-converted lev figure, then a peg division, and now a
     * per-decare euro rate that needs no rate at all. The arithmetic here is
     * `× DCA_PER_HA` and nothing else — if a future reader finds a division in
     * this block, something has reintroduced a conversion.
     */
    it('a €/дка lease passes through unconverted', () => {
        const result = resolveRentBasis({ rentAmount: 40, rentUnit: '€/дка' }, 3);
        expect(result).toEqual({ resolved: true, kind: 'money', perHa: 40 * DCA_PER_HA, currency: 'EUR' });
    });

    it('a €/дка alias (eur/dka) resolves the same way', () => {
        const result = resolveRentBasis({ rentAmount: 40, rentUnitRaw: 'eur/dka' }, 3);
        expect(result).toEqual({ resolved: true, kind: 'money', perHa: 400, currency: 'EUR' });
    });

    it('resolves a canonical rentUnit to a money per-hectare figure', () => {
        const result = resolveRentBasis({ rentAmount: 80, rentUnit: RENT_UNIT_EUR }, 5);
        // 80 €/дка = 800 €/ha. A pure unit conversion, no rate involved.
        expect(result).toEqual({
            resolved: true,
            kind: 'money',
            perHa: 80 * DCA_PER_HA,
            currency: 'EUR',
        });
    });

    it('resolves a raw alias (eur/dka) via rentUnitRaw when rentUnit is absent', () => {
        const result = resolveRentBasis({ rentAmount: 50, rentUnitRaw: 'eur / dka' }, 3.2);
        expect(result).toEqual({
            resolved: true,
            kind: 'money',
            perHa: 500,
            currency: 'EUR',
        });
    });

    it('is area-INDEPENDENT once resolved — a per-decare rate scales, it does not accumulate', () => {
        const small = resolveRentBasis({ rentAmount: 80, rentUnit: RENT_UNIT_EUR }, 1);
        const large = resolveRentBasis({ rentAmount: 80, rentUnit: RENT_UNIT_EUR }, 500);
        expect(small).toEqual(large);
        // The control the comparison needs: two RESULTS, not two refusals.
        // `toEqual` is satisfied by any two identical values, and on `лв/дка`
        // both sides are now the same `resolved: false` object — which would
        // pass while proving nothing about scaling.
        expect(small.resolved).toBe(true);
    });
});

describe('resolveRentBasis — лв/дка is money, and is REFUSED (#2793)', () => {
    /*
     * The behaviour this phase added. It is a refusal and not a conversion
     * because the fixed 1.95583 peg was removed: passing a lev rate through
     * the money arm would report 500 лв/ha as 500 €/ha, and the arm's own
     * `currency: 'EUR'` label would assert that was already euro. A caller
     * cannot detect that; it can detect `resolved: false`.
     */
    it('refuses the canonical лв/дка rather than converting or relabelling it', () => {
        const result = resolveRentBasis({ rentAmount: 80, rentUnit: RENT_UNIT_LEVA }, 5);
        expect(result.resolved).toBe(false);
        if (result.resolved) throw new Error('expected unresolved');
        expect(result.raw).toBe(RENT_UNIT_LEVA);
        // The reason has to name BGN and point at the unit to use. A reason
        // that only said "unresolved" would leave the operator with a lease
        // silently absent from every cost figure and nothing to act on.
        expect(result.reason).toMatch(/BGN/);
        expect(result.reason).toContain(RENT_UNIT_EUR);
    });

    it('refuses a raw lev alias (lv/dka) the same way, naming what was typed', () => {
        const result = resolveRentBasis({ rentAmount: 50, rentUnitRaw: 'lv/dka' }, 3.2);
        expect(result.resolved).toBe(false);
        if (result.resolved) throw new Error('expected unresolved');
        // `raw` is the operator's own text, not the canonical form — the same
        // contract every other refusal in this module honours.
        expect(result.raw).toBe('lv/dka');
        expect(result.reason).toMatch(/BGN/);
    });

    it('refuses it as a MONEY unit, not as an unrecognised one', () => {
        // The distinction that makes this worth a block of its own, and the
        // control on the whole change. лв/дка is still in the canonical set
        // (see `rent-units.ts`), so it must NOT fall into the arm for a unit
        // nothing recognises — whose reason says the figure "may be a
        // per-hectare or absolute-per-parcel figure", which is false of a
        // per-decare lev rate and would send a reader to parse the text.
        const lev = resolveRentBasis({ rentAmount: 80, rentUnit: RENT_UNIT_LEVA }, 5);
        const nonsense = resolveRentBasis({ rentAmount: 80, rentUnitRaw: 'за целия имот' }, 5);
        if (lev.resolved || nonsense.resolved) throw new Error('expected both unresolved');
        expect(nonsense.reason).toMatch(/per-hectare or absolute-per-parcel/);
        expect(lev.reason).not.toMatch(/per-hectare or absolute-per-parcel/);
        // Both refuse, and they refuse for DIFFERENT stated reasons. Asserting
        // only `resolved: false` on each would pass with the two collapsed.
        expect(lev.reason).not.toBe(nonsense.reason);
    });

    it('answers the amount and area questions FIRST, so the lev reason is not misreported', () => {
        // Order matters for the message, not for the verdict. A lev lease with
        // no amount recorded is unpriced before it is un-convertible, and
        // telling the operator to re-enter it in euro would be advice they
        // cannot act on until they enter a figure at all.
        const noAmount = resolveRentBasis({ rentAmount: null, rentUnit: RENT_UNIT_LEVA }, 5);
        const noArea = resolveRentBasis({ rentAmount: 80, rentUnit: RENT_UNIT_LEVA }, null);
        if (noAmount.resolved || noArea.resolved) throw new Error('expected both unresolved');
        expect(noAmount.reason).toMatch(/amount/i);
        expect(noArea.reason).toMatch(/area/i);
        for (const r of [noAmount, noArea]) expect(r.reason).not.toMatch(/BGN/);
    });
});

describe('resolveRentBasis — produce per decare (кг/дка)', () => {
    it('resolves a canonical rentUnit to a produce (kg) per-hectare figure', () => {
        const result = resolveRentBasis({ rentAmount: 25, rentUnit: RENT_UNIT_KG }, 4);
        expect(result).toEqual({ resolved: true, kind: 'produce', kgPerHa: 25 * DCA_PER_HA });
    });

    it('resolves a Cyrillic alias (килограма/дка) via rentUnitRaw', () => {
        const result = resolveRentBasis({ rentAmount: 30, rentUnitRaw: 'килограма/дка' }, 2);
        expect(result).toEqual({ resolved: true, kind: 'produce', kgPerHa: 300 });
    });
});

describe('resolveRentBasis — money and produce are NOT interchangeable', () => {
    it('carries the dimension in the field name, not just the number', () => {
        const money = resolveRentBasis({ rentAmount: 10, rentUnit: RENT_UNIT_EUR }, 1);
        const produce = resolveRentBasis({ rentAmount: 10, rentUnit: RENT_UNIT_KG }, 1);

        if (!money.resolved || !produce.resolved) throw new Error('expected both to resolve');
        expect(money.kind).toBe('money');
        expect(produce.kind).toBe('produce');

        // Same magnitude (both 10 * DCA_PER_HA), but the shape differs —
        // a caller cannot read the wrong field even though the numbers
        // happen to line up here.
        expect('perHa' in money).toBe(true);
        expect('kgPerHa' in money).toBe(false);
        expect('kgPerHa' in produce).toBe(true);
        expect('perHa' in produce).toBe(false);

        // Compile-time proof: inside the narrowed 'money' branch,
        // `kgPerHa` does not exist on the type at all. This line only
        // type-checks BECAUSE of the @ts-expect-error — remove the money/
        // produce split and `tsc --noEmit` fails the build.
        if (money.kind === 'money') {
            // @ts-expect-error — 'kgPerHa' does not exist on the 'money' branch of RentBasisResult
            const illegalRead = money.kgPerHa;
            expect(illegalRead).toBeUndefined();
        }
    });

    it('refuses to compile a caller that sums money and produce without a kind check', () => {
        // A same-kind combiner that a caller might reasonably write. It
        // must not compile without checking `kind` first.
        function combineSameKind(a: RentBasisResult, b: RentBasisResult): number {
            if (!a.resolved || !b.resolved) throw new Error('unresolved');
            // Each conjunct narrows its OWN variable — `a.kind !== b.kind`
            // alone wouldn't let TypeScript carry a's narrowing over to b.
            if (a.kind === 'money' && b.kind === 'money') return a.perHa + b.perHa;
            if (a.kind === 'produce' && b.kind === 'produce') return a.kgPerHa + b.kgPerHa;
            throw new Error('cannot combine money and produce — different dimensions');
        }

        const money = resolveRentBasis({ rentAmount: 10, rentUnit: RENT_UNIT_EUR }, 1);
        const produce = resolveRentBasis({ rentAmount: 10, rentUnit: RENT_UNIT_KG }, 1);
        expect(() => combineSameKind(money, produce)).toThrow(/cannot combine/);

        const moneyToo = resolveRentBasis({ rentAmount: 20, rentUnit: RENT_UNIT_EUR }, 1);
        // The point of the test is the TYPE narrowing, not the arithmetic —
        // but the numbers have to be right or it would pass for the wrong
        // reason, and `combineSameKind` throwing on two refusals would read
        // as the money/produce guard firing.
        expect(combineSameKind(money, moneyToo)).toBeCloseTo(
            10 * DCA_PER_HA + 20 * DCA_PER_HA,
            10,
        );
    });
});

describe('resolveRentBasis — zero rent is a real value, not an unresolved unit', () => {
    it('resolves a genuine zero rentAmount to perHa: 0, distinct from resolved: false', () => {
        const result = resolveRentBasis({ rentAmount: 0, rentUnit: RENT_UNIT_EUR }, 2);
        expect(result).toEqual({ resolved: true, kind: 'money', perHa: 0, currency: 'EUR' });
        expect(result.resolved).toBe(true);
    });

    it('a null rentAmount is unresolved, not zero', () => {
        const result = resolveRentBasis({ rentAmount: null, rentUnit: RENT_UNIT_EUR }, 2);
        expect(result.resolved).toBe(false);
        if (result.resolved) throw new Error('expected unresolved');
        expect(result.reason).toMatch(/amount/i);
    });
});

describe('resolveRentBasis — null / missing amount', () => {
    it('reports unresolved when rentAmount is undefined', () => {
        const result = resolveRentBasis({ rentAmount: undefined, rentUnit: RENT_UNIT_KG }, 2);
        expect(result).toEqual({
            resolved: false,
            raw: RENT_UNIT_KG,
            reason: 'Rent amount is not set for this lease.',
        });
    });

    it('reports unresolved for a non-finite rentAmount', () => {
        const result = resolveRentBasis({ rentAmount: Number.NaN, rentUnit: RENT_UNIT_LEVA }, 2);
        expect(result.resolved).toBe(false);
    });
});

describe('resolveRentBasis — null / invalid parcel area', () => {
    it('reports unresolved when areaHa is null', () => {
        const result = resolveRentBasis({ rentAmount: 80, rentUnit: RENT_UNIT_LEVA }, null);
        expect(result).toEqual({
            resolved: false,
            raw: RENT_UNIT_LEVA,
            reason: 'Parcel area is unknown or non-positive, so no per-hectare figure can be stated.',
        });
    });

    it('reports unresolved when areaHa is undefined', () => {
        const result = resolveRentBasis({ rentAmount: 80, rentUnit: RENT_UNIT_LEVA }, undefined);
        expect(result.resolved).toBe(false);
    });

    it('reports unresolved when areaHa is zero', () => {
        const result = resolveRentBasis({ rentAmount: 80, rentUnit: RENT_UNIT_LEVA }, 0);
        expect(result.resolved).toBe(false);
    });

    it('reports unresolved when areaHa is negative', () => {
        const result = resolveRentBasis({ rentAmount: 80, rentUnit: RENT_UNIT_LEVA }, -3);
        expect(result.resolved).toBe(false);
    });
});

describe('resolveRentBasis — raw unit forms the canonical set rejects', () => {
    it('reports a per-hectare raw form (лв/ха) as unresolved, naming the raw text', () => {
        const result = resolveRentBasis({ rentAmount: 800, rentUnitRaw: 'лв/ха' }, 5);
        expect(result.resolved).toBe(false);
        if (result.resolved) throw new Error('expected unresolved');
        expect(result.raw).toBe('лв/ха');
        expect(result.reason).toContain('лв/ха');
    });

    it('reports an absolute-per-parcel raw form (flat total, no rate) as unresolved', () => {
        const result = resolveRentBasis({ rentAmount: 5000, rentUnitRaw: 'лв за целия имот' }, 12);
        expect(result.resolved).toBe(false);
        if (result.resolved) throw new Error('expected unresolved');
        expect(result.raw).toBe('лв за целия имот');
        expect(result.reason).toContain('лв за целия имот');
    });

    it('reports a wholly unrecognised unit as unresolved, naming the raw text', () => {
        const result = resolveRentBasis({ rentAmount: 100, rentUnitRaw: 'USD/acre' }, 5);
        expect(result.resolved).toBe(false);
        if (result.resolved) throw new Error('expected unresolved');
        expect(result.raw).toBe('USD/acre');
        expect(result.reason).toContain('USD/acre');
    });

    it('reports unresolved with raw: null when no unit is recorded at all', () => {
        const result = resolveRentBasis({ rentAmount: 100 }, 5);
        expect(result).toEqual({
            resolved: false,
            raw: null,
            reason: 'No rent unit recorded for this lease.',
        });
    });

    it('treats a blank rentUnit and blank rentUnitRaw as no unit at all', () => {
        const result = resolveRentBasis({ rentAmount: 100, rentUnit: '   ', rentUnitRaw: '' }, 5);
        expect(result.resolved).toBe(false);
        if (result.resolved) throw new Error('expected unresolved');
        expect(result.raw).toBeNull();
    });
});

describe('resolveRentBasis — rentUnit takes precedence over rentUnitRaw', () => {
    it('uses the already-canonical rentUnit even when rentUnitRaw disagrees', () => {
        // rentUnit is set by the write path via canonicalRentUnit(rentUnitRaw)
        // (see src/app-layer/usecases/parcel-lease.ts) so in real data they
        // never disagree on DIMENSION — but rentUnit is authoritative.
        //
        // The two values are deliberately on OPPOSITE sides of #2793's refusal
        // now, which makes this a stronger test than the pair it replaced: if
        // precedence inverted, the result would be a REFUSAL rather than a
        // number that is merely off by the old peg.
        const result = resolveRentBasis(
            { rentAmount: 40, rentUnit: RENT_UNIT_EUR, rentUnitRaw: 'лв./дка' },
            2,
        );
        expect(result).toEqual({
            resolved: true,
            kind: 'money',
            perHa: 400,
            currency: 'EUR',
        });
    });
});
