/**
 * Unit tests for `src/lib/grain/rent-basis.ts` — resolving `ParcelLease`
 * rent to a comparable annual per-hectare figure.
 *
 * Money (лв/дка) and produce (кг/дка) are different DIMENSIONS — a
 * currency and a mass — so every branch below is checked for both the
 * resolved shape (`kind` + the matching field) AND the honest refusal
 * shape (`resolved: false` + a reason naming the raw unit text).
 */
import { resolveRentBasis, type RentBasisResult } from '@/lib/grain/rent-basis';
import { RENT_UNIT_KG, RENT_UNIT_LEVA } from '@/lib/agro/rent-units';
import { DCA_PER_HA } from '@/lib/agro/rate-calc';

describe('resolveRentBasis — money per decare (лв/дка)', () => {
    it('resolves a canonical rentUnit to a money per-hectare figure', () => {
        const result = resolveRentBasis({ rentAmount: 80, rentUnit: RENT_UNIT_LEVA }, 5);
        expect(result).toEqual({ resolved: true, kind: 'money', perHa: 80 * DCA_PER_HA });
    });

    it('resolves a raw alias (lv/dka) via rentUnitRaw when rentUnit is absent', () => {
        const result = resolveRentBasis({ rentAmount: 50, rentUnitRaw: 'lv/dka' }, 3.2);
        expect(result).toEqual({ resolved: true, kind: 'money', perHa: 500 });
    });

    it('is area-INDEPENDENT once resolved — a per-decare rate scales, it does not accumulate', () => {
        const small = resolveRentBasis({ rentAmount: 80, rentUnit: RENT_UNIT_LEVA }, 1);
        const large = resolveRentBasis({ rentAmount: 80, rentUnit: RENT_UNIT_LEVA }, 500);
        expect(small).toEqual(large);
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
        const money = resolveRentBasis({ rentAmount: 10, rentUnit: RENT_UNIT_LEVA }, 1);
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

        const money = resolveRentBasis({ rentAmount: 10, rentUnit: RENT_UNIT_LEVA }, 1);
        const produce = resolveRentBasis({ rentAmount: 10, rentUnit: RENT_UNIT_KG }, 1);
        expect(() => combineSameKind(money, produce)).toThrow(/cannot combine/);

        const moneyToo = resolveRentBasis({ rentAmount: 20, rentUnit: RENT_UNIT_LEVA }, 1);
        expect(combineSameKind(money, moneyToo)).toBe(10 * DCA_PER_HA + 20 * DCA_PER_HA);
    });
});

describe('resolveRentBasis — zero rent is a real value, not an unresolved unit', () => {
    it('resolves a genuine zero rentAmount to perHa: 0, distinct from resolved: false', () => {
        const result = resolveRentBasis({ rentAmount: 0, rentUnit: RENT_UNIT_LEVA }, 2);
        expect(result).toEqual({ resolved: true, kind: 'money', perHa: 0 });
        expect(result.resolved).toBe(true);
    });

    it('a null rentAmount is unresolved, not zero', () => {
        const result = resolveRentBasis({ rentAmount: null, rentUnit: RENT_UNIT_LEVA }, 2);
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
        const result = resolveRentBasis({ rentAmount: 40, rentUnit: RENT_UNIT_LEVA, rentUnitRaw: 'лв./дка' }, 2);
        expect(result).toEqual({ resolved: true, kind: 'money', perHa: 400 });
    });
});
