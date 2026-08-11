# 2026-08-11 — Unvalued stock consumptions, surfaced

**Commit:** `<pending>` feat(grain): say when a consumption could not be valued

Design spec: `docs/superpowers/specs/2026-08-11-unvalued-consumptions-design.md`

## Design

`recordInputApplication` values a draw-down as
`consumed × lot.unitCostAmount`, and DECLINES in two cases: the lot has no
`unitCostAmount`, or `lot.unitId !== item.defaultUnitId` (multiplying a
quantity in one unit by a price in another is nonsense — *"a missing cost
is recoverable; a wrong one is a number somebody budgets against"*). Both
write `costAmount: null` and log a warning nobody reads.

`cost-rollup` then aggregates with `groupBy({ _sum: { costAmount } })`,
where null contributes **0**. An input that was genuinely consumed reads
as a free one, and the understatement flows into `ATTRIBUTED_CROP_COST`,
into `GRAIN_NET_WORTH`'s `cashCostTotal`, and therefore pushes the
calculator's headline net worth **up**.

```
recordInputApplication          cost-rollup              grain-net-worth        calculator
  no unit cost      ─┐                                                         ⚠ farm-wide chip
  unit mismatch     ─┴─► costAmount: null ──► reasonOf(tx) ──► per-commodity ──┤
                          (warning only)      + DISTINCT tx     counts on row  └─► ⚠ panel note
                                                counts                              under the total
```

The reason is derived at READ time, not persisted at write time. A stored
reason could never be backfilled — `inventory.ts` records that every
consumption posted a null cost until the valuation landed, so the rows
that most need explaining are exactly the historical ones, and a lot's
unit cost may have been edited since.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/cost-rollup.ts` | The unvalued read + `reasonOf` classification; two counts on `PlantingCostRow`, DISTINCT totals on the result |
| `src/app-layer/usecases/grain-net-worth.ts` | Per-commodity accumulation; farm-wide totals passed through unsummed |
| `src/app/t/[tenantSlug]/(app)/grain/calculator/CalculatorClient.tsx` | `<UnvaluedNote>` under each panel's cost total; farm-wide chip in the header meta slot |
| `messages/{en,bg}.json` | Four keys, ICU plurals in both locales |

## Decisions

- **Not a tenth exclusion class.** The accordion is titled "Excluded from
  these figures" and counts "records excluded". Nothing here was
  excluded — the stock moved, the planting is counted, only the money is
  missing. Filing it there would make one count mean two things. It also
  matters which way the error runs: every exclusion class shrinks what is
  counted, whereas this leaves the cost side short so net worth reads
  HIGH. Hence "a floor, not a total" rather than a neutral note.

- **Counting rule: rows and the farm-wide total disagree, by design.** A
  transaction can hang off a log entry linked to several plantings. Cost
  is split fractionally (`share = cost / targets.size`) — right for money.
  A count cannot be split: "this planting has an unvalued consumption" is
  true of *both*, so each row gets a whole 1. The farm-wide figure counts
  TRANSACTIONS instead, so it stays 1. Summing rows to derive it would
  multiply a shared transaction by the plantings it touched. Asserted at
  every layer — rollup, usecase and page — so nobody "reconciles" them.

- **Classification order mirrors `inventory.ts`.** Price first, units only
  when a price exists. A lot that is both unpriced *and* unit-mismatched
  counts once, as `noUnitCost`. Without that ordering the reason split
  would add up to more transactions than exist.

- **Only `PlantingCostRow` gets the fields.** `SeasonCostRow` /
  `FieldCostRow` deliberately do not: the calculator consumes
  `getCostRollupByPlanting` only, and aggregating counts up to a season or
  field would reintroduce the shared-transaction double-count at a second
  level for no reader.

- **The new capped read is ordered and probed, like the other two.** It
  first shipped as a bare `take: UNVALUED_TAKE` with no `orderBy` and no
  path into `truncated` — which this very function already carries a
  comment against: *"Deterministic order so a capped read returns the SAME
  subset every time... the worst failure mode a money figure has, because
  it looks like activity rather than a bug."* Without it, an over-cap farm
  gets an arbitrary 5,000 rows, Postgres is free to pick a different 5,000
  after a VACUUM, and the reason split and per-commodity caveats move
  between two loads of the same URL — while the page asserts completeness.
  Now `orderBy: [{ id: 'asc' }]` (a cuid is a total order on its own),
  `take: cap + 1` as the overflow probe, and the overflow ORed into
  `truncated`. A capped COUNT presented as exact is the same lie as a
  capped total presented as complete.

  The test that should have caught this was named `orders every capped
  read deterministically` while hand-enumerating two reads, so a third
  arrived unordered and the name quietly became false. It now DERIVES the
  capped reads from the mock call log instead of listing them.

- **A disclosure, not a recalculation.** `netWorth`, `cashCostTotal` and
  every exclusion class are untouched. The cost stays what it is; the page
  stops implying it is complete. A test pins this so a later change cannot
  quietly start subtracting an estimate.

- **Absent at zero, unlike the exclusion count.** The exclusion count is
  rendered even at zero because "0 records excluded" is a statement. The
  unvalued note is hidden at zero: the healthy case is overwhelmingly
  common, and a permanent "0 unvalued" line would train readers to ignore
  the row that matters.

- **`/grain/costs` gets the DTO fields but renders nothing yet.** Same
  understatement, separate surface, separate decision.
