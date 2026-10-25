/**
 * Is an `OperationParcel` line a product application, or a bare activity? (#2316)
 *
 * `productItemId`, `doseValue` and `doseUnitId` were all NOT NULL, so a
 * non-chemical activity — pruning, cultivation, sowing, harvest — could not be
 * recorded as a line at all. #2316 relaxed all three, with a CHECK keeping them
 * all-or-nothing:
 *
 *     CHECK (num_nulls("productItemId", "doseValue", "doseUnitId") IN (0, 3))
 *
 * so a chemical line still cannot be half-filled. This predicate is that
 * constraint expressed once in the type system, instead of three null checks
 * repeated at each reader — where they would drift apart, and where checking
 * only `productItemId` would narrow one field and leave the other two `null` to
 * surface further down.
 *
 * ## Why a type guard and not a filter at the query
 *
 * Both, where it matters. A reader that cannot act on a bare activity should
 * also exclude it in SQL rather than fetch and discard it. But Prisma does not
 * narrow a type on `where: { productItemId: { not: null } }` — the generated
 * row type keeps `string | null` — so a query filter alone leaves the call site
 * needing a non-null assertion, which is exactly the thing that goes stale when
 * the schema moves again.
 */

/** The three dose fields as the generated client types them after #2316. */
export interface OperationLineDoseFields {
    productItemId: string | null;
    doseUnitId: string | null;
    /**
     * `unknown` rather than `Decimal | null`: the readers of this predicate
     * deliberately do not import Prisma's `Decimal` — they pass the value
     * through their own `toNumber`/`toString` seams — and tying the signature
     * to it would force that import on all of them.
     */
    doseValue: unknown;
}

/**
 * True when the line records a product application, narrowing both id fields.
 *
 * All three are tested, not just `productItemId`. The CHECK makes them move
 * together, but a predicate that trusted the constraint would silently start
 * lying if the constraint were ever dropped — and this returns a TYPE claim,
 * so a wrong answer becomes an unchecked null further down rather than a
 * failure here.
 */
export function appliesAProduct<T extends OperationLineDoseFields>(
    line: T,
): line is T & { productItemId: string; doseUnitId: string } {
    return line.productItemId !== null && line.doseUnitId !== null && line.doseValue !== null;
}
