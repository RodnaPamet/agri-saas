/**
 * The БАБХ regulatory fields, where two schemas accept them.
 *
 * `CreateItemSchema` (the product form) and `CreateFieldOperationSchema` (a
 * typed product name that has to create the product) both take
 * `pppRegistrationNo`, `quarantinePeriodDays` and `activeIngredient`. They
 * share one exported `REGULATORY` declaration, so they agree **by
 * construction** — this file does not re-assert that, because a test that
 * cannot fail is worse than no test.
 *
 * What it does assert is the part that is a DECISION rather than a structure:
 * the operation schema requires neither field, deliberately.
 *
 * ## A correction worth keeping, because the wrong version sounds right
 *
 * The share was briefly replaced with two local declarations plus an
 * equivalence check, on my claim that it "does not typecheck" — the two files
 * import different `z` (plain `zod` vs the `.openapi()`-extended instance), so
 * spreading one instance's schemas into the other's object looked unsound.
 *
 * Measured: it typechecks cleanly. The CI failure I was diagnosing was a
 * use-before-declare in `PrescriptionPanel.tsx`, nothing to do with zod. The
 * share is back.
 *
 * The lesson is the shape of the mistake. A plausible mechanism, asserted
 * while looking at a real failure, produced a worse design (duplication) AND a
 * confident false comment that the next reader would have believed. The full
 * `tsc` run that refuted it cost two minutes, and I had already written the
 * explanation down before paying it.
 */
import { CreateItemSchema } from '@/app-layer/schemas/catalog.schemas';
import { CreateFieldOperationSchema } from '@/lib/schemas';

function operationWith(registration?: Record<string, unknown>) {
    return {
        assigneeUserId: 'u1',
        parcelIds: ['p1'],
        productName: 'Карате Зеон',
        doseValue: 2,
        doseUnitId: 'unit-1',
        ...(registration ? { newProductRegistration: registration } : {}),
    };
}

describe('the operation schema does not require the regulatory fields', () => {
    it('accepts a typed name with no registration at all', () => {
        // Deliberate, and the reason is the one that makes the owner's ruling
        // workable: whether the two fields are NEEDED depends on whether
        // `productName` matched an existing product, which only the usecase
        // knows after it has looked. Requiring them at the HTTP boundary would
        // demand them for every typed name, including one that matches a
        // product created last season.
        expect(CreateFieldOperationSchema.safeParse(operationWith()).success).toBe(true);
    });

    it('accepts an EMPTY registration object', () => {
        // A client that always sends the key, with nothing in it, must not be
        // rejected at the boundary either — the usecase decides.
        expect(CreateFieldOperationSchema.safeParse(operationWith({})).success).toBe(true);
    });

    it('still applies the shared bounds when the fields ARE sent', () => {
        // The share means these bounds come from one place; this pins that they
        // are actually reached through the nested object rather than ignored by
        // a `.strip()` that drops the whole key.
        expect(
            CreateFieldOperationSchema.safeParse(
                operationWith({ pppRegistrationNo: 'x'.repeat(120) }),
            ).success,
        ).toBe(true);
        expect(
            CreateFieldOperationSchema.safeParse(
                operationWith({ pppRegistrationNo: 'x'.repeat(121) }),
            ).success,
        ).toBe(false);
        expect(
            CreateFieldOperationSchema.safeParse(
                operationWith({ quarantinePeriodDays: -1 }),
            ).success,
        ).toBe(false);
    });

    it('control: the product form enforces the SAME bound, from the same constant', () => {
        // Not an equivalence check — they share the declaration. This is the
        // control that the bound under test is the real one and not a value
        // this file invented: if `REGULATORY` moved to 200, both of these flip
        // together and the case above fails, which is the signal wanted.
        const item = (r: Record<string, unknown>) =>
            CreateItemSchema.safeParse({
                name: 'Амониев нитрат',
                category: 'FERTILIZER',
                defaultUnitId: 'unit-1',
                ...r,
            }).success;

        expect(item({ pppRegistrationNo: 'x'.repeat(120) })).toBe(true);
        expect(item({ pppRegistrationNo: 'x'.repeat(121) })).toBe(false);
    });
});
