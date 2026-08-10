# 2026-08-10 — Planned (expected) yield on Planting

**Commit:** _(pending — see PR)_

## Design

Adds a grower-entered expectation to `Planting`: how much yield a
succession is expected to produce. Three pieces:

1. **Storage.** `Planting.plannedYieldKgPerHa Decimal? @db.Decimal(10,2)`
   — nullable, stored PER HECTARE, same area basis as every other stored
   figure in this schema (`Parcel.areaHa`, `YieldRecord.areaHa`,
   `CropPlan.targetAreaM2` in m²). Additive migration, no backfill, no
   rollback inverse script (plain `ADD COLUMN`).

2. **Unit boundary.** Bulgarian growers think in декари and this product
   already shows кг/дка everywhere else (`ParcelDetailSheet`'s default
   rate unit). `src/lib/agro/rate-calc.ts` owned the ha→dca direction
   (`haToDca`, `DCA_PER_HA = 10`) but never the inverse — `dcaToHa` is
   new. Both directions get used for this feature, but for a RATE
   (not an area): a кг/дка figure converts to кг/ha by the SAME ×10
   factor as an area does (`haToDca`), and кг/ha converts back to
   кг/дка by the same ÷10 (`dcaToHa`). The arithmetic is identical
   whether the value being scaled is an area or a per-area rate — only
   the caller's intent differs — so reusing the existing pair keeps the
   factor of 10 in exactly one place instead of hand-rolling a second
   `× 10` at the UI boundary.

3. **UI + API.** `PlannedYieldCell` in `PlantingBoard.tsx` (the
   succession board's `<DataTable>`, `/planning/:cropPlanId`) is a
   per-row popover — a `NumberStepper` labelled "Planned yield
   (кг/дка)", Save, and Clear (writes an explicit `null`, never `0`).
   `PATCH /api/t/:slug/planning/plantings/:plantingId` → `updatePlanting`
   usecase. The wire format is ALWAYS per hectare; conversion happens
   only inside `PlannedYieldCell`, never on the server.

4. **Null-is-not-zero.** The field is nullable on purpose — an
   unestimated succession is a different claim from "expect nothing",
   mirroring `YieldRecord.netTonnesStd` (null when `moisturePct` is
   unmeasured). `updatePlanting` never coerces `null` to `0`.
   `getCropPlanProgress` (the plan-vs-actual read every consumer of
   Planting rows already goes through) now also returns
   `plannedYieldKgPerHa` per row, via the same `dec()` helper used
   for every other Prisma Decimal in this file — `null` in, `null`
   out. `src/lib/planning/planned-yield.ts::summarizePlannedYield` is
   the downstream aggregator: it sums `plannedYieldKgPerHa × areaHa`
   over a set of plantings but EXCLUDES (never zeroes) any row with no
   rate or no area, returning `excludedPlantingIds` explicitly so a
   caller can render "N successions have no yield estimate yet"
   instead of a total that quietly undercounts. A real `0` estimate
   (the grower's own claim of "expect nothing") is included, not
   excluded — only `null`/non-finite is excluded.

## Files

| File | Role |
|---|---|
| `prisma/schema/planning.prisma` | `Planting.plannedYieldKgPerHa` field + schema doc |
| `prisma/migrations/20260810090000_planting_planned_yield/migration.sql` | Additive `ALTER TABLE … ADD COLUMN` |
| `src/lib/agro/rate-calc.ts` | New `dcaToHa` (inverse of `haToDca`) |
| `src/app-layer/usecases/crop-planning.ts` | New `updatePlanting` usecase; `getCropPlanProgress` now selects + returns `areaM2` / `plannedYieldKgPerHa` per row |
| `src/app/api/t/[tenantSlug]/planning/plantings/[plantingId]/route.ts` | New `PATCH` route (wire format = per hectare) |
| `src/lib/planning/planned-yield.ts` | New pure `summarizePlannedYield` — the null-is-not-zero aggregator |
| `src/app/t/[tenantSlug]/(app)/planning/[cropPlanId]/PlantingBoard.tsx` | `PlannedYieldCell` — the кг/дка entry surface, new table column |
| `messages/en.json` / `messages/bg.json` | `planning.board.plannedYield.*` — real Bulgarian, distinct namespace |
| `tests/unit/rate-calc.test.ts` | `dcaToHa` — fixed known values + round-trip (both directions) |
| `tests/unit/planning/planned-yield.test.ts` | `summarizePlannedYield` — null-exclusion, zero-inclusion, all-excluded, empty-input |
| `tests/unit/crop-planning.test.ts` | `updatePlanting` (write gate, null write, not-found); `getCropPlanProgress` propagation + a downstream `summarizePlannedYield` pipe-through |
| `tests/guards/no-hardcoded-ui-strings.test.ts` | Baseline ratcheted 20 → 17 (measured; this PR added zero new hard-coded strings) |

## Decisions

- **Reused `haToDca`/`dcaToHa` for a RATE conversion, not just an AREA
  conversion.** The pair's names read as area-only, but the underlying
  operation is a pure `× DCA_PER_HA` / `÷ DCA_PER_HA` scalar, and a
  per-decare rate converts to a per-hectare rate by the identical
  factor a decare-count converts to a hectare-count. Introducing a
  second, rate-flavoured helper (`kgPerDcaToKgPerHa`) would have
  duplicated the constant `DCA_PER_HA` is meant to own exclusively —
  exactly the "second stored/derived unit" failure mode called out in
  the task brief. The call sites in `PlannedYieldCell` carry a comment
  pointing back at `dcaToHa`'s doc for readers who trip on the
  name/usage mismatch.

- **Wire format is per-hectare, not per-decare.** The PATCH body and
  the `getCropPlanProgress` read both speak `plannedYieldKgPerHa`
  (stored basis). Decare conversion is UI-presentation only, matching
  how `rate-calc.ts` already treats decares as "a display convention,"
  per the task brief's units contract. This also means a future
  non-Bulgarian-locale UI could enter/display кг/ha directly with zero
  API changes.

- **`getCropPlanProgress` grew two fields instead of gaining a new
  wrapping response shape.** An earlier design considered returning
  `{ rows, expectedYield }` from `getCropPlanProgress` directly, but
  that function's return type (`PlantingProgressRow[]`) is consumed
  as a bare array by 8+ existing tests, the API route
  (`{ plan, progress }`), and `PlantingBoard.tsx`'s `progressSWR.data
  ?.progress`. Changing its shape would have forced unrelated changes
  across all three call sites for a feature that doesn't need it yet.
  Instead, `plannedYieldKgPerHa`/`areaM2` were added AS FIELDS on each
  row (additive, breaks nothing), and `summarizePlannedYield` is a
  free-standing pure function any caller — today just a
  `crop-planning.test.ts` integration-style test, tomorrow perhaps a
  plan-summary header — can pipe the existing row array through
  without a second DB round trip.

- **No downstream UI surfaces `summarizePlannedYield`'s total yet.**
  The task scope was the field + the entry surface + the invariant,
  not a farm-yield-forecast feature. The aggregator exists, is real,
  and is tested, but wiring it into a visible "expected yield this
  season" figure is left for the calculator PR the task brief
  anticipates ("a downstream calculator gets crop and area for free
  once this field exists").

- **`npx prisma format` reformats the WHOLE schema folder, not just
  the touched file** — it silently realigned ~430 lines across 11
  unrelated `.prisma` files (column-padding drift that predates this
  PR). Those files were reverted; only `Planting`'s own field block
  was reformatted (by hand, matching Prisma's real column-alignment
  rule: name-column width = longest field name + 1, independently of
  the type column), so the diff stays scoped to the model that
  actually changed.
