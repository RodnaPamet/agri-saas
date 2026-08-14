/**
 * Turning excluded-record IDS into something a farmer recognises.
 *
 * The calculator's exclusions accordion rendered raw cuids in a monospace
 * list. Open "3 plantings missing a yield estimate" and you got
 * `cmslvwqsj0000j44se0pwtxns` three times — no parcel, no crop, nothing a
 * person can act on. The COUNT was honest; the DETAIL was unusable, which
 * made the accordion decoration.
 *
 * ── Where the names come from ───────────────────────────────────────
 *
 * No new query. `getGrainNetWorth` already reads every planting, lot,
 * unit, lease and cost entry it needs for the arithmetic; the selects were
 * widened by a few columns (`parcel.name`, `cropType.name`,
 * `lessorName`, `supplier`, `description`, `incurredOn`) and the rows are
 * already in memory when this runs. That is strictly cheaper than the
 * "gather ids, one findMany per type" pattern the brief allowed for, and
 * it cannot trip D1 — there is no read here at all.
 *
 * ── The fallback is the contract ────────────────────────────────────
 *
 * A record can be deleted between the read and the label, or a relation
 * can be missing. Every resolver falls back to the ID rather than an empty
 * string: a bullet with nothing in it is worse than a bullet with a cuid,
 * because the reader cannot even tell how many records are involved.
 *
 * @module lib/grain/exclusion-labels
 */

/** One excluded record: what it is, and how to reach it. */
export interface ExclusionEntry {
    /** The record's id — the calculator's deep links need it. */
    id: string;
    /** Human label. Falls back to `id` when nothing resolves. */
    label: string;
}

/** The already-fetched rows this reads. Nothing is queried here. */
export interface ExclusionLabelSources {
    plantings: ReadonlyArray<{
        id: string;
        parcel: { name: string } | null;
        cropPlan: { cropType: { name: string } | null } | null;
    }>;
    lots: ReadonlyArray<{ id: string; item: { name: string } | null }>;
    units: ReadonlyMap<string, string>;
    leases: ReadonlyArray<{
        id: string;
        lessorName: string | null;
        parcel: { name: string } | null;
    }>;
    costEntries: ReadonlyArray<{
        id: string;
        supplier: string | null;
        description: string | null;
        incurredOn: Date | string | null;
    }>;
}

/** `a · b`, skipping absent parts, so no label ever reads " · ". */
function join(...parts: Array<string | null | undefined>): string {
    return parts.filter((p) => p != null && p !== '').join(' · ');
}

function isoDay(value: Date | string | null): string | null {
    if (value == null) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Build the id → label lookups.
 *
 * Returned as maps rather than resolved eagerly because the caller labels
 * several exclusion classes from the same entity type — plantings appear
 * in two classes, lots in two, leases in three.
 */
export function buildExclusionLabels(sources: ExclusionLabelSources): {
    planting: (id: string) => string;
    lot: (id: string, unitKey?: string | null) => string;
    lease: (id: string) => string;
    costEntry: (id: string) => string;
} {
    const plantings = new Map(
        sources.plantings.map((p) => [
            p.id,
            join(p.parcel?.name, p.cropPlan?.cropType?.name),
        ]),
    );
    const lots = new Map(sources.lots.map((l) => [l.id, l.item?.name ?? '']));
    const leases = new Map(
        sources.leases.map((l) => [l.id, join(l.lessorName, l.parcel?.name)]),
    );
    const costEntries = new Map(
        sources.costEntries.map((c) => [
            c.id,
            // Supplier first: on a payroll line it names who was paid,
            // which is what an operator is looking for. Description is the
            // fallback because it is nullable and often blank.
            join(c.supplier ?? c.description, isoDay(c.incurredOn)),
        ]),
    );

    // `|| id` and not `?? id`: an empty string is exactly what an
    // unresolved name produces, and rendering a blank bullet loses even
    // the count.
    return {
        planting: (id) => plantings.get(id) || id,
        lot: (id, unitKey) => {
            const name = lots.get(id) || id;
            // The unit belongs on the label: the class is "lots whose unit
            // is not a weight", and WHICH unit is the actionable part.
            return unitKey ? `${name} (${unitKey})` : name;
        },
        lease: (id) => leases.get(id) || id,
        costEntry: (id) => costEntries.get(id) || id,
    };
}
