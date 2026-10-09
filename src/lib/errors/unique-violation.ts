/**
 * Reading a unique-violation's identifiers, with no Prisma import.
 *
 * Split out of `./prisma` for #1500 so `./types` can use it. That file states
 * in a comment that it detects Prisma errors "without explicitly importing
 * Prisma to keep Edge safe", and `./prisma` imports `@prisma/client` for one
 * `instanceof` on line 16 — so importing the helper from there would have
 * pulled the client into an Edge-safe module to get a function that never
 * needed it. This reads plain object properties and nothing else.
 *
 * MOVED, not copied. `./prisma` re-exports it, so existing callers are
 * unchanged and there is still exactly one implementation — two copies of a
 * shape-reading rule is how two answers diverge.
 */

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
