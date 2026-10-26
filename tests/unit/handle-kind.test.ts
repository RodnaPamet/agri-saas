/**
 * The discriminator four call sites trust (#2373).
 *
 * `classifyFromRows` decides whether a journal handle names a TREATMENT or a
 * bare ACTIVITY, and the refusals on either side of it — `NOT_A_TREATMENT` and
 * `NOT_AN_ACTIVITY` — have to be exact complements. It is worth its own file
 * because it was written INLINE once, and that single copy is what let the
 * corrections route ship without a gate: the rule existed in one place and the
 * route that needed it had none.
 */
import { classifyFromRows } from '@/app-layer/usecases/handle-kind';

const PRODUCT_LINE = { productItemId: 'item-1', doseUnitId: 'unit-1', doseValue: 2 };
const BARE_LINE = { productItemId: null, doseUnitId: null, doseValue: null };

describe('classifyFromRows', () => {
    it('reads the LINE first — a line applying a product is a treatment', () => {
        // Whatever the task says. Legacy rows carry no `operationType`, and the
        // line holds the truth about what was actually applied.
        expect(classifyFromRows({ operationType: null }, PRODUCT_LINE)).toBe('TREATMENT');
        expect(classifyFromRows({ operationType: 'PRUNE' }, PRODUCT_LINE)).toBe('TREATMENT');
    });

    it('a line applying NOTHING is a bare activity', () => {
        expect(classifyFromRows({ operationType: 'PRUNE' }, BARE_LINE)).toBe('ACTIVITY');
        expect(classifyFromRows({ operationType: 'HARVEST' }, BARE_LINE)).toBe('ACTIVITY');
    });

    it('with NO line, the declared type decides', () => {
        // A partially-written record: tasks exist, nothing marked. Without this
        // fallback a treatment whose lines were never marked would classify as
        // an activity, and a correction would write a trail row and bump the
        // version on a record the activity route cannot represent.
        expect(classifyFromRows({ operationType: 'CULTIVATE' }, null)).toBe('ACTIVITY');
        expect(classifyFromRows({ operationType: 'SPRAY' }, null)).toBe('TREATMENT');
        expect(classifyFromRows({ operationType: 'SEED' }, null)).toBe('TREATMENT');
    });

    it('an UNKNOWN or absent type with no line reads as a treatment', () => {
        // Stated rather than left implicit, and it matches the rest of the
        // system: `treatmentKindOfOperation` reads a null `operationType` as
        // SPRAY, because that is all field operations of that era were.
        expect(classifyFromRows({ operationType: null }, null)).toBe('TREATMENT');
        expect(classifyFromRows({ operationType: 'OTHER' }, null)).toBe('TREATMENT');
    });

    it('tests all THREE dose fields, not just the product id', () => {
        // The CHECK constraint keeps them all-or-nothing, but a predicate that
        // trusted the constraint would start lying if it were dropped — and a
        // half-filled line must not read as a bare activity.
        expect(
            classifyFromRows({ operationType: 'SPRAY' }, { productItemId: 'i', doseUnitId: null, doseValue: 1 }),
        ).toBe('ACTIVITY');
        expect(
            classifyFromRows({ operationType: 'SPRAY' }, { productItemId: 'i', doseUnitId: 'u', doseValue: null }),
        ).toBe('ACTIVITY');
    });
});
