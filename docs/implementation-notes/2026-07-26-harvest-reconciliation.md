# 2026-07-26 — Harvest reconciliation (yield ↔ stock ↔ crop plan)

**Commit:** _(this PR)_

## The problem

A harvest could be recorded in three places that never reconciled:

| Surface | Wrote | Did not write |
|---|---|---|
| `/grain/yield` | `YieldRecord` (tonnes, moisture, area) | no inventory at all |
| journal `HARVEST` | `InventoryLot` + `HARVEST_IN` via `recordHarvestLot` | no `YieldRecord` |
| crop-plan progress | — | read `LogPlanting` only, never a `YieldRecord` |

`yieldRecord.create` appeared in exactly one production file, and nothing
linked the three. The org grain dashboard then rendered `totalYieldTonnes`
beside `binStoredTonnes` as unrelated peers, so:

- a journal-only tenant showed **0 production with full bins**,
- a yield-page-only tenant showed **tonnes with empty bins**,
- a tenant doing both showed **the same physical grain twice**, and nothing
  in the schema could say so.

Separately, `YieldRecord.plantingId` was written by the yield form and read
by nothing: a farmer who recorded 90 t against a planting still saw an
unrealised HARVEST milestone on the planning board.

## The fork

Model **(a) ONE ENTRY, TWO EFFECTS**, in the direction **journal HARVEST →
optional YieldRecord**, plus the explicit link that makes the overlap
visible.

**Why that direction, and not yield → mint the lot.** `recordHarvestLot`
requires a `logEntryId` as its provenance anchor — it is written onto
`StockTransaction.logEntryId` and `LotLink.logEntryId`, and the traceability
walk (seed-lot → field → harvest-lot) threads through it. Driving it from
the yield page therefore means either fabricating a HARVEST journal entry
the farmer never wrote, or widening the ledger's provenance model to accept
a second kind of anchor. Both add a **second writer of stock**, which the
brief's PRESERVE list rules out. Going journal → yield adds none:
`recordHarvestLot` stays the only thing that writes the ledger, and the new
code path only ever INSERTs a `YieldRecord`.

**Why not (b) link + reconciliation view alone.** (b) was allowed, and the
link half of it is here (it is what makes the dashboard honest). What (b)
does not do is stop the double entry: the farmer still types the harvest
twice. Since the acceptance criterion is "records a harvest once and both
the yield figure and the stock reflect it", (a) is the stronger answer, and
the link comes along with it for free.

**Why not (c) one owner.** Making one surface the sole recorder means
removing a path tenants already use, and the two surfaces genuinely serve
different people: the journal is the operational log (offline-capable, filled
in by whoever is on the machine), `/grain/yield` is the commercial record
(moisture, harvested area, valuation notes). Neither can absorb the other's
inputs without becoming worse at its own job.

## Design

```
JournalEntryModal (HARVEST)
  ├─ item + quantity + lot code            → recordHarvestLot  → InventoryLot + HARVEST_IN
  └─ ☑ "Also record as yield — 42.5 t"     → recordYieldFromHarvest → YieldRecord
                                                   │
                              YieldRecord.logEntryId ─┘  (the reconciliation link)
```

Both effects run in the **same** tenant transaction, so the stock lot and
the production figure commit together or not at all.

**The tonnage is derived, never assumed.** `convert(quantity, unitKey, 't')`
over the WEIGHT dimension (base grams), gated by `canConvert(unitKey, 't')`.
A counted product (`each` — crates of tomatoes) or a volume (`l`) is
**refused**: the function returns `note: 'unit_not_mass'` and no record. The
UI applies the same rule before offering the checkbox, so the refusal is a
backstop rather than a surprise. This is the difference between a production
total and a fabricated one — `kg → L` can never silently succeed, because
`convert` throws across dimensions.

**`areaHa` and `moisturePct` stay NULL** on a journal-minted record. The
journal states neither. Defaulting `areaHa` to the parcel's total area would
silently assume a whole-field harvest and understate t/ha whenever only part
of the field was cut, so "unknown" is the honest value — `toDto` already
renders `tPerHa` as null for it.

**Idempotency** is a unique index on `(logEntryId, tenantId)`, not a
convention: the journal create path is offline-replayable, and production
must not double-count on redelivery. The column is nullable, so NULLS
DISTINCT leaves the many yields typed on `/grain/yield` free to coexist.

**The dashboard tells the truth two ways.** The field docs on
`PortfolioGrainTotals` now state what each tonnage measures — production
across every recorded season vs stock on hand right now — and say plainly
that they are not additive. Alongside them, `yieldAlsoInStoreTonnes`
(Σ `grossTonnes` where `logEntryId IS NOT NULL`) reports the actual overlap,
computed as a second DB aggregate rather than in memory. The KPI tile reads
"Production recorded — across all farms · 200 t of it also in store".

Netting the two was rejected: they are not a quantity and its remainder.
Grain harvested and sold off the field never enters store, and purchased
grain enters store without being grown, so a subtraction would invent a
number that describes nothing.

## Files

| File | Role |
|---|---|
| `prisma/schema/grain.prisma` | `YieldRecord.logEntryId` + tenant-scoped composite FK + `@@unique([logEntryId, tenantId])` |
| `prisma/schema/journal.prisma` | `LogEntry.yieldRecord` back-reference (one-to-one) |
| `prisma/migrations/20260726090000_yield_record_harvest_link/` | column, unique index, FK with `ON DELETE SET NULL` |
| `src/app-layer/usecases/yield-record.ts` | `recordYieldFromHarvest` — GRAIN-gated, dimension-checked, idempotent |
| `src/app-layer/usecases/journal.ts` | calls it inside the harvest transaction; emits the automation event post-commit |
| `src/app-layer/usecases/crop-planning.ts` | `getCropPlanProgress` folds `YieldRecord` in as a HARVEST actual |
| `src/app-layer/usecases/portfolio-grain.ts` | overlap aggregate + honest field documentation |
| `src/app-layer/automation/event-contracts.ts` | `HARVEST_YIELD_RECORDED` gains optional `source` / `logEntryId` |
| `src/lib/schemas/index.ts` | `recordYield` on the harvest payload |
| `src/app/t/[tenantSlug]/(app)/journal/{page,JournalClient,JournalEntryModal}.tsx` | server-resolved `grainEnabled` → the opt-in checkbox with its derived tonnage |
| `src/app/org/[orgSlug]/(app)/grain/PortfolioGrainClient.tsx` | KPI labels that distinguish production from stock |

## Decisions

- **The checkbox is pre-checked, and that is not the same as silent.** It is
  visible, labelled with the exact tonnage it will record, and gated on the
  GRAIN module. Pre-checking it is what actually fixes the journal-only
  tenant's zero-production dashboard; leaving it unchecked by default would
  have shipped a mechanism almost nobody discovers.

- **`grainEnabled` is resolved server-side and passed down as a prop.** The
  only client-readable module endpoint is `/admin/modules`, and a
  mechanisator authoring a harvest is not an admin. `getEnabledModules(ctx)`
  in `page.tsx` avoids both a new endpoint and a reliance on some other
  page's SWR cache being warm.

- **Module gating is enforced twice.** The UI gate is the one users meet;
  `recordYieldFromHarvest`'s own `resolveEnabledModules` check is the one an
  API client meets. It runs before any other read, so a tenant without GRAIN
  is not even queried for the item.

- **The function returns a `note` instead of throwing.** A harvest of a
  counted crop must still succeed as a journal entry and a stock lot; only
  the optional production side declines. Throwing would let a yield concern
  fail an inventory write.

- **`ON DELETE SET NULL` on the link.** Deleting a journal entry must not
  delete the production figure — the tonnage was still harvested. The yield
  row survives as an unlinked record, which is exactly what the dashboard's
  overlap figure should then stop counting.

- **The crop-plan fold is earliest-wins across both sources.** A planting
  harvested via a journal link *and* a yield record reports one date, not two
  competing ones. A yield record with a null `harvestedAt` is ignored rather
  than back-filled from `createdAt`, which would fabricate a milestone date.

- **The automation event gained optional fields rather than a new event.**
  A rule watching production should not have to subscribe twice to see every
  harvest; `source` / `logEntryId` let a rule that cares tell the surfaces
  apart, and one that does not stays unchanged.
