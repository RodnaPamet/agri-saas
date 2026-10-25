/**
 * The one mapping from a stored `operationType` onto a treatment DEFINITION's
 * kind (#2316).
 *
 * Worth its own file because the bug it fixes was invisible to every other
 * kind of test. `TreatmentDefinition.kind` admitted `SEED`; the code that built
 * one could only ever emit `SPRAY` or `FERTILIZE`. A narrow producer satisfies
 * a wide type, so neither `tsc` nor any assertion on the shape of a response
 * could fail — the union simply had a member nothing reached.
 */
import { FieldOperationType } from '@prisma/client';
import { TREATMENT_KINDS, treatmentKindOfOperation } from '@/lib/operations/treatment-kind';

describe('treatmentKindOfOperation', () => {
    it('maps SEED to SEED — the member that had no producer', () => {
        expect(treatmentKindOfOperation('SEED')).toBe('SEED');
    });

    it('maps the two kinds that always worked', () => {
        expect(treatmentKindOfOperation('SPRAY')).toBe('SPRAY');
        expect(treatmentKindOfOperation('FERTILIZE')).toBe('FERTILIZE');
    });

    it('reads a NULL operationType as SPRAY, not as a refusal', () => {
        // Tasks predating the column. The register already treats them as
        // treatments by deriving from the title prefix, because that is all
        // field operations of that era were. Refusing here would break a
        // correction on a historical record that is otherwise correctable.
        expect(treatmentKindOfOperation(null)).toBe('SPRAY');
    });

    it('is TOTAL over FieldOperationType — every member lands in TREATMENT_KINDS', () => {
        // The guard against the next widening. Adding a member to the Prisma
        // enum must not produce a kind outside the published union, which is
        // what a client switches on.
        const members = Object.values(FieldOperationType);
        expect(members.length).toBeGreaterThanOrEqual(6);
        for (const m of members) {
            expect(TREATMENT_KINDS).toContain(treatmentKindOfOperation(m));
        }
    });

    it('collapses the BARE activities to SPRAY, which nothing asks it to do', () => {
        // Stated rather than left implicit. `getDiaryTreatmentDefinition`
        // refuses a bare activity with `NOT_A_TREATMENT` before it builds a
        // definition, so this branch is unreachable through the route — and
        // that refusal is the reason the fallback may be a treatment kind at
        // all. If a caller ever DOES reach it, this is what it gets.
        expect(treatmentKindOfOperation('PRUNE')).toBe('SPRAY');
        expect(treatmentKindOfOperation('CULTIVATE')).toBe('SPRAY');
        expect(treatmentKindOfOperation('HARVEST')).toBe('SPRAY');
    });

    it('publishes exactly the three kinds a definition can carry', () => {
        expect([...TREATMENT_KINDS]).toEqual(['SPRAY', 'FERTILIZE', 'SEED']);
    });
});
