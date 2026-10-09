# 2026-10-09 — attributing cost to a crop when the farm has no plantings

**Commits:**
- `324f30bc3` feat(calculator): attribute a parcel with no planting through its own cropType (#1541)
- `567c4ef` wip: target-basis parcel fallback (#1548) — subject lost to an `--amend` after a merge; this note is where its reasoning lives
- (#1549, in flight) an unattributed cost makes the figures a bound, not exact

## The problem

The grain calculator attributes money to a commodity through **plantings**. Production has none: 1 `CropType`, 1 `CropPlan`, 1 `Planting`, all sample data, against 4 live parcels carrying 1386.8 дка of real crop (maize 691.0, barley 348.3, wheat 324.8, sunflower 22.8).

So every per-commodity cost read **zero** on the only farm that matters, and the farm's own cost entries were reported unattributable. Not a crash and not a wrong number — an honest refusal, which is why it survived so long.

## Design

Owner ruling (2026-10-09, #1512): **per parcel, the plantings on it if it has any, else the parcel itself.** Per *parcel* and not per farm, because a farm-level fallback would count a parcel that has both a planting and an `areaHa` twice.

Applied in two arms, because the allocator has two and they are reached by different data:

```
HOLDING / PARCEL_SUBSET   spreadOverParcels -> plantings on each parcel
                          -> parcels with none fall back to Parcel.cropType     (#1541)

TARGET, unlinked          pro-rata across plantings in scope
                          -> no plantings at all: spread across parcels instead (#1548)
```

`spreadAcrossLand` holds that attribution once and both arms call it. Two copies would be two answers about where a cost landed, and only one of them conserves.

## The slug mismatch, which would have shipped an inert fix

The obvious implementation is `resolveCanonical(parcel.cropType)`, mirroring the call three lines away — and that call is correct where it stands, because `CropType.commodityCanonical` already holds a slug. `Parcel.cropType` does not: the crop picker persists **capitalised** catalogue values. Measured against all seven:

```
Wheat      isCanonical=false  normalize=wheat
Barley     isCanonical=false  normalize=barley
Canola     isCanonical=false  normalize=rapeseed
Maize      isCanonical=false  normalize=maize
Sunflower  isCanonical=false  normalize=sunflower
Peas       isCanonical=false  normalize=peas
Grass      isCanonical=false  normalize=null
```

`isCanonicalCommodity` is false for every one, so that version resolves nothing on any farm and the fallback cannot fire — green, shipped, inert. `normalizeCommodity` case-folds and carries `COMMODITY_ALIASES`, which is where `canola → rapeseed` lives: the picker and the market vocabulary disagree on that *word*, not merely its case.

## Files

| file | role |
|---|---|
| `src/app-layer/usecases/grain-net-worth.ts` | `ParcelInfo.commodity`, `spreadAcrossLand`, both allocator arms |
| `src/lib/grain/allocate.ts` | `ParcelSpread.unallocatedByParcel` — the per-parcel breakdown a caller needs to attribute some and report the rest |
| `src/lib/grain/uncertainty.ts` | `costIsFloor` gains the unattributed cause (#1549) |
| `src/lib/grain/per-area.ts`, `break-even.ts` | carry the new qualifier input |
| `src/lib/dto/grain-calculator.dto.ts` | `unattributedCostEntries` on the wire |

## Decisions

- **`Grass` resolving to no commodity is correct, not a gap.** A ley is a land use, not something the market prices, so its share of a spread stays reported rather than charged to a crop that does not exist.

- **Idle land is never redistributed.** A parcel with neither a planting nor a resolvable crop keeps its share in `unallocatedToCrop`. Pushing it onto the cropped parcels would make fallow land free and make the remaining crop look *more* expensive the more land is left idle — backwards as a decision aid.

- **A season-scoped cost is NOT parcel-attributed.** `Parcel.cropType` is the crop standing there now and carries no year, so charging a past season's cost to it would invent the association. `ParcelCropSeason` (`parcelId`, `year`, `cropType`) is the right basis and is deliberately unused: nothing in `src/` reads it but `parcel-history.ts`, and whether it holds a single row is unknown. Building the season dimension on a possibly-empty table is the #1511 shape — a wire path with nothing behind it. The read-only count that would settle it is on #1530.

- **The TARGET invariant is narrow and survives.** Its docblock said TARGET "is untouched — the same code path, so an existing row cannot move by a cent". That holds wherever TARGET produced a figure: a farm with plantings has a non-empty `targets` and never reaches the new branch. Only the case that produced *nothing* behaves differently, and the docblock now says which case changed rather than claiming none did.

- **`unallocatedToCrop` is not a cost floor**, and this was my first design for #1549 and it was wrong. A spread landing on idle land is deliberately not redistributed, so each commodity's share is **exact** and only the farm total splits between crops and fallow. The signal is `payrollUnattributable` — cost that belongs to *some* crop and reached none.

- **The qualifier is required, not optional.** Adding `unattributedCostEntries` broke 70 call sites, all test fixtures. That is the compiler making every site declare it; an optional field with `?? 0` at the read lets a future consumer silently omit it and the qualifier goes dark.

## What this still does not do

`attributableCostPerDca` is not yet a figure for a farmer-typed per-crop cost. `cashCostTotal` is three terms and only `payrollCost` reads a `CostEntry` — PAYROLL category only, because any other category would double-count against consumption-based crop cost. The owner has ruled on the remedy (fold typed costs into the margin, exclusive per crop+season); it is #1530's slice 3, and the guard it needs first is an assertion that the printed cost slices sum to the printed total, which does not exist today.
