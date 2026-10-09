/**
 * Every RATE unit must have a stock unit to derive from.
 *
 * ## Why this guard exists
 *
 * A typed product name (#1495) creates an `Item`, and an `Item` needs a
 * `defaultUnitId`. The only unit the operation payload carries is the DOSE
 * unit, which is a rate (`l-per-ha`); an Item's default unit is a stock unit
 * (`l`). Storing the rate would compile, persist and read back fine, and would
 * be wrong later — an inventory figure in litres-per-hectare that nobody can
 * reconcile against a delivery note.
 *
 * `Unit` has no stored rate→base relation, only the key convention its own
 * model documents (`"l-per-ha", "kg", "l"`). So `baseUnitKeyOf` derives the
 * base by splitting on `-per-`, and this file is what makes that derivation
 * safe rather than lucky: a rate unit added without a resolvable base becomes a
 * red build instead of a `DOSE_UNIT_HAS_NO_BASE` refusal the first time an
 * operator types a product name against it.
 *
 * ## It tests the real function
 *
 * `baseUnitKeyOf` is imported, not reimplemented. A local copy of the split
 * would pass while the shipped derivation diverged — the same parallel-list
 * mistake the news tag catalogue is built to avoid.
 */
import { baseUnitKeyOf } from '@/app-layer/usecases/field-operation';
import { UNIT_SEEDS } from '../../scripts/import-units';

const KEYS = new Set(UNIT_SEEDS.map((u) => u.key));
const RATE_KEYS = UNIT_SEEDS.map((u) => u.key).filter((k) => k.includes('-per-'));

describe('the rate→base unit convention holds', () => {
    it('control: there ARE rate units and the seed list was really read', () => {
        // Without this, every assertion below passes over an empty array. The
        // seed list is in `scripts/`, which the root tsconfig excludes, so a
        // broken import is a realistic way for this to silently become vacuous.
        expect(UNIT_SEEDS.length).toBeGreaterThan(10);
        expect(RATE_KEYS.length).toBeGreaterThan(4);
        expect(RATE_KEYS).toContain('l-per-ha');
    });

    it('every rate unit resolves to a base that exists', () => {
        // The failure names the offending keys rather than a count, because
        // "expected 8 to be 9" does not say which unit was added.
        const unresolvable = RATE_KEYS.filter((k) => {
            const base = baseUnitKeyOf(k);
            return base === null || !KEYS.has(base);
        });

        expect(unresolvable).toEqual([]);
    });

    it('a non-rate unit derives nothing, rather than deriving itself', () => {
        // `baseUnitKeyOf('kg')` must be null, not 'kg'. Returning the input
        // would make a stock unit look like a rate whose base is itself, and
        // the caller would skip the refusal it is supposed to hit.
        for (const key of UNIT_SEEDS.map((u) => u.key).filter((k) => !k.includes('-per-'))) {
            expect(baseUnitKeyOf(key)).toBeNull();
        }
    });

    it('the derivation is the prefix, not a substring match', () => {
        expect(baseUnitKeyOf('l-per-ha')).toBe('l');
        expect(baseUnitKeyOf('kg-per-dca')).toBe('kg');
        expect(baseUnitKeyOf('ml-per-ha')).toBe('ml');
        // A leading `-per-` has no base before it and must not yield ''.
        expect(baseUnitKeyOf('-per-ha')).toBeNull();
        expect(baseUnitKeyOf('')).toBeNull();
    });
});
