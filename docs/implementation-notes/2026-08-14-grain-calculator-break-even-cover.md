# 2026-08-14 — Grain calculator: break-even cover, and the table it replaced

**Commit:** `<sha> feat(grain): break-even cover per crop, and the appendix table goes`

## Design

The calculator answers "what is my grain worth". It did not answer the
question a farmer asks next, which is **"should I sell it?"** — and that
question has a shape a visual can carry honestly:

```
             break-even price  ─┐
                                ▼
   Wheat   ████████████████████████████░░  273% — covers cost
                                            250.00 EUR market · 91.67 EUR to break even
   Barley  ██████████████░░░░░░░░░░░░░░░░   50% — short of cost
                                            250.00 EUR market · 500.00 EUR to break even
   Maize   No market price to compare against.
```

`market ÷ break-even`, where break-even is `attributable cost ÷ expected
tonnes`. One value advancing toward one max.

### Why a ratio is not a currency blend

The single hardest constraint on this page is that crops may be priced in
different currencies, and money from two currencies must never share a
scale. The ratio sidesteps it rather than dodging it: **both sides of
`market / breakEven` are in the same currency by construction** — the
usecase already refuses a row outright when its cost currency differs from
its price currency — so the quotient is dimensionless. A EUR crop and a BGN
crop sit on one scale because there is no money on that scale at all. The
money is still shown beside each bar, each with its own code.

Every bar therefore runs `aria-valuemin=0 … aria-valuemax=100`, which a
rendered test asserts directly.

### Why the bound does not invert here

The per-dca margin (PR-1) inverts: an unpriced consumption understates the
cost, which *overstates* the margin, so `AT_LEAST` cost ⇒ `AT_MOST` margin.
Break-even does the opposite. The same understated cost understates the
price needed to clear it, so the true break-even is this or **higher** and
the cover is this or **lower** — `AT_LEAST` cost ⇒ `AT_LEAST` break-even.

Two figures sitting inches apart on the same card hedge in opposite
directions from the same cause. That is stated in three places (the module
docblock, the precedence function, the JSX) because it is exactly the kind
of thing a later reader "simplifies" into agreement.

### What was deleted to pay for it

The brief required the surface budget to be net-neutral or negative. The
page went **9 surfaces → 8**: the appendix `DataTable` is gone — 31 lines
of JSX, a 66-line `columns` memo, the import, and three exemption entries
across the table-platform guards.

It was the right thing to cut. It listed every commodity's five money
columns *below* the sum, the cost breakdown, the KPI and the exclusions —
the cross-crop comparison a farmer most wants was the last thing on the
page, and the comparison strip added in PR-2 of roadmap 2 already carries
the same rows higher up. Keeping both would have meant the same commodities
enumerated twice on one screen.

### The text is not a fallback

A bar conveys nothing to a screen reader, and deleting the table removed
what used to be the page's text equivalent. So the percentage, the verdict
("covers cost" / "short of cost"), both prices and the bound are rendered
as text for every row. The ranking and the magnitudes survive with the
visual switched off entirely, which is what a rendered test asserts rather
than the presence of the bar.

## Files

| File | Role |
| --- | --- |
| `src/lib/grain/break-even.ts` | New. `computeBreakEven` — cost ÷ tonnes, cover %, verdict, composed uncertainty, two refusal codes. |
| `src/app-layer/usecases/grain-net-worth.ts` | Folds `breakEven` per row with the same function the fixtures call. |
| `src/app/t/[tenantSlug]/(app)/grain/calculator/components.tsx` | New exported `BreakEvenRow` (ProgressBar + text equivalent); strip docblock updated for the deleted table. |
| `src/app/t/[tenantSlug]/(app)/grain/calculator/CalculatorClient.tsx` | Appendix `DataTable` + `columns` memo deleted; standalone `BreakEvenRow` for the single-crop case. |
| `messages/{en,bg}.json` | 10 keys each, real Bulgarian. |
| `tests/unit/grain/break-even.test.ts` | Arithmetic, guarded divisions, precedence. |
| `tests/rendered/grain-calculator.test.tsx` | Bar + text equivalent, covered vs short, bounded, refused, two currencies, single-crop. Desktop-table block removed with its subject. |
| `tests/guards/{list-page-shell,filter-toolbar,columns-dropdown}-coverage.test.ts` | Calculator exemptions removed — the page no longer imports `DataTable`. |
| `tests/e2e/mobile/horizontal-drift.spec.ts` | Comment rewritten: the drift risk is now a ratio-driven fill, not a wide table. |

## Decisions

- **`ProgressBar`, not `StatusBreakdown`.** Read the decision table first.
  `StatusBreakdown`'s rows share a total; crops share nothing — a wheat
  bar and a barley bar are not slices of one quantity, and stacking them
  would invent a whole that does not exist. `ProgressBar` is "a single
  value advancing toward a max", which is literally what cover is.

- **Cover, not margin-per-dca, is what gets the bar.** Margin per dca was
  the obvious candidate (it is the figure PR-1 just added) and it is the
  wrong one: a bar needs a max, and margin has no natural ceiling. Any max
  would have been synthetic — the largest crop's margin, or a round number
  — and a synthetic max is a lie told in pixels. Break-even supplies its
  own max from the arithmetic.

- **Overflow is honest because the text is not clamped.** At 273% cover the
  bar pins full and sets `data-overflow`; `aria-valuetext` still reads
  "273%" and the visible text states it too. The bar cannot exceed its
  track — which the mobile drift spec now exists to catch — so the
  magnitude lives in the text layer rather than being lost.

- **A refused crop gets no bar, not a zero-length one.** A zero-length bar
  sits in the comparison looking like a crop that covers nothing, and
  "covers nothing" is a different claim from "we could not work it out".
  The refusal is named in prose instead, with the specific missing input.

- **A costless crop withholds the ratio and keeps the verdict.** Break-even
  of zero means any price clears it; the ratio is undefined, so it is not
  reported as `Infinity`, but `covered` is not in doubt.

- **The single-crop hole was found by a failing test and fixed in the
  product, not the test.** The comparison strip is gated on
  `comparisonItems.length > 1` — correct when it held only a comparison,
  wrong the moment a *figure* moved inside it. A monoculture farm would
  have lost break-even entirely, and for a monoculture it is the only
  question there is. The same component now also renders once beneath the
  headline when there is a single crop, inside the existing card, so the
  surface count is unchanged.

- **Test comments that named the deleted table were rewritten, not left.**
  Three scoping comments justified `within(sum)` by pointing at the
  appendix table's duplicate "Net worth". The scoping is still right for a
  better reason — it makes the assertion mean "claimed once *here*" rather
  than "appears once on the page", which is the claim that keeps holding
  when a future surface repeats the figure.
