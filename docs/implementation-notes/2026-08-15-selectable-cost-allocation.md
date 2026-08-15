# 2026-08-15 — Selectable cost allocation

**Commit:** `<sha> feat(grain): the farmer chooses which land a cost spreads across`

## Design

A cost entry now carries a BASIS — `CostEntry.allocationBasis`, one of
`TARGET | HOLDING | PARCEL_SUBSET` — that says which land the calculator
spreads it over. `TARGET` is the default and is the code path the module
already had, so nothing written before this column moves by a cent.

```
CostEntry.allocationBasis
        │
        ├── TARGET ─────────► unchanged: plantingId → that planting,
        │                     seasonId → that season's plantings,
        │                     otherwise pro-rata over every known-commodity
        │                     planting in scope
        │
        ├── HOLDING ────────► every live Parcel of the tenant
        └── PARCEL_SUBSET ──► the parcels in CostEntryAllocationParcel
                                        │
                                        ▼
                              spreadOverParcels(amount, parcels, targets)
                                        │
                    ┌───────────────────┴───────────────────┐
                    ▼                                       ▼
          parcel has plantings                    parcel has none
          share → those plantings                 share → unallocatedToCrop
          (second cent-exact split)               (reported, never dropped)
```

**Two levels, not one.** The farmer chooses LAND, but the report is per
COMMODITY and a commodity is only reachable through a planting. Weighting
every planting in one pass would answer a different question: two plantings
sharing a parcel would pull twice that parcel's weight, so splitting a field
in half would double the cost it attracts. So parcels are weighted first and
each parcel's own share is carried onward to what stands on it.

**Conservation at both levels.** `allocateByWeights` (landed in the previous
commit) settles shares in integer cents by the largest-remainder rule,
tie-broken by id so the result cannot depend on the order a query returned
rows. `spreadOverParcels` calls it twice — once over parcels, once inside
each parcel — so nothing is rounded twice and
`Σ commodity shares + unallocatedToCrop === the amount entered`, exactly.

**One weighting rule.** Both levels call `computeAreaWeights`, including its
zero-area even-split fallback: a holding whose parcels all have a null area
still allocates, because dropping the cost is the silent failure mode and an
even split is at least a stated one.

**Query shape.** Two new reads, both in `loadTenantRows`, both bounded, both
batched: every live parcel (`take: PARCEL_TAKE + 1`), and the chosen parcels
of every subset entry in one `costEntryId IN (…)` (`take: ALLOCATION_TAKE + 1`).
`allocationBasis` rides the cost-entry select that already runs. The allocator
itself does zero I/O — it reads in-memory maps. Owned-vs-leased is derived by
subtracting the active-lease parcel set already loaded, rather than adding a
fourth copy of the active-lease SQL predicate.

## Files

| File | Role |
|---|---|
| `src/lib/grain/allocate.ts` | `spreadOverParcels` — the two-level, cent-exact spread, beside the existing `allocateByWeights` / `computeAreaWeights`. |
| `src/app-layer/usecases/grain-net-worth.ts` | Reads the basis, resolves the land, spreads, and reports `unallocatedToCrop` + `imputedLandCharge`. Two new bounded reads. |
| `src/lib/grain/cost-metrics.ts` | `IMPUTED_LAND_CHARGE` — a sixth named metric, with the argument for why it is not a fourth term in `cashCostTotal`. |
| `src/lib/grain/uncertainty.ts` | `IMPUTED_LAND_CHARGE_REFUSAL_CODES` — its own refusal list, so a rate refusal cannot be shown where a net-worth refusal belongs. |
| `src/app-layer/schemas/grain.schemas.ts` | `COST_ALLOCATION_BASES`, `COST_SPATIAL_LINKS`, `MAX_ALLOCATION_PARCELS`, and the two new wire fields. |
| `src/app-layer/usecases/cost-entry.ts` | `assertAllocationBasis` + the write path (subset written inside the entry's own transaction). |
| `src/app-layer/repositories/CostEntryRepository.ts` | `replaceAllocationParcels` (deleteMany + one createMany) and the projection that reads the subset back. |
| `src/app/t/[tenantSlug]/(app)/grain/costs/CostEntryFormModal.tsx` | The basis picker, the parcel multi-select, and the effects that retire whichever answer the two controls no longer agree on. |
| `src/app/t/[tenantSlug]/(app)/grain/calculator/{page,CalculatorClient}.tsx` | The two beside-the-cost figures, printed rather than merely conserved. |
| `prisma/schema/{enums,grain,agriculture,auth}.prisma` + migration | The enum, the column, the join table, RLS. (Previous commit.) |
| `tests/guardrails/schema-index-coverage.test.ts` | Layer C-completeness entry for the join table; the `Parcel` reason updated for its second tenant-wide read. |

## Decisions

**Fallow parcels PARTICIPATE, and their share is reported rather than
redistributed.** A parcel with no in-scope known-commodity planting takes its
weighted share like any other, and that share lands in `unallocatedToCrop`
beside the rows — never inside a commodity.

The alternative each existing allocator already implements is to `continue`
past land with no commodity to charge. Under that rule a 5 000 лв cost over a
500 dca holding of which 300 dca is wheat lands entirely on the wheat at 16.67
лв/dca, the 200 idle dca report nothing, and the number moves the wrong way:
**the more land you idle, the more expensive your remaining crop looks**,
which is backwards as a decision aid. Redistributing it onto the crops has the
same effect by a different route. Reporting it keeps a property the other two
cannot have — the per-hectare rate is identical either side of the fallow
line, which is the arithmetic proof that the spread was pure, and it is
asserted as such.

The consequence has to be stated plainly because it is load-bearing: **`Σ rows`
is no longer the money spent — `Σ rows + unallocatedToCrop` is.** That is
exactly why the bucket is PRINTED on the calculator and not merely returned.
A page showing only the rows would show a cost that shrank when the farmer
changed how it spreads, which is the one thing the allocator promises cannot
happen.

The same bucket also absorbs **money rent on an unplanted parcel**, which this
module used to drop on the floor while naming only the lease in
`leasesUnattributed`. That said THAT rent went unattributed and never HOW
MUCH. Produce rent stays out of it: a kilogram in a money bucket is the
dimensional error `rent-basis.ts` exists to prevent, so produce rent on an
unattributed lease is still named in the exclusion list alone.

**The imputed land charge is a NEW named metric, reported beside
`cashCostTotal` and never inside it.** Rent priced onto land the farm owns is
opportunity cost, not cash: no lev leaves the bank. `cashCostTotal` is defined
in its own docblock as exactly `attributedCropCost + rentCostMoneyAmount +
payrollCost`, and every surface that prints it prints those three slices
beside it — a fourth term would leave the printed slices short of the printed
total, which is the #556 defect in the opposite direction. It is not a rent
ACCRUAL either: `resolveRentBasis` prices an obligation the farmer really
owes, this prices one that does not exist, and blending them would make "what
do I owe my landlords" unanswerable from the figure that claims to answer it.

`COST_METRICS.IMPUTED_LAND_CHARGE` carries that argument, and
`COST_METRIC_LABEL_KEYS` is `Record<CostMetric, string>` so the compiler
forced the label key into existence — it is in both locales, unlike three of
the five keys that came before it.

The rate is the **area-weighted mean of the tenant's own resolved money-lease
rates**. Observed from the farm's own data, never invented: a benchmark the
operator never authored is one they would rightly dispute. Produce leases are
skipped, because pricing кг/дка into money needs a grain price and the
opportunity cost of a field should not move with this week's market. With no
resolved money lease the figure is **refused with a named code, never zeroed**
— a zero says owned land is free, which is the defect the charge exists to
fix. Leased land is excluded from the denominator because it already carries
real rent; imputing on top would bill the same hectare twice. The measure is
the PLANTING's area rather than the parcel's, so a half-planted parcel carries
half the charge.

**`TARGET` was left exactly as it was, including the `parcelId` gap.** A
payroll entry pinned to a parcel is still spread tenant-wide, because the
calculator's cost-entry projection never read `parcelId`. Adding it would be a
defensible fix and it was deliberately not made here: this change's whole
promise is that existing data keeps its allocation, and honouring a column the
allocator has never read would move numbers for exactly the tenants who
pinned costs most carefully. The capability now exists as an opt-in
(`PARCEL_SUBSET`), and the filing link stays a filing link.

**A join table, not a `String[]` of parcel ids.** The set IS the allocation
denominator, so a dangling id would be indistinguishable from a smaller
subset and deleting a parcel would silently re-weight a historical cost. A row
that still exists can be counted; one cascaded away changes the subset
visibly. `Parcel` carries `@@unique([id, tenantId])`, so the composite FK also
gives a cross-tenant barrier an array cannot express.

**The basis and the attribution link are separate controls, and the form
removes the contradictions rather than offering them.** A non-TARGET basis
drops the three attribution kinds that name a PLACE — planting, field, parcel
— because the basis has already answered that question; `seasonId` and
`itemId` survive, a season because it is a time scope the calculator's season
filter reads (forbidding it would make every spread cost invisible to a
season-scoped run) and an item because it is what was bought, not where it
went. `assertAllocationBasis` enforces the same rules server-side, on the
RESULTING row rather than the patch, and clears a subset left behind by a
basis change — stale join rows are invisible on every screen and instantly
load-bearing again the moment someone switches back.

**A spread share is ALLOCATED, in the existing vocabulary.** It sets the same
`payrollAllocated` flag a pro-rata payroll share always has, so
`costUncertainty` returns `ALLOCATED` and the calculator keeps saying so with
the badge and sentence it already had. The imputed charge carries the same
badge for the same reason: it is apportioned by a rule, not measured against
this crop.

**Known limitation, stated rather than hidden.** A `PARCEL_SUBSET` whose
parcels are ALL gone is reported in `payrollUnattributable`, so the cost is
never silently dropped. A PARTIALLY shrunk subset — three chosen, two still
live — re-weights over the survivors and conserves, but nothing names the
shrinkage. The join table makes that detectable (the chosen count is a real
row count), so the fix is a new exclusion class rather than a schema change;
it was left out of this change to keep the surface bounded.

**Fixed in passing:** the cost form's `parcel` attribution kind was fed the
LOCATIONS list, so choosing a parcel submitted a location id against
`parcelId` and was refused as a foreign key. It now reads the parcel-options
endpoint the subset picker needed anyway.
