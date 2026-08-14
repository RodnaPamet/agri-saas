# 2026-08-14 — The grain calculator answers for the farm

**Commit:** (pending — see PR)

First of a four-prompt roadmap. Follows `2026-08-13-grain-calculator-one-answer.md`.

## The defect

The page's docblock claims it is "the only surface in the product that answers
'what is the grain worth, after everything it cost me?'". It answered that **per
commodity**:

```ts
const row = rows.find((r) => r.commodity === selected) ?? rows[0] ?? null;
```

A farm growing wheat, sunflower and maize got three answers behind a ToggleGroup
and had to add them in its head. That is the same defect #554 fixed *within* a
commodity — two figures a reader is left to combine — still fully present
*across* commodities.

## The shape the constraint forces

This product blends no currencies. `cost-rollup` refuses to, prices carry their
own, and there is no FX table in the repo. So the farm answer is **one total per
currency**, biggest first. That constrains its shape; it is not a reason to omit
it, and not a reason to hide the smaller currencies.

## A refused commodity is excluded and named

The load-bearing decision. A refused row still has asset values — a
mixed-cost-currency refusal has a perfectly good standing crop. Folding those in
while its cost cannot be subtracted would **overstate** the farm, which is the
worst direction for this number to be wrong in. Dropping it silently would
report a smaller figure with nothing saying it is not the whole farm.

So refused commodities contribute nothing to the arithmetic and are named in the
card: *"1 commodity is not in this total: maize."*

They hide in two places, and both are collected: inside a currency bucket (a
mixed-currency refusal keeps its price currency) and outside every bucket (no
market price means no currency at all).

## Uncertainty is composed, not invented

`composeFarmUncertainty` reuses the existing six states. The precedence is the
argument:

```
REFUSED   nothing computable at all — there is no total to qualify
PARTIAL   a commodity is missing            ← outranks every bound
AT_MOST   a contributing cost is a floor
ALLOCATED a contributing payroll was apportioned
EXACT
```

**PARTIAL outranks the bounds** because "at most X" invites the reader to treat
X as the ceiling *for the farm*; with a commodity missing, that claim is not
merely imprecise, it is about a different farm. Below PARTIAL the order matches
`costUncertainty` exactly, so the row level and the farm level cannot disagree
about which qualifier matters more.

A REFUSED row contributes nothing to the *bound*: its cost is not in the total,
so it cannot make the total a ceiling.

## Files

| file | role |
|---|---|
| `src/lib/grain/farm-total.ts` | `foldFarmTotals` — a fold, no query |
| `src/lib/grain/uncertainty.ts` | `composeFarmUncertainty` |
| `src/app-layer/usecases/grain-net-worth.ts` | returns `farm` alongside `rows` |
| `…/grain/calculator/CalculatorClient.tsx` | the farm card, above the toggle |
| `messages/{en,bg}.json` | five strings |

## Decisions

- **Computed in the usecase, as a fold.** The island's stated property is that
  it "never re-derives a cost, a yield or a price" — a client-side reduce over
  money is exactly that. And because every input is already computed, the fold
  adds no read: the D1/D2 query guardrails are untouched, verified by zero added
  `findMany` in the diff.

- **Above the toggle, deliberately.** The toggle selects which crop the detailed
  sum below expands. Placing the farm card under it would make the toggle look
  like it also selects which *farm* you are looking at.

- **The amounts print a CURRENCY CODE, not the tenant symbol.**
  `useExactMoneyFormatter` renders whatever the tenant is configured with, so a
  BGN total would appear with a euro sign — the same class of defect flagged in
  `grain-net-worth`'s asset values. The cash-out card already prints
  `formatDecimal(amount) + currency` for this reason, and the farm card follows
  it.

- **No card at all for a single-crop farm.** It would restate the commodity sum
  directly below it. Extending the ToggleGroup's existing instinct: an
  affordance that says nothing must not occupy space on a simple farm.

- **The rendered fixture FOLDS `farm` from its own rows.** Hardcoding it would
  let a fixture claim a farm total its rows do not add up to — passing while
  production disagreed with itself. Same reason `withServerDerived` exists, and
  the same lesson as the previous roadmap: moving logic across a boundary
  converts "computed" into "supplied", and a supplied value in a fixture is a
  wish unless something ties it back.
