# 2026-08-14 — The calculator shows the shape of the farm

**Commit:** (pending — see PR)

Fourth and last of the roadmap.

## The defect

`commodityOptions` fed a `ToggleGroup`, so a farm with five crops saw ONE at a
time and could not answer "which crop is actually carrying this farm?" without
stepping through them. The appendix table did show every row — but it sits below
the sum, the cost breakdown, the KPI and the exclusions, so the comparison a
farmer most wants was the last thing on the page.

## What landed: option 2, and it REPLACES the toggle

A compact per-crop strip under the farm total: crop name, net worth, uncertainty
state, sorted by contribution. Every crop visible on first paint, no interaction.

The brief framed the strip as sitting alongside the toggle ("with the toggle
selecting which one the detailed sum expands"). It replaced it instead. The
toggle's only job was selection, which these rows also do — keeping both would
put two controls for one decision on the same screen, and a farmer would try to
click the numbers anyway. The conditional instinct the brief asked to preserve is
preserved exactly: nothing at all for a single-crop farm.

Option 1 (promote the table) was rejected for the phone. The table is five money
columns that only mean anything read side by side — hence `mobileFallback="scroll"`
— and promoting it would put a horizontally-scrolling grid above the answer on the
operator's real device.

No chart. There was nothing a chart would say that four rows of figures do not.

## Where a comparison view most easily lies

By making unlike things look alike. A refused net and a bounded net rendered as
bare figures sit in the same column as exact ones and invite exactly the
comparison they cannot support. Each row carries its state in the shared
vocabulary — "at most" rides the value, a refusal shows the em-dash — and a
refused crop sorts LAST rather than as a zero, which would rank it below a
loss-making crop that at least has a number.

## The ordering is a claim, so it is stated

`CANONICAL_COMMODITIES` order is arbitrary to a farmer; contribution is not. The
strip sorts by net worth descending and says "Largest net worth first" beside the
heading — an order the reader cannot see the rule for is one they will invent a
rule for.

## Files

| file | role |
|---|---|
| `…/grain/calculator/components.tsx` | `CommodityStrip` |
| `…/grain/calculator/CalculatorClient.tsx` | strip replaces `ToggleGroup`; sorted items |
| `messages/{en,bg}.json` | three strings |
| `tests/guards/filter-toolbar-coverage.test.ts` | exemption reason refreshed |
| `tests/guards/list-page-shell-coverage.test.ts` | exemption reason refreshed |

## Two stale exemption reasons, rewritten

The brief said to update them rather than leave them stale if the layout changed
the premises. Two had:

- **filter-toolbar** cited "the `<ToggleGroup>` above, which drives the two value
  panels" — the toggle is gone and the panels went in the previous roadmap. It
  also claimed the row set is `CANONICAL_COMMODITIES`, ten rows, which was never
  true: the usecase keys its accumulator from real records.
- **list-page-shell** described "two side-by-side value panels and a shared-cost
  note", both removed when the page became one sum.

**columns-dropdown was left alone** — "net worth is a SUBTRACTION, a reader who
gears away 'Farm cost' is left with a value figure that looks like profit" is
exactly as true as when it was written.

## Decisions

- **`selected={row.commodity}`, not `selected`.** The state seeds from
  `rows[0]?.commodity ?? ''` and the row lookup falls back to `rows[0]`, so on
  first paint with an empty seed the strip would have marked nothing while the
  sum below expanded wheat. Binding to the row actually rendered keeps them in
  step by construction.

- **The strip's amounts print a currency code.** Same reasoning as the farm card,
  and more pressing here: this column can genuinely mix currencies, so the
  tenant symbol would label a BGN row with a euro sign right beside a real one.

- **The currency test now scopes to the farm card.** The strip legitimately
  shows the same figures — with one crop per currency, each total IS its crop's
  net — and that agreement is the point rather than a duplicate to assert
  around.
