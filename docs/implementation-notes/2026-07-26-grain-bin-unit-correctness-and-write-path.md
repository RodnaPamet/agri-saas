# 2026-07-26 — Grain bin fill: unit correctness, the missing write path, and the 500-lot cap

**Commit:** `<pending> fix(grain): convert bin fill to tonnes, add the lot→bin write path, drop the 500-lot cap`

Closes #388, #389, #390.

## Problem

Three defects that compounded into one broken feature: a bin's fill was
arithmetically wrong, nothing could put grain in a bin in the first place, and
past 500 lots the numbers changed between calls.

**Units.** `Location.capacityTonnes` is tonnes. `InventoryLot.quantityOnHand` is
in the lot's own unit, and `Item.defaultUnitId` is user-chosen with no measure
constraint — `kg`, `g`, `t` are three distinct `Unit` rows. `InventoryLot.unitId`
forbids mixed units *within* a lot; nothing forbids a bin holding a kg lot and a
t lot side by side. The code summed raw quantities and divided, with the tonnes
assumption recorded only as a comment. The shipped demo data proves the cost: 320
kg in a 500 t bin rendered **64%** for a bin **0.064%** full. The same sum, named
`binStoredTonnes`, fed the cross-tenant executive summary.

**No writer.** `InventoryLot.locationId` is the only thing tying stock to a bin,
and no UI ever set it. `createLot` already threaded `input.locationId`, but the
client payload omitted it; the journal harvest flow omitted it although the
server schema accepted *and used* it; and no PATCH/PUT route existed anywhere
under `inventory/` (`lots/[lotId]/route.ts` exported GET only). Only
`seed-demo.ts` set it — so outside demo data every bin read as empty.

**The cap.** `take: 500` sat on the ONE lot query covering *every* bin, with no
`orderBy`. Past 500 produce lots farm-wide, arbitrary bins under-reported, and
because the 500 rows Postgres returns without an `orderBy` aren't stable, they
under-reported *differently on each call*.

The sequencing mattered: fixing the writer alone would have turned a page of
honest zeros into confidently wrong numbers.

## Design

**One query change fixes two flags.** Grouping by `(locationId, unitId)` instead
of fetching rows makes each lot's unit available for conversion *and* bounds the
result by `bins × units` rather than by lot count. The `take: 500` doesn't need
raising — it stops being needed. `_count._all` supplies `lotCount` without
reading rows. Still N+1-free: one aggregate for the whole list plus one lookup of
the handful of `Unit` rows involved.

**Conversion, not filtering.** `src/lib/grain/bin-fill.ts` is a new pure module —
the single definition of "how full is this bin", shared by `listBins`, `getBin`
and the org summary. It converts through the existing
`src/lib/units/unit-conversion.ts` (exact integer bases, so kg→t carries no float
drift; guardrail-locked already). Of the three options offered:

- **(a) convert** — chosen for WEIGHT units. A farmer whose produce defaults to
  kg is the common case; filtering to tonnes would render their bins permanently
  empty, which is a different wrong answer.
- **(c) `fillPct: null` + `mixedUnits`** — chosen for units with no tonnage
  (`each`, `l`). "40 ea of seed potatoes" has no defensible tonnage, and a fill
  bar that quietly omits part of the contents is the same class of lie as the
  1000× error. The quantities are reported separately (`unconvertible`) so the
  page can show them without pretending they're tonnes.
- **(b) filter to tonnes** — rejected: silently discards real stock.

Note the prompt's option (a) named a `Unit.measure/factor`. There is no factor
column on `Unit`; the factor table lives in the conversion module, so no schema
change was needed.

**The writer is a lot-row update, not ledger activity.** A location change moves
no quantity, creates nothing and consumes nothing — so it is a `locationId`
write, audited, and `InventoryRepository.updateLotLocation` writes that column
*alone*. `quantityOnHand` is a denormalised ledger sum; a position change going
near it would corrupt stock silently. A test asserts the UPDATE payload's key set
is exactly `['locationId']` rather than trusting the comment.

## Files

| File | Role |
| --- | --- |
| `src/lib/grain/bin-fill.ts` | **New.** Pure fill arithmetic: per-unit conversion to tonnes, the unconvertible breakdown, and `fillFractionFor` (keeps the divide-by-zero guard). |
| `src/app-layer/usecases/grain-bin.ts` | `listBins`/`getBin` share one `storedTotalsForBins` grouped aggregate; DTO gains `storedTonnes`/`mixedUnits`/`unconvertible`, drops the misleading `storedQuantity`. |
| `src/app-layer/usecases/portfolio-grain.ts` | Same conversion on the exec-summary path. |
| `src/app-layer/usecases/inventory.ts` | **New** `updateLotLocation` — kind-guarded, audited, location-only. |
| `src/app-layer/repositories/InventoryRepository.ts` | **New** `updateLotLocation` — writes `locationId` and nothing else. |
| `src/app-layer/repositories/LocationRepository.ts` | `LocationFilters.kind` so callers can ask for storage rows vs growing areas. |
| `src/app/api/.../inventory/lots/[lotId]/route.ts` | **New** PATCH (the first mutating lot-row route). |
| `src/app/api/.../locations/route.ts` | `?kind=BIN,STORAGE` passthrough. |
| `InventoryClient.tsx` | Bin picker on lot creation + a move control on the lot detail. |
| `JournalEntryModal.tsx` | Harvest destination picker (separate read from the field-block picker). |
| `grain.dto.ts`, `BinsClient.tsx`, `messages/{en,bg}.json` | Contract + render + copy. |

## Decisions

- **`fillPct` stays a fraction, not a percentage.** 0.64 means 64%, preserving
  the existing contract so the progress bar's scale is untouched. The
  over-100% clamp is deliberately left alone — that's a separate flagged UI
  honesty issue, not this change's business.

- **Unconvertible stock suppresses the percentage rather than partially
  filling it.** The alternative — computing a percentage from only the
  convertible part — reads as precise while being incomplete, which is how the
  original bug survived review.

- **A missing `Unit` row counts as unconvertible, not zero.** Silently dropping
  stock whose unit can't be resolved is exactly how the original arithmetic
  looked plausible.

- **The exec summary excludes unconvertible stock without a new field.** It is a
  *tonnes* metric, so stock with no tonnage contributes nothing; the per-bin
  detail is surfaced on the bins page, where it belongs. Adding a portfolio DTO
  field would ripple into the org dashboard for no decision-relevant gain.

- **Audit verb is `UPDATE` + `changedFields: ['locationId']`, not a bespoke
  `LOT_MOVED`.** The vocabulary is dominated by CREATE/UPDATE/SOFT_DELETE (67
  uses vs a scatter of one-offs), and the existing one-off verbs are a known
  wart being tracked separately.

- **A same-location PATCH is a legal no-op that writes no audit row.** An edit
  form resubmitting an unchanged value must not manufacture an audit trail
  claiming the lot moved.

- **The storage picker filters by `kind` explicitly rather than relying on
  `/locations` defaults.** A `Location` is a growing field or a storage row
  depending on `kind`; produce receipted against a FIELD would be invisible to
  every bin view while still counting as stock. The new `?kind=` param is also
  the seam the fields-list filtering needs.
