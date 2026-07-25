/**
 * Bin fill arithmetic — the single definition of "how full is this bin".
 *
 * ## Why this module exists
 *
 * A bin's capacity is denominated in TONNES (`Location.capacityTonnes`), but
 * the lots inside it are denominated in whatever unit their item defaults to.
 * `Item.defaultUnitId` is user-chosen with no measure constraint, and `kg`,
 * `g` and `t` are three distinct `Unit` rows. `InventoryLot.unitId` forbids
 * mixed units WITHIN a lot — it says nothing about a bin holding a kg lot and
 * a t lot side by side.
 *
 * Summing raw `quantityOnHand` and dividing by `capacityTonnes` therefore
 * produced a 1000× error for kg-denominated grain: the shipped demo data put
 * 320 kg into a 500 t bin and the UI rendered 64% for a bin 0.064% full.
 *
 * ## The rule
 *
 * Quantities are converted to tonnes per-unit via `@/lib/units/unit-conversion`
 * (exact integer bases, so kg→t carries no float drift), then summed:
 *
 *   - every lot convertible to tonnes (a WEIGHT unit) → a correct `fillPct`
 *   - any lot in a non-WEIGHT unit (`each`, `l`, …) → `fillPct` is `null` and
 *     `mixedUnits` is true, with the offending quantities reported separately
 *
 * Converting rather than filtering-to-tonnes is deliberate: a farmer whose
 * produce items default to kg is the COMMON case, and filtering would render
 * their bins permanently empty. Reporting `null` rather than a partial
 * percentage for genuinely unconvertible stock is also deliberate — "40 ea of
 * seed potatoes" has no defensible tonnage, and a fill bar that quietly
 * ignores part of the contents is the same class of lie as the 1000× bug.
 *
 * Pure + dependency-free apart from the conversion table, so the arithmetic is
 * unit-testable without a database.
 */
import { canConvert, convert } from '@/lib/units/unit-conversion';

/** `Location.capacityTonnes` is tonnes, so tonnes is the target unit. */
export const BIN_CAPACITY_UNIT_KEY = 't';

/** One `groupBy(['locationId','unitId'])` row, Decimals already coerced. */
export interface StoredGroup {
    locationId: string | null;
    unitId: string;
    /** `_sum.quantityOnHand` for this (bin, unit) pair. */
    quantity: number;
    /** `_count._all` for this (bin, unit) pair. */
    lotCount: number;
}

/** The `Unit` fields the arithmetic needs. `key` is the conversion handle. */
export interface UnitRef {
    id: string;
    key: string;
    symbol: string;
}

/** Stock in a bin that carries no defensible tonnage. */
export interface UnconvertibleStock {
    unitKey: string;
    symbol: string;
    quantity: number;
    lotCount: number;
}

export interface BinStoredTotals {
    /** Sum of the weight-convertible lots, in tonnes. */
    storedTonnes: number;
    /** Every lot in the bin, including unconvertible ones. */
    lotCount: number;
    /**
     * True when the bin holds stock that cannot be expressed in tonnes, so a
     * fill percentage would be a partial truth. Forces `fillPct` to null.
     */
    mixedUnits: boolean;
    /** Per-unit breakdown of that unconvertible stock (empty when clean). */
    unconvertible: UnconvertibleStock[];
}

export const EMPTY_BIN_TOTALS: Readonly<BinStoredTotals> = Object.freeze({
    storedTonnes: 0,
    lotCount: 0,
    mixedUnits: false,
    unconvertible: [],
});

/** Round to 4dp — matches `Decimal(16,4)` on `quantityOnHand`. */
function round4(n: number): number {
    return Math.round(n * 1e4) / 1e4;
}

/**
 * Reduce grouped (bin, unit) sums into per-bin tonnage.
 *
 * Groups whose `locationId` is null are skipped (unassigned stock belongs to
 * no bin). A group whose `unitId` has no matching `Unit` row is treated as
 * unconvertible rather than ignored — silently dropping stock is how the
 * original bug read as plausible.
 */
export function summariseStoredByBin(
    groups: readonly StoredGroup[],
    units: readonly UnitRef[],
): Map<string, BinStoredTotals> {
    const unitById = new Map(units.map((u) => [u.id, u]));
    const byBin = new Map<string, BinStoredTotals>();

    for (const group of groups) {
        if (!group.locationId) continue;

        const totals: BinStoredTotals =
            byBin.get(group.locationId) ??
            { storedTonnes: 0, lotCount: 0, mixedUnits: false, unconvertible: [] };

        totals.lotCount += group.lotCount;

        const unit = unitById.get(group.unitId);
        const unitKey = unit?.key ?? group.unitId;

        if (unit && canConvert(unit.key, BIN_CAPACITY_UNIT_KEY)) {
            totals.storedTonnes += convert(group.quantity, unit.key, BIN_CAPACITY_UNIT_KEY);
        } else {
            totals.mixedUnits = true;
            const existing = totals.unconvertible.find((u) => u.unitKey === unitKey);
            if (existing) {
                existing.quantity = round4(existing.quantity + group.quantity);
                existing.lotCount += group.lotCount;
            } else {
                totals.unconvertible.push({
                    unitKey,
                    symbol: unit?.symbol ?? unitKey,
                    quantity: round4(group.quantity),
                    lotCount: group.lotCount,
                });
            }
        }

        byBin.set(group.locationId, totals);
    }

    for (const totals of byBin.values()) {
        totals.storedTonnes = round4(totals.storedTonnes);
        totals.unconvertible.sort((a, b) => a.unitKey.localeCompare(b.unitKey));
    }
    return byBin;
}

/**
 * Fill fraction (NOT a percentage — 0.64 means 64%, matching the previous
 * contract so the progress bar's scale is unchanged).
 *
 * Null when there is no usable capacity, or when the bin holds unconvertible
 * stock. The `capacity > 0` test is the existing divide-by-zero guard.
 */
export function fillFractionFor(
    storedTonnes: number,
    capacityTonnes: number | null,
    mixedUnits: boolean,
): number | null {
    if (mixedUnits) return null;
    if (capacityTonnes == null || capacityTonnes <= 0) return null;
    return round4(storedTonnes / capacityTonnes);
}
