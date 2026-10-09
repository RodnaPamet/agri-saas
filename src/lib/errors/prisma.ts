import { Prisma } from '@prisma/client';

/**
 * Prisma's unique-constraint violation (P2002).
 *
 * This is the backstop for the offline idempotency race: two replays of the
 * same queued item reach the unique `(tenantId, clientMutationId)` index
 * concurrently, and the loser must re-read the winner's row rather than
 * surface an error for work that DID happen.
 *
 * Shared because the predicate was written out three times independently
 * (journal, field-operation, automation dispatch) and a fourth copy is how a
 * detail like the error code drifts between call sites that must agree.
 */
export function isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * What a P2002 says it violated, across BOTH error shapes.
 *
 * `meta.target` is populated for indexes Prisma knows about from the schema. An
 * index that lives in raw SQL — a PARTIAL or EXPRESSION index, which Prisma
 * cannot express and this repo has at least one of — is reported by the driver
 * adapter instead, and `meta.target` is `undefined`.
 *
 * Measured on Prisma 7 with `@prisma/adapter-pg`, inserting a duplicate against
 * `Item_tenantId_name_active_key` (the partial, case-insensitive index on
 * `(tenantId, lower(name)) WHERE deletedAt IS NULL`):
 *
 *     code        'P2002'
 *     meta.target undefined
 *     meta.driverAdapterError.cause.constraint.index
 *                 'Item_tenantId_name_active_key'
 *
 * That is why this exists. A caller narrowing on `meta.target` alone — which
 * `asDuplicateNameConflict` did — silently stops translating the moment the
 * index it cares about is one Prisma does not model, and rethrows a raw P2002
 * at the client. The symptom is a 500 or an unmapped code where a named 409 was
 * documented, and nothing fails: the translation is still there, still correct,
 * and never reached.
 *
 * Returns every candidate IDENTIFIER, so a caller can look for its column or
 * its index name without caring which shape produced it.
 *
 * `cause.originalMessage` is deliberately NOT included, and the reason is the
 * one that matters here. Postgres populates a unique-violation detail with the
 * offending VALUE — "Key (tenantId, lower(name))=(…, карате зеон) already
 * exists" — so a helper that returned it would hand a caller a string that
 * reads like an identifier and carries data. `src/lib/errors/types.ts` already
 * copies a P2002's target straight into a client-facing `error.details`, which
 * is exactly where such a string would end up. The structured
 * `constraint.index` and `constraint.fields` are schema metadata and carry no
 * row content, so narrowing works without the risk.
 */
export function uniqueViolationTargets(err: unknown): string[] {
    const meta = (err as { meta?: Record<string, unknown> })?.meta;
    if (!meta) return [];
    const out: string[] = [];

    const target = meta.target;
    if (typeof target === 'string') out.push(target);
    else if (Array.isArray(target)) out.push(...target.map((t) => String(t)));

    // The adapter shape. Read defensively — this is a nested bag from a
    // dependency, and a shape change should narrow the answer rather than throw
    // inside an error handler.
    const cause = (meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined)?.cause;
    const constraint = (cause?.constraint as { index?: unknown; fields?: unknown } | undefined);
    if (typeof constraint?.index === 'string') out.push(constraint.index);
    if (Array.isArray(constraint?.fields)) out.push(...constraint.fields.map((f) => String(f)));

    return out;
}
