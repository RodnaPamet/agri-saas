/**
 * The PAYROLL breakdown is both-or-neither, PAYROLL only, and NOT arithmetic.
 *
 * Owner decision 2026-10-09: salaries are entered per year, "either a total or
 * an optional number of people × yearly salary". `payrollHeadcount` and
 * `payrollAnnualPerPerson` record how the figure was arrived at, so the form can
 * show the breakdown and the calculator's "last values" default can recall it —
 * the same reasoning as `amountPerDca`, which exists because a derived-only
 * figure can never be read back as typed.
 *
 * ## The assertion that is DELIBERATELY absent
 *
 * `headcount × annualPerPerson` is never compared against `amount`, and the
 * case that settles it is concrete: three people at 12 000 is 36 000, but a farm
 * whose third hire started in May will enter 35 500 beside the same headcount.
 * Refusing that mismatch would block a true figure to protect an arithmetic
 * identity the owner never asked for, and "either a total OR people × salary"
 * reads as a way to arrive at the number rather than a constraint on it.
 *
 * So one case here asserts a mismatch is ACCEPTED. That is the unusual kind of
 * test — it pins an absence — and without it someone adding the "obvious"
 * consistency check would find every existing test still green.
 */
import { CreateCostEntrySchema } from '@/app-layer/schemas/grain.schemas';

/** A valid PAYROLL entry, so only the breakdown fields are under test. */
function payroll(over: Record<string, unknown> = {}) {
    return {
        category: 'PAYROLL',
        amount: 36000,
        currency: 'BGN',
        incurredOn: '2026-01-31',
        allocationBasis: 'HOLDING',
        ...over,
    };
}

const parsed = (o: Record<string, unknown>) => CreateCostEntrySchema.safeParse(o);

describe('the payroll breakdown reaches the usecase through the schema', () => {
    it('control: a plain PAYROLL entry with no breakdown parses', () => {
        // Without this, every case below could be failing for an unrelated
        // reason in the base payload and the breakdown fields would be
        // untested.
        expect(parsed(payroll()).success).toBe(true);
    });

    it('accepts the pair', () => {
        const r = parsed(payroll({ payrollHeadcount: 3, payrollAnnualPerPerson: 12000 }));

        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.payrollHeadcount).toBe(3);
            expect(r.data.payrollAnnualPerPerson).toBe(12000);
        }
    });

    it('ACCEPTS a product that does not equal the amount', () => {
        // The deliberate absence. 3 × 12 000 = 36 000, but this entry says
        // 35 500 — the May-hire case. The schema must not refuse it, and nor
        // must the usecase.
        const r = parsed(
            payroll({ amount: 35500, payrollHeadcount: 3, payrollAnnualPerPerson: 12000 }),
        );

        expect(r.success).toBe(true);
    });

    it('refuses a non-integer headcount', () => {
        // Half a person is not a rounding artefact, it is a wrong field. The
        // column is INTEGER, so accepting 2.5 here would either truncate
        // silently or fail at the database with an opaque error.
        expect(parsed(payroll({ payrollHeadcount: 2.5, payrollAnnualPerPerson: 12000 })).success).toBe(
            false,
        );
    });

    it('refuses zero and negative values on both fields', () => {
        // Zero people earning a salary, or a negative salary, are not figures a
        // farm can mean. `.positive()` rather than `.nonnegative()` for exactly
        // that: a headcount of 0 with a non-zero amount is incoherent, and
        // "entered as a total" is already expressible by omitting the pair.
        for (const bad of [
            { payrollHeadcount: 0, payrollAnnualPerPerson: 12000 },
            { payrollHeadcount: -1, payrollAnnualPerPerson: 12000 },
            { payrollHeadcount: 3, payrollAnnualPerPerson: 0 },
            { payrollHeadcount: 3, payrollAnnualPerPerson: -500 },
        ]) {
            expect(parsed(payroll(bad)).success).toBe(false);
        }
    });

    it('null is accepted and means "entered as a total"', () => {
        // Distinct from absent at the type level, and both mean the same thing
        // downstream. A client that always sends the keys must not be refused.
        const r = parsed(payroll({ payrollHeadcount: null, payrollAnnualPerPerson: null }));

        expect(r.success).toBe(true);
    });

    it('the SHAPE rules are not the schema\'s job — they are the usecase\'s', () => {
        // Half a pair, and the pair on a FUEL cost, both parse here. That is
        // correct and worth pinning: the rules depend on `category`, which Zod
        // cannot express cleanly across optional nullable fields, so they live
        // in `assertPayrollBreakdown` where `category` is in hand — exactly
        // where `leaseId may only be set on a RENT cost entry` already lives.
        //
        // If someone later moves these into a `superRefine`, this test fails
        // and points at the duplication rather than letting two
        // implementations drift.
        expect(parsed(payroll({ payrollHeadcount: 3 })).success).toBe(true);
        expect(
            parsed(payroll({ category: 'FUEL', payrollHeadcount: 3, payrollAnnualPerPerson: 1 }))
                .success,
        ).toBe(true);
    });
});
