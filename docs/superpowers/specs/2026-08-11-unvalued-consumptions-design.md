# 2026-08-11 — Surface unvalued stock consumptions

## Problem

`recordInputApplication` values a stock draw-down as
`consumed × lot.unitCostAmount`. It DECLINES to value it in two cases,
each deliberate:

1. the lot carries no `unitCostAmount` — nothing to multiply by;
2. `lot.unitId !== item.defaultUnitId` — the multiplication would be
   dimensionally wrong, and *"a missing cost is recoverable; a wrong one
   is a number somebody budgets against."*

Both write `costAmount: null` and log a warning. Nothing is persisted.

Downstream, `cost-rollup` aggregates stock cost with
`groupBy({ _sum: { costAmount } })`. A null contributes **0**, so an
input that was genuinely consumed reads as a free one. The understatement
flows into `ATTRIBUTED_CROP_COST`, into `GRAIN_NET_WORTH`'s
`cashCostTotal`, and therefore pushes the calculator's headline net worth
*up*. No surface says so.

This is not the same failure as the nine existing exclusion classes.
Those drop a record OUT of the calculation. Here the record is counted —
only its money is missing.

## Design

### Detection: read-time derivation

Rejected: persisting an `unvaluedReason` on `StockTransaction` at write
time. It needs a migration and a new enum, and — decisively — historical
rows can never be backfilled, because a lot's unit cost may have been
edited since. The page would under-report exactly where the problem is
worst. `inventory.ts` records that *every* consumption posted a null cost
until recently, so there is real history to explain.

Read-time derivation works retroactively and needs no schema change.

### 1. `cost-rollup.ts`

One bounded `findMany` beside the existing `stockCurrencies` read:

```ts
where: { tenantId, logEntryId: { in: liveLogEntryIds },
         type: { in: [...COST_BEARING_MOVEMENTS] }, costAmount: null }
select: { id, logEntryId,
          lot: { unitCostAmount, unitId, item: { defaultUnitId } } }
take:  UNVALUED_TAKE
```

Classification mirrors `inventory.ts` so the two cannot drift:

| Condition | Reason |
| --- | --- |
| `lot.unitCostAmount == null` | `noUnitCost` |
| `lot.unitId !== lot.item.defaultUnitId` | `unitMismatch` |

**Counting rule — the load-bearing subtlety.** A stock transaction can
hang off a log entry linked to SEVERAL plantings. The existing code
splits *cost* fractionally (`share = cost / targets.size`), which is
right for money and wrong for a count.

- Per-planting counts increment by **1 per target**. "This planting has
  an unvalued consumption" is the honest per-row statement.
- The report-level total is a **DISTINCT transaction count**
  (`unvalued.length`), NOT a sum of per-row counts — summing would
  double-count a shared transaction.

The two numbers may therefore legitimately disagree. That is intended,
and is asserted by a test so nobody "fixes" it.

DTO additions (additive; `/grain/costs` unaffected until it opts in):

```ts
// PlantingCostRow only
unvaluedNoUnitCost: number;
unvaluedUnitMismatch: number;

// computePlantingCostRows result — DISTINCT counts
unvalued: { noUnitCost: number; unitMismatch: number };
```

**`SeasonCostRow` / `FieldCostRow` deliberately do NOT get these.** The
calculator consumes `getCostRollupByPlanting` only, so adding them there
is unused surface — and aggregating per-planting counts up to a season or
a field would reintroduce the shared-transaction double-count at a second
level, for no reader. The season/field rollups destructure
`{ rows, truncated }`, so the extra result key is harmless to them.

### 2. `grain-net-worth.ts`

`CommodityNetWorthRow` gains the same two counts, accumulated per
commodity exactly as `attributedCropCost` already is (planting →
commodity via `plantingInfo`). `GrainNetWorthResult` gains
`unvalued: { noUnitCost, unitMismatch }`, **passed through** from the
rollup's distinct totals rather than summed from rows.

No change to `netWorth`, `cashCostTotal`, or any exclusion class. This is
a disclosure, not a recalculation: the cost stays what it is, and the
page stops implying it is complete.

### 3. Calculator UI

NOT a tenth exclusion class — the accordion is titled "Excluded from
these figures" and counts "records excluded", which this is not.

**Per-commodity**, inside `ValuePanel` under `Total farm cost`, only when
that commodity has counts:

```
Total farm cost              €5,500
⚠ 3 consumptions could not be valued —
  this cost is a floor, not a total.
     2 · lot has no unit cost
     1 · lot unit differs from product unit
```

**Report-level**, a second chip in `PageHeader`'s `meta` slot beside the
existing "Priced …" stamp, so the caveat is visible before the toggle is
touched.

New keys in BOTH locales: `unvaluedPanelNote`, `unvaluedReasonNoUnitCost`,
`unvaluedReasonUnitMismatch`, `unvaluedFarmWide`.

## Testing

- `cost-rollup`: both reasons classified; a transaction shared across two
  plantings counts 1 per planting AND 1 in the distinct total; a valued
  consumption produces no counts.
- `grain-net-worth`: per-commodity accumulation; result-level passthrough
  is the distinct count, not the row sum.
- rendered: panel line appears with the reason split; absent at zero;
  header chip present. Each assertion falsifiable — absence-of-raw-count
  style, so turning the feature off fails rather than silently passing.

## Out of scope

`/grain/costs` gets the DTO fields but does not render them yet. Same
understatement, separate surface, separate decision.
