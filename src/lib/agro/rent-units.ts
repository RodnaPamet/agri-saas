/**
 * Canonical rent units for parcel leases (аренда/наем).
 *
 * Farm rent is quoted either in money per decare („лв/дка") or in produce per
 * decare („кг/дка") — a lease register that sums those into one number is
 * dimensionally meaningless. The roll aggregates PER UNIT, which only works if
 * the free-text unit operators type is folded to a small canonical set first.
 *
 * Why not `@/lib/units/unit-conversion`: that catalog is the physical dose-math
 * layer (AREA / VOLUME / WEIGHT / COUNT / LENGTH, slug-style rate keys like
 * `kg-per-dca`). Rent units include a CURRENCY numerator („лв"), which has no
 * dimension there, and they are stored/displayed in their Cyrillic form. So
 * rent gets this small dedicated normaliser instead of a currency dimension
 * bolted onto the dose catalog.
 *
 * The operator's original text is preserved separately (`ParcelLease.rentUnitRaw`)
 * — canonicalisation is for grouping, never for discarding what was entered.
 */
import { amountUnitOf } from './rate-calc';

export const RENT_UNIT_LEVA = 'лв/дка';
/**
 * Money per decare in EURO — the unit NEW leases are entered in.
 *
 * Owner ruling 2026-10-31, relayed through the iOS session and confirmed
 * directly: new leases are euro-only, and existing `лв/дка` leases convert at
 * the peg (see `rent-basis.ts`). `RENT_UNIT_LEVA` is therefore kept and still
 * canonical — it is what is IN the database for every lease recorded before
 * today, and dropping it would turn those into unrecognised units and refuse
 * them, which is the opposite of converting them.
 */
export const RENT_UNIT_EUR = '€/дка';
export const RENT_UNIT_KG = 'кг/дка';

/** The canonical set. Anything else round-trips as its own ("other") bucket. */
export const CANONICAL_RENT_UNITS = [RENT_UNIT_EUR, RENT_UNIT_LEVA, RENT_UNIT_KG] as const;

/**
 * The currency a money rent unit is quoted in, as an ISO-ish code the cost
 * vocabulary already understands.
 *
 * This is the whole reason rent can now be totalled with costs: `ParcelLease`
 * has no currency COLUMN, so the unit is the only place the currency is
 * recorded, and until this map existed nothing could read it. `кг/дка` is
 * absent deliberately — produce rent is a mass, and giving it a currency is
 * the same category error as summing it with money.
 */
export const MONEY_RENT_UNIT_CURRENCY: Readonly<Record<string, string>> = {
    [RENT_UNIT_EUR]: 'EUR',
    [RENT_UNIT_LEVA]: 'BGN',
};

/** Is this canonical unit money (as opposed to produce, or unrecognised)? */
export function isMoneyRentUnit(canonical: string | null | undefined): boolean {
    return canonical != null && canonical in MONEY_RENT_UNIT_CURRENCY;
}

/**
 * Aliases → canonical. Keys are lower-cased with whitespace stripped, so
 * „ЛВ / ДКА", "lv/dka" and „лв./дка" all land on `лв/дка`.
 */
const ALIASES: Record<string, string> = {
    // money per decare — EURO (what new leases use)
    '€/дка': RENT_UNIT_EUR,
    '€/декар': RENT_UNIT_EUR,
    '€/dka': RENT_UNIT_EUR,
    'евро/дка': RENT_UNIT_EUR,
    'евро/декар': RENT_UNIT_EUR,
    'eur/дка': RENT_UNIT_EUR,
    'eur/dka': RENT_UNIT_EUR,
    'eur/dca': RENT_UNIT_EUR,
    'euro/dka': RENT_UNIT_EUR,
    // money per decare — LEVA (every lease recorded before 2026-10-31)
    'лв/дка': RENT_UNIT_LEVA,
    'лв./дка': RENT_UNIT_LEVA,
    'лв/декар': RENT_UNIT_LEVA,
    'лева/дка': RENT_UNIT_LEVA,
    'lv/dka': RENT_UNIT_LEVA,
    'lv/dca': RENT_UNIT_LEVA,
    'bgn/dka': RENT_UNIT_LEVA,
    'bgn/dca': RENT_UNIT_LEVA,
    // produce per decare
    'кг/дка': RENT_UNIT_KG,
    'кг./дка': RENT_UNIT_KG,
    'кг/декар': RENT_UNIT_KG,
    'килограма/дка': RENT_UNIT_KG,
    'kg/dka': RENT_UNIT_KG,
    'kg/dca': RENT_UNIT_KG,
};

/**
 * Fold a free-text rent unit to its canonical form. Unknown units are kept
 * verbatim (trimmed) so an operator's own convention still groups with itself.
 */
export function canonicalRentUnit(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const key = trimmed.toLowerCase().replace(/\s+/g, '');
    return ALIASES[key] ?? trimmed;
}

/**
 * The suffix a TOTAL in this unit carries: „лв/дка" → „лв" (a season total is
 * money, not money-per-decare). Falls back to the unit itself when it isn't a
 * rate, and to '' when there's no unit at all.
 */
export function rentTotalSuffix(unit: string | null | undefined): string {
    if (!unit) return '';
    return amountUnitOf(unit) || unit;
}
