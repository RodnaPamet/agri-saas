/**
 * Which `FieldOperationType`s have a treatment DEFINITION, and the one mapping
 * from a stored operation type onto that narrower set (#2316).
 *
 * ## Why this is a module and not a ternary
 *
 * The concept lived in five places, and three of them disagreed. The request
 * schema accepted `SPRAY | FERTILIZE | SEED`, `TreatmentDefinition.kind`
 * declared the same three — and the only thing that PRODUCED a `kind` read
 *
 *     operationType === 'FERTILIZE' ? 'FERTILIZE' : 'SPRAY'
 *
 * so `SEED` was a member of a union no producer could emit. A sowing read back
 * as a spraying. The published response schema said `enum: [SPRAY, FERTILIZE]`,
 * which at least matched the producer while contradicting the type.
 *
 * Widening a union does not widen the code that builds it, and nothing fails
 * when they drift: the narrow producer still satisfies the wide type. So the
 * union and its producer live together here, and the response schema is built
 * from the same constant rather than retyping the members.
 *
 * ## Why the fallback is SPRAY and not a refusal
 *
 * `operationType` is null on tasks predating the column. The register reads
 * those by deriving from the title prefix, and treats them as treatments,
 * because that is all field operations of that era were. A definition read has
 * to answer something for them, and `SPRAY` is the answer the rest of the
 * system already gives. Refusing would break a correction on a historical
 * record that is otherwise perfectly correctable.
 *
 * A BARE ACTIVITY never reaches here — `getDiaryTreatmentDefinition` refuses it
 * with `NOT_A_TREATMENT` before building a definition, because it has no
 * product or dose to correct. That refusal is the reason this function may map
 * `PRUNE` to `SPRAY` without consequence: nothing asks it to.
 */

import type { FieldOperationType } from '@prisma/client';

/**
 * The members, in the order the contract lists them. `as const` rather than a
 * plain array so `z.enum` and the TS union can both be derived from it.
 */
export const TREATMENT_KINDS = ['SPRAY', 'FERTILIZE', 'SEED'] as const;

export type TreatmentKind = (typeof TREATMENT_KINDS)[number];

/**
 * Total over `FieldOperationType | null`.
 *
 * Written as a lookup with an explicit `Partial` rather than a chain of
 * ternaries: adding a member to `TREATMENT_KINDS` without adding it here is
 * then a type error at the return, where a ternary chain would silently fall
 * through to the default — which is exactly how `SEED` came to be unreachable.
 */
const DEFINITION_KIND: Partial<Record<FieldOperationType, TreatmentKind>> = {
    SPRAY: 'SPRAY',
    FERTILIZE: 'FERTILIZE',
    SEED: 'SEED',
};

export function treatmentKindOfOperation(operationType: FieldOperationType | string | null): TreatmentKind {
    if (operationType == null) return 'SPRAY';
    return DEFINITION_KIND[operationType as FieldOperationType] ?? 'SPRAY';
}
