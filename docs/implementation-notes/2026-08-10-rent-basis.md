# 2026-08-10 — Rent basis (`ParcelLease` rent → comparable per-hectare figure)

**Commit:** `<pending>` feat(grain): add rent-basis module for comparable per-hectare lease rent

## Design

New pure module `src/lib/grain/rent-basis.ts`, one function:

```
resolveRentBasis(lease: { rentAmount, rentUnit?, rentUnitRaw? }, areaHa) → RentBasisResult
```

It builds directly on the existing `@/lib/agro/rent-units` canonicaliser
rather than re-parsing free text — that module already folds operator
aliases (`лв./дка`, `lv/dka`, `bgn/dca`, `килограма/дка`, …) to exactly
two canonical forms:

```
RENT_UNIT_LEVA = 'лв/дка'   — MONEY per decare
RENT_UNIT_KG   = 'кг/дка'   — a MASS (grain) per decare
```

Both canonical units are already per-decare RATES. Converting a rate to a
per-hectare basis is a pure unit conversion (`× DCA_PER_HA`, imported from
`@/lib/agro/rate-calc` — never a local `10`); it does not depend on the
parcel's actual size. `areaHa` is nonetheless a REQUIRED, validated input:
a missing/non-positive area makes "the per-hectare figure for this parcel"
an unanswerable question, mirroring the existing guard style in
`tonnesPerHectare` (`@/lib/grain/moisture`) and `fillFractionFor`
(`@/lib/grain/bin-fill`) — both treat missing/zero area as *undefined*,
not *not needed*.

The return type is a discriminated union, never a bare number:

```ts
type RentBasisResult =
  | { resolved: true;  kind: 'money';   perHa: number }
  | { resolved: true;  kind: 'produce'; kgPerHa: number }
  | { resolved: false; raw: string | null; reason: string };
```

`kind` carries the dimension in the FIELD NAME, not just a label next to
the number — `perHa` only exists on the money branch, `kgPerHa` only on
the produce branch. A caller that reads `result.perHa` without checking
`result.kind === 'money'` first fails to compile (verified in
`tests/unit/rent-basis.test.ts` with a real `@ts-expect-error` that `tsc
--noEmit` enforces, not just a runtime assertion). This is the direct fix
for the failure mode the task called out: a `{ resolved: true; perHa }`
shape would let a caller sum лв and кг without ever noticing, which
`rent-units.ts` already documents as "dimensionally meaningless."

Unresolved cases (`resolved: false`) always carry `raw` (the exact text
that failed to canonicalize, or `null` when no unit was recorded at all)
and a `reason` string naming it, so a caller can log or surface *why* a
lease didn't resolve instead of a silent gap.

## Files

| File | Role |
|---|---|
| `src/lib/grain/rent-basis.ts` | New pure module — `resolveRentBasis` + `RentBasisLease` / `RentBasisResult` types. No Prisma, no I/O, no React. |
| `tests/unit/rent-basis.test.ts` | 21 executing unit tests over every branch: money per-dca, produce per-dca, dimension non-interchangeability (including a compile-time `@ts-expect-error` proof), genuine-zero-vs-unresolved, null amount, null/zero/negative areaHa, a per-ha raw form, an absolute-per-parcel raw form, a wholly unrecognised unit, no-unit-at-all, and `rentUnit` taking precedence over `rentUnitRaw`. |

## Decisions

- **Per-hectare and absolute-per-parcel raw forms are left UNRESOLVED, not
  parsed.** Neither exists in the canonical set today (only two per-decare
  forms do) — they can only arrive as a `rentUnitRaw` value
  `canonicalRentUnit()` doesn't recognise (e.g. `"150 лв/ха"`, `"5000 лв за
  целия имот"`). This module does not build a second free-text parser for
  them (the brief called this out explicitly as the failure class to
  avoid: two parsers drift). It reports `resolved: false` with the raw
  text in the reason. **The alternative — extending `rent-units.ts`'s
  canonical set to include per-ha and absolute forms — would change
  GROUPING in the existing rent roll** (`src/app-layer/usecases/rent-roll.ts`,
  `src/app/t/[tenantSlug]/(app)/rent/RentClient.tsx`,
  `src/app/api/t/[tenantSlug]/reports/rent-roll/route.ts` all group leases
  by `rentUnit` directly), so that call is left to a future PR that can
  weigh that blast radius deliberately, not made silently here.
- **`areaHa` is a required, validated precondition even though the
  canonical-unit math doesn't use its value.** лв/дка and кг/дка are rates
  that scale identically regardless of the specific parcel, so
  algebraically `perHa = rentAmount × DCA_PER_HA` for any valid area. The
  guard exists anyway, for two reasons: (1) it matches the codebase's
  existing convention that "a per-hectare figure" presupposes a known,
  positive area (`tonnesPerHectare`, `fillFractionFor`), and (2) it keeps
  the contract stable if a future per-hectare or absolute-per-parcel raw
  unit is added, since THAT conversion path would need a real division by
  area. Covered by a dedicated test asserting the resolved money figure is
  identical for a 1 ha and a 500 ha parcel (area-independence), plus
  separate tests for null/zero/negative area (all unresolved).
- **No currency field, no FX.** `ParcelLease` has no currency column.
  `money` results are implicitly denominated in whatever single currency
  the tenant quotes rent in (BGN in practice). `@/lib/grain/currencies.ts`
  was checked and does not apply — it backs `Contract.priceCurrency`, an
  actual column on a different model (grain sale contracts); lease rent
  has no equivalent column to pick from. A caller comparing figures across
  tenants is responsible for its own currency grouping.
- **Zero rent is a real, resolved value.** `rentAmount: 0` with a valid
  canonical unit and area resolves to `{ resolved: true, kind: 'money',
  perHa: 0 }` — distinct from `resolved: false`, which is reserved for "we
  don't know the dimension/amount/area," not "the amount is zero."
- **`rentUnit` (already canonical, written by `parcel-lease.ts` via
  `canonicalRentUnit(rentUnitRaw)`) takes precedence over `rentUnitRaw`**
  when both are present, since it's the authoritative grouping key the
  rent roll already relies on; `rentUnitRaw` is only consulted as a
  fallback when `rentUnit` is blank.
