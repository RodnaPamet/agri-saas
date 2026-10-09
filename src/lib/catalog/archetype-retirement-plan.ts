/**
 * What retiring the seeded sample products WOULD do, decided without a database.
 *
 * `scripts/retire-sample-products.ts` is a thin shell around this: read rows,
 * call `planArchetypeRetirement`, print it, and — only with `--apply` — write
 * the soft deletes it names. Every decision that can be wrong lives here, the
 * same split `tests/unit/backfill-token-encryption.test.ts` uses.
 *
 * ## Why soft-delete is the whole mechanism
 *
 * The owner asked for two things that look like they need separate work: hide
 * the archetypes from product lists, and keep the ones past records already
 * use. One mechanism does both, and that was measured rather than assumed:
 *
 *     history BEFORE soft-delete: {"name":"Generic Probe"}
 *     history AFTER  soft-delete: {"name":"Generic Probe"}
 *     appears in a deletedAt:null list after: 0
 *
 * Every picker and list reaches items through `listItems`, which filters
 * `deletedAt: null` — so a soft-deleted archetype is gone from all of them at
 * once, including the four screens that still show a product list. And a past
 * record reads its product as a RELATION include with no `deletedAt` of its
 * own, so the name still renders in the ДНЕВНИК and in history.
 *
 * "Keep the ones past records already use" is therefore satisfied by soft
 * delete rather than by exempting them: the row stays, and soft-delete is not
 * deletion. Owner ruling 2026-10-09, with that measurement in hand: retire all
 * of them, referenced or not.
 *
 * ## The consequence worth stating
 *
 * A PENDING operation line pointing at an archetype must be re-pointed at a
 * real product before it can be completed. That is NOT new: #1078 already
 * refuses to complete such a line, because ДНЕВНИК column 4 asks for a
 * /търговско наименование/ and an archetype is an active-ingredient
 * descriptor. Retiring the archetype makes the dead end visible at planning
 * time instead of at completion, which is the direction this whole line of
 * work has been pushing.
 *
 * @module lib/catalog/archetype-retirement-plan
 */

/** The fields a plan needs. A subset of `Item` plus its reference counts. */
export interface ArchetypeCandidate {
    id: string;
    name: string;
    category: string;
    isArchetype: boolean;
    deletedAt: Date | null;
    /** How many `OperationParcel` lines point at it. */
    operationLines: number;
    /** How many `InventoryLot` rows point at it. */
    lots: number;
    /** How many `CostEntry` rows point at it. */
    costEntries: number;
}

export interface PlannedRetirement {
    id: string;
    name: string;
    category: string;
    /** Total inbound references across all three relations. */
    references: number;
}

export interface RetirementPlan {
    /** Rows to soft-delete. */
    retire: PlannedRetirement[];
    /** Every archetype seen, including ones already retired. */
    archetypesSeen: number;
    /** Already `deletedAt` — counted, never re-written. */
    alreadyRetired: number;
    /** Of `retire`, how many a past record points at. */
    referenced: number;
    /** Of `retire`, how many nothing points at. */
    unreferenced: number;
    /** Reference totals per relation, for the report. */
    byRelation: { operationLines: number; lots: number; costEntries: number };
    /** Non-archetypes seen. A control: this must never be the thing retired. */
    realProductsUntouched: number;
}

const refsOf = (c: ArchetypeCandidate): number =>
    c.operationLines + c.lots + c.costEntries;

export function planArchetypeRetirement(
    items: readonly ArchetypeCandidate[],
): RetirementPlan {
    const retire: PlannedRetirement[] = [];
    let archetypesSeen = 0;
    let alreadyRetired = 0;
    let referenced = 0;
    let unreferenced = 0;
    let realProductsUntouched = 0;
    const byRelation = { operationLines: 0, lots: 0, costEntries: 0 };

    for (const item of items) {
        // The guard that matters most. A real product retired by mistake takes
        // a farm's own catalogue entry out of every picker, and the farmer has
        // no way to tell why it vanished. `isArchetype` is the only signal
        // used, deliberately: the column exists BECAUSE the three inferable
        // signals (name `Generic %`, null `createdByUserId`, present
        // `attributesJson`) were judged insufficient to justify a refusal in
        // #1078, and they are no better here.
        if (!item.isArchetype) {
            realProductsUntouched += 1;
            continue;
        }
        archetypesSeen += 1;

        // Idempotence. Re-running must not re-stamp `deletedAt` on a row that
        // already has one — that would move the retirement date on every run
        // and destroy the record of when it actually happened.
        if (item.deletedAt !== null) {
            alreadyRetired += 1;
            continue;
        }

        const references = refsOf(item);
        if (references > 0) referenced += 1;
        else unreferenced += 1;
        byRelation.operationLines += item.operationLines;
        byRelation.lots += item.lots;
        byRelation.costEntries += item.costEntries;

        retire.push({
            id: item.id,
            name: item.name,
            category: item.category,
            references,
        });
    }

    return {
        retire,
        archetypesSeen,
        alreadyRetired,
        referenced,
        unreferenced,
        byRelation,
        realProductsUntouched,
    };
}
