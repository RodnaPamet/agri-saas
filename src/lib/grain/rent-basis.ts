/**
 * Rent basis — resolving a `ParcelLease`'s rent to a comparable ANNUAL
 * PER-HECTARE figure.
 *
 * ─── Why this module exists ─────────────────────────────────────────
 *
 * `ParcelLease.rentAmount` is a rate quoted PER DECARE (the Bulgarian
 * standard), so two leases are only comparable once put on the same area
 * basis. The rent roll (`src/app-layer/usecases/rent-roll.ts`) already does
 * this for its own totals, grouped per (lessor × unit); this module is the
 * single reusable per-lease conversion so other surfaces (a per-parcel rent
 * comparison, a lessor negotiation view, …) don't grow a second copy of the
 * arithmetic.
 *
 * ─── Money and produce are NOT the same dimension ───────────────────
 *
 * `@/lib/agro/rent-units` canonicalises free-text rent units to exactly two
 * forms, and BOTH are per-decare rates:
 *
 *   RENT_UNIT_LEVA = 'лв/дка'   — MONEY per decare
 *   RENT_UNIT_KG   = 'кг/дка'   — a MASS (grain) per decare
 *
 * Bulgarian farm rent is commonly paid in produce, not cash. A result shape
 * that puts both under one `perHa: number` field would let a caller sum a
 * currency and a mass without noticing — the exact bug `rent-units.ts`
 * calls "dimensionally meaningless". So `resolveRentBasis` returns a
 * DISCRIMINATED UNION keyed on `kind`: the money branch carries `perHa`,
 * the produce branch carries `kgPerHa`, and TypeScript refuses to compile
 * code that reads one field without first checking which branch it is in
 * (see the `kind` narrowing note on `RentBasisResult` below). Converting
 * кг/дка into money needs a grain price, which is a PRICING decision that
 * belongs to a downstream calculator — this module only reports dimension
 * and magnitude, never invents a price.
 *
 * ─── Why `areaHa` is REQUIRED even though the rate math doesn't use it ──
 *
 * лв/дка and кг/дка are RATES: the same figure applies to every decare, so
 * converting a per-decare rate to a per-hectare rate is a pure unit
 * conversion (× `DCA_PER_HA`) that does not depend on how large the actual
 * parcel is. Nonetheless `areaHa` is a REQUIRED, validated input: "the
 * annual per-hectare figure for this lease" is a statement about a
 * specific parcel, and a parcel with an unknown or non-positive area is
 * not one this module can make that statement about. This mirrors the
 * existing product convention in `@/lib/grain/moisture`
 * (`tonnesPerHectare`) and `@/lib/grain/bin-fill` (`fillFractionFor`),
 * both of which treat a missing/non-positive area as undefined rather than
 * "not needed". A future per-hectare or absolute-per-parcel raw unit WOULD
 * need `areaHa` for real division, so keeping the guard unconditional also
 * keeps the contract stable if that extension lands.
 *
 * ─── Per-hectare and absolute-per-parcel raw forms ──────────────────
 *
 * Neither exists in the canonical set today (see `rent-units.ts`) — they
 * can only arrive as a `rentUnitRaw` value `canonicalRentUnit()` doesn't
 * recognise (e.g. "150 лв/ха", "500 лв за целия имот"). This module does
 * NOT parse those forms; it reports them `resolved: false` with a reason
 * naming the raw text. Building a second free-text parser here would drift
 * from `canonicalRentUnit()` — the one and only place that logic lives.
 * Extending `rent-units.ts`'s canonical set is the alternative, but it
 * changes GROUPING in the existing rent roll (`RentClient.tsx` /
 * `reports/rent-roll/route.ts`), so that decision is deliberately left to
 * a caller who can weigh that blast radius, not made silently here.
 *
 * ─── Currency ────────────────────────────────────────────────────────
 *
 * `ParcelLease` carries NO currency column, and this module does not
 * invent one or perform FX conversion. Every `money` result is implicitly
 * denominated in whatever single currency the tenant operates rent in
 * (BGN in practice — Bulgarian rent is quoted in „лв"). A caller comparing
 * `perHa` figures across tenants/currencies is responsible for grouping by
 * currency itself. `@/lib/grain/currencies.ts` was checked and does not
 * apply here: it is `Contract.priceCurrency`'s picker for grain SALE
 * contracts, a different model with an actual currency column — lease rent
 * has no such column to pick from.
 *
 * Pure, synchronous, no Prisma/I-O/React — safe to unit test directly and
 * to call from a usecase, a report, or a future UI comparison view alike.
 */

import { canonicalRentUnit, RENT_UNIT_KG, RENT_UNIT_LEVA } from '@/lib/agro/rent-units';
import { DCA_PER_HA } from '@/lib/agro/rate-calc';

/** The `ParcelLease` fields this module needs — a subset, not the full row. */
export interface RentBasisLease {
    /** `ParcelLease.rentAmount` — leva or kg PER DECARE. `null`/`undefined` = not priced. */
    rentAmount: number | null | undefined;
    /** `ParcelLease.rentUnit` — the canonical unit, when already resolved at write time. */
    rentUnit?: string | null;
    /** `ParcelLease.rentUnitRaw` — what the operator actually typed. */
    rentUnitRaw?: string | null;
}

/**
 * The resolved rent basis, or an honest refusal to resolve one.
 *
 * A discriminated union on `resolved` (and, when resolved, on `kind`) —
 * NEVER a bare `perHa: number`. A consumer must check `resolved` before
 * touching either money or produce fields, and must check `kind` before
 * reading `perHa` vs `kgPerHa`: TypeScript narrows `RentBasisResult` to
 * exactly one arm per check, so `result.kind === 'money' ? result.kgPerHa
 * : …` fails to compile — there is no accidental cross-dimension read.
 */
export type RentBasisResult =
    | { resolved: true; kind: 'money'; perHa: number }
    | { resolved: true; kind: 'produce'; kgPerHa: number }
    | { resolved: false; raw: string | null; reason: string };

/** Prefer the already-canonical `rentUnit`; fall back to the operator's raw text. */
function pickRawUnit(
    rentUnit: string | null | undefined,
    rentUnitRaw: string | null | undefined,
): string | null {
    const primary = rentUnit?.trim();
    if (primary) return primary;
    const fallback = rentUnitRaw?.trim();
    return fallback ? fallback : null;
}

/**
 * Resolve a lease's rent to an annual per-hectare figure, carrying its
 * dimension (money vs produce) — or an honest `resolved: false` when the
 * unit, amount, or parcel area doesn't support one.
 *
 * @param lease  The lease's rent fields (`rentAmount` + `rentUnit`/`rentUnitRaw`).
 * @param areaHa The PARCEL's area in hectares (`Parcel.areaHa`) — NOT the
 *               lease's own field, since a lease has none; callers read it
 *               off the related `Parcel` row.
 */
export function resolveRentBasis(lease: RentBasisLease, areaHa: number | null | undefined): RentBasisResult {
    const rawUnit = pickRawUnit(lease.rentUnit, lease.rentUnitRaw);
    const canonical = canonicalRentUnit(rawUnit);

    if (canonical == null) {
        return {
            resolved: false,
            raw: null,
            reason: 'No rent unit recorded for this lease.',
        };
    }

    if (canonical !== RENT_UNIT_LEVA && canonical !== RENT_UNIT_KG) {
        return {
            resolved: false,
            raw: rawUnit,
            reason:
                `Rent unit "${rawUnit}" is not a canonical per-decare rate ` +
                `(${RENT_UNIT_LEVA} or ${RENT_UNIT_KG}) — it may be a per-hectare or ` +
                'absolute-per-parcel figure, which this module does not convert.',
        };
    }

    if (lease.rentAmount == null || !Number.isFinite(lease.rentAmount)) {
        return {
            resolved: false,
            raw: rawUnit,
            reason: 'Rent amount is not set for this lease.',
        };
    }

    if (areaHa == null || !Number.isFinite(areaHa) || areaHa <= 0) {
        return {
            resolved: false,
            raw: rawUnit,
            reason: 'Parcel area is unknown or non-positive, so no per-hectare figure can be stated.',
        };
    }

    // лв/дка and кг/дка are RATES: one hectare is DCA_PER_HA decares, and
    // the same per-decare rate applies uniformly across every decare in
    // it, so the per-hectare rate is a straight unit conversion. This does
    // NOT depend on the parcel's actual size (see the module docblock for
    // why `areaHa` is still a required, validated precondition above).
    const perHectare = lease.rentAmount * DCA_PER_HA;

    if (canonical === RENT_UNIT_LEVA) {
        return { resolved: true, kind: 'money', perHa: perHectare };
    }
    return { resolved: true, kind: 'produce', kgPerHa: perHectare };
}
