# 2026-08-14 — Per-decare figures, and the two denominators

**Commit:** (pending — see PR)

First of a two-prompt roadmap.

## Why

Bulgarian farmers think in декари and the land market quotes rent in лв/дка.
Absolute totals answer "what is it worth"; per-dca answers what a farmer acts on
— is this field better than that one, does this rented parcel earn its rent.
There was no per-dca money figure anywhere; `areaDca` existed once, as a
descriptive detail beside the expected tonnage.

## Trap one: the numerator (named in the brief)

`netWorth / area` is never computed. Net worth carries `grainOnHandValue`, which
has no area — tonnes in a store, harvested off land that may not be this
season's — and farm-wide overhead. Only terms attributable to the standing
crop's own plantings share the denominator: `standingCropValue`, and
`cashCostTotal`, which is exactly `attributedCropCost + rentCostMoneyAmount +
payrollCost` — the three the brief listed.

`tests/guards/per-area-denominator.test.ts` keeps it that way. A behavioural
test can only prove the figures that EXIST are right; it cannot prove no future
line adds the division, and the division is attractive precisely because it
looks like the obvious next per-dca figure. The guard strips comments before
scanning — this file and its subjects describe the banned expression in prose,
and a scanner that cannot tell a warning from the thing it warns about fails the
build for explaining itself.

## Trap two: the denominator (not named in the brief)

`standingCropAreaHa` sums INCLUDED plantings only — `computeStandingCrop`
filters to `summary.includedPlantingIds` before reducing — so tonnage, value and
hectares describe the same set. That half the brief did name.

What it did not: **`cashCostTotal` is not filtered that way.** It is every cost
attributed to the commodity, including plantings dropped for a missing yield
estimate. So when anything was excluded, the cost side covers more land than the
revenue side and the margin is understated — while an unpriced consumption
biases it the other way.

Two opposite biases cannot be expressed as one bound. The figure is **PARTIAL**,
which is what the vocabulary already means by "records are missing". That
required a new per-commodity fact — `standingCropExcludedCount` — because
`plantingsMissingYieldEstimate` is farm-wide and cannot tell you whether *this*
commodity lost any.

## Files

| file | role |
|---|---|
| `src/lib/grain/per-area.ts` | `computePerArea`, pure |
| `src/app-layer/usecases/grain-net-worth.ts` | `standingCropExcludedCount`; `perArea` on every row |
| `…/grain/calculator/CalculatorClient.tsx` | the margin line, beside the result |
| `tests/guards/per-area-denominator.test.ts` | the division that must never appear |
| `messages/{en,bg}.json` | six strings |

## Decisions

- **Named a MARGIN, never "net worth per dca".** It is built from a strict
  subset of net worth's terms — the ones that share an area — and the two must
  not be mistakable. The on-screen hint says so in as many words.

- **`> 0`, not `!== 0`.** The divisibility check also rejects `NaN` and
  negatives, either of which would otherwise reach the division and come back as
  a confident figure nobody can reconcile. A test asserts no degenerate input
  produces `Infinity` or `NaN`.

- **Two refusal codes, not one.** `NO_STANDING_CROP_AREA` (only in store, or
  every planting excluded) and `NO_STANDING_CROP_VALUE` (no market price) fail
  for different reasons and the operator can act on only one of them.

- **Precedence matches the other two levels.** REFUSED > PARTIAL > AT_MOST >
  ALLOCATED > EXACT — the same order `composeFarmUncertainty` and
  `costUncertainty` use, so the row, farm and per-dca levels cannot disagree
  about which qualifier matters more.

- **AT_MOST, not AT_LEAST, on the margin.** An unpriced consumption understates
  the cost, which OVERSTATES the margin. The bound on the margin points the
  opposite way to the bound on the cost that caused it — the same inversion the
  headline already carries.

- **The fixture folds `perArea` with the real function.** Hardcoding it would
  let a fixture claim a margin its own numerator and denominator do not produce.
  Third time this pattern has earned its place on this page.

- **One test matcher tightened.** "renders NOTHING when every consumption was
  valued" asserted `/farm-wide/` absent, standing in for the `unvaluedFarmWide`
  string. The per-dca hint says "farm-wide overhead" for an unrelated and
  accurate reason, so the matcher now names `unvalued consumption`. A matcher
  broad enough to hit innocent copy tests the copy, not the behaviour.
