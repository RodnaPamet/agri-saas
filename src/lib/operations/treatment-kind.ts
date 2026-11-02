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

/**
 * The operation kinds Приложение 1 has COLUMNS for (#2697).
 *
 * The form is «ДНЕВНИК ЗА ПРОВЕДЕНИТЕ РАСТИТЕЛНОЗАЩИТНИ МЕРОПРИЯТИЯ И
 * ТОРЕНЕ» — plant protection and fertilising, and nothing else. A cultivation,
 * a pruning, a harvest and a sowing all have records that EXIST and print in
 * «ДНЕВНИК НА СТОПАНСТВОТО»; it is only this form that excludes them.
 *
 * ## An ALLOWLIST, because the defect was an else-branch
 *
 * `farm-record-diary.ts` classified a line as `FERTILIZE` or fell through to
 * the chemical table, with one explicit `SEED` skip in front and a comment
 * asserting the bare kinds "never reach this function at all". They did: both
 * gatherer branches select lines by TASK and `status: 'DONE'` with no product
 * predicate, so a cultivation printed as a plant-protection treatment with
 * empty вредител, ПРЗ, доза and карантинен срок columns — in the document a
 * БАБХ inspector reads.
 *
 * Listing what is ADMITTED rather than what is skipped means a new
 * `FieldOperationType` is excluded by default. The previous shape admitted it
 * by default, which is how three kinds got in.
 *
 * Deliberately NOT `treatmentKindOfOperation`, whose `?? 'SPRAY'` default is
 * the same hazard in a different function: it answers "which DEFINITION shape
 * does this use", where this answers "does the form have a row for it".
 *
 * The iOS client derives the same predicate on its own side to decide whether
 * to offer the БАБХ button. This is the server's copy of that rule and the two
 * should converge on it.
 */
export const BABH_REGISTER_KINDS = ['SPRAY', 'FERTILIZE'] as const;

export function isInBabhRegister(operationType: string | null | undefined): boolean {
    if (!operationType) return false;
    return (BABH_REGISTER_KINDS as readonly string[]).includes(operationType);
}
