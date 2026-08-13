# 2026-08-13 — The grain calculator states one answer

**Commit:** (pending — see PR)

Supersedes the "two panels charge the same cost" section of
`2026-08-11-grain-calculator-page.md`.

## The defect

Two `ValuePanel`s side by side, each ending in a net line, plus
`sharedCostNote` — a sentence explaining that the two nets could not be added.

They could not, and for a good reason: the usecase attributes cost per
COMMODITY, not per growing-vs-stored, so both panels charged the same
`cashCostTotal`. Refusing to invent a split was the right call. Drawing the
shared cost twice was not.

Side-by-side panels each ending in a total is the universal idiom for "these
sum". A prose disclaimer cannot beat a layout — the layout is read first, and
by more people.

Worse, neither net meant anything alone. `standingNet` was the whole farm cost
subtracted from the standing crop; `onHandNet` was the whole farm cost
subtracted from the grain in store. Not "wrong" so much as not a quantity
anyone can act on, printed twice at 16px semibold.

## What replaced it

The arithmetic the usecase already performs, written out — because it composes
exactly:

```
+ standing crop value      (EXPECTED)
+ grain on hand value      (ACTUAL)
− rent paid in grain       ┈ netAssetPosition
− total farm cost
= net worth
```

`netAssetPosition` is literally `standingCropValue + grainOnHandValue −
rentCostProduceValue`, and `netWorth` is `netAssetPosition − cashCostTotal`.
Every term on screen is a term of the real computation; the reader can add the
column and land on the figure at the bottom.

Of the three options the brief offered, this was the only one where that is
true. "One cost block presented once" and "value-only panels with the net in
the hero" both remove the false-summation idiom, but neither makes the
arithmetic legible — and both leave the rent term where it was.

**The rent term is the quiet win.** `rentCostProduceValue` is a real
subtraction inside the headline — grain owed to a landlord is not the farm's —
and it appeared only as a footnote under a panel's cost breakdown. A term of
the sum, rendered somewhere the sum could not be read. It is a line now, and
omitted entirely at zero, because "− €0" states a term this farm does not have.

## Files

| file | role |
|---|---|
| `…/grain/calculator/CalculatorClient.tsx` | `SumLine` replaces `ValuePanel`; one card, one cost, one net |
| `messages/{en,bg}.json` | `+waterfallAria`; `−sharedCostNote`, `−netAfterCostLabel`, `−grossValueLabel` |
| `docs/…/2026-08-11-grain-calculator-page.md` | superseded sections marked and rewritten |

## Decisions

- **The sign is rendered, not implied.** `+` and `−` (U+2212, not a hyphen —
  it matches the plus at the same optical weight in a `tabular-nums` column)
  sit against each amount. A minus expressed only as red text is not a minus on
  a monochrome print-out, or to a reader who does not separate the hue.

- **`details` is a list, not a joined string.** Area and expected yield are two
  facts. Joining them into `"125 dca · 60.00 t"` made "125 dca" unfindable as a
  fact in its own right — which surfaced immediately as a test that could no
  longer locate it, and would have surfaced later as anything else reading the
  DOM.

- **One cost means one place for everything qualifying it.** The breakdown, the
  allocated-payroll badge and the unvalued-consumption note used to render
  TWICE, once per panel. They now appear once, under the single cost line they
  describe.

- **The `role="group"` is load-bearing for more than tests.** It ties the terms
  to the result for a screen reader, and it lets an assertion scope "exactly one
  net figure" to the sum — the appendix table below has a "Net worth" column
  header, which is a different claim on a different surface.

## The prompt's third item did not hold

The brief asked to stop the appendix iterating `CANONICAL_COMMODITIES`, on the
grounds that a wheat-and-sunflower farm reads eight rows of zeros, and to state
the filter as "2 of 10 commodities shown".

It does not iterate the catalogue. `grain-net-worth.ts` builds its accumulator
with `ensureAcc(acc, commodity)`, called only from inside loops over real
plantings, lots, leases and payroll; `CANONICAL_COMMODITIES` is used solely by
`byCanonicalOrder` to SORT. Two commodities in, two rows out — verified against
the usecase, not inferred from the island.

So no filter was added, and no count is stated: "2 of 10 shown" would claim
eight rows were suppressed when they never existed for this farm, which is a
worse falsehood than the silence it would replace. What landed instead is a
regression lock — a test asserting the two-commodity render produces two rows
and names neither barley nor sunflower — so a future change that seeds the
accumulator from the catalogue fails rather than quietly padding the table.
