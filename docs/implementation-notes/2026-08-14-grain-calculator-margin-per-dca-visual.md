# 2026-08-14 — Margin per decare, beside cover rather than instead of it

**Commit:** `<sha> feat(grain): margin per decare on its own scale, and a primitive that can show a loss`

## Why this exists at all

The previous PR shipped a *break-even cover* bar and called it the margin
visualisation. It was not. Cover is `value / cost` — return on the money
spent. Margin per decare is `(value − cost) / area` — return on the land
used. They share a sign (cover ≥ 100% ⟺ margin ≥ 0, exactly, because
`standingCropValue = tonnes × price`) and they **rank crops differently**:

| | Crop A | Crop B |
|---|---|---|
| value / cost | 10,000 / 1,000 | 100,000 / 50,000 |
| Cover | **1000%** — first | 200% |
| Margin per dca (125 dca) | 72 | **400** — first |

On a farm where land is the scarce input, the second ranking is the one
that decides what to plant. So the margin got its own visual, and the
disagreement between the two is stated on the page instead of being
resolved by quietly deleting one.

## Design

### A new primitive, because ProgressBar cannot show a loss

`progress-bar.tsx:81` floors its input with `Math.max(0, value)` **before**
computing any percentage. A −40 and a 0 come out identical in the fill, the
visible label, `aria-valuenow` and `aria-valuetext`. Overflow is preserved
and surfaced three ways; underflow is destroyed silently. That asymmetry is
right for progress and fatal for money.

The chart platform had no alternative — `Bars` requires a band scale over
`Date`s, and `BarField3D` is a scaffold that renders nothing. So
`src/components/ui/diverging-bar.tsx` was added:

```
        −112 EUR            break even            +112 EUR
   Wheat            │████████████████                +76 EUR/dca
   Barley  ████████████████████████│                −112 EUR/dca
                            ▲ visible baseline
```

- `role="meter"` — ARIA's "scalar measurement within a known range", which
  accepts a **negative** `aria-valuemin`. `progressbar` means completion of
  a task and starts at zero, so it would have clamped the sign away again.
- Each side owns half the track; the fill is clamped at the scale end
  (`data-overflow`) while the true figure stays in the text.
- A non-positive `max` sets `data-scale="none"` and draws nothing, rather
  than dividing by it.

It lives beside `ProgressBar` and **not** in `components/ui/charts/`, whose
module layout and barrel exports are pinned by
`tests/guardrails/chart-platform-foundation.test.ts`.

### One scale per currency

Cover is dimensionless, so all crops share one 0–100 axis whatever they are
priced in. Margin is money. `foldMarginScales`
(`src/lib/grain/margin-scale.ts`) applies the rule `foldFarmTotals` already
uses: bucket by currency, one axis per bucket, and **name** what falls
outside — a crop with no price has no currency and therefore no axis, so it
is listed rather than dropped.

The axis is sized by the largest **magnitude** in the group, so a −112
beside a +76 gets a 112 axis and the loss sits on-axis instead of running
past its own track.

## Files

| File | Role |
| --- | --- |
| `src/components/ui/diverging-bar.tsx` | New primitive — signed magnitude either side of a visible zero. |
| `src/lib/grain/margin-scale.ts` | New. `foldMarginScales` — per-currency grouping, shared max, sort, `comparable`, `unscaled`. |
| `src/app/…/grain/calculator/components.tsx` | New `MarginPerDcaCard` + `MarginScaleGroupRows`. |
| `src/app/…/grain/calculator/CalculatorClient.tsx` | Derives the scales; renders the card beside the cover strip. |
| `docs/charts.md` | Decision-table row + a "ProgressBar vs DivergingBar — the sign decides" section. |
| `messages/{en,bg}.json` | 8 keys each, real Bulgarian. |
| `tests/rendered/diverging-bar.test.tsx` | 8 primitive tests, including the loss-is-not-zero regression. |
| `tests/unit/grain/margin-scale.test.ts` | 12 fold tests — currency isolation, magnitude axis, ordering, nothing dropped. |
| `tests/rendered/grain-calculator.test.tsx` | 8 page tests — signed figures, printed axis, two currencies, single-crop, bounded, decorative bar. |

## Decisions

- **Surface budget went 8 → 9, deliberately and with sign-off.** The
  previous PR paid for cover by deleting the appendix table, and the
  standing rule was net-neutral-or-negative. Keeping both visuals breaks
  it. That was an explicit product call: the two answer different
  questions, and suppressing one to satisfy a count would be optimising
  the rule instead of the reader. **Do not "restore" the budget by
  deleting one of them** — that is what this paragraph exists to prevent.

- **A primitive, not a call-site composition.** The alternative considered
  was two mirrored half-width `ProgressBar`s (`scale-x-[-1]`, `Math.abs`)
  wrapped in `aria-hidden`. It renders the same picture, but it
  re-implements diverging geometry at every future call site and stays
  honest only by hiding a wrong announcement (`ProgressBar` hard-codes
  `aria-valuetext` to a percent, which is meaningless for money). One
  tested owner beats a suppressed wrong answer.

- **The bar is decorative *here*, though the primitive is not.** Every
  figure it encodes is already printed beside it with sign, currency and
  qualifier, so leaving the meter in the accessibility tree would announce
  each crop twice. The row is the labelled unit; the bar is
  `aria-hidden`. Callers with no text beside the bar should pass
  `valueText` instead.

- **Fewer than two drawable crops ⇒ no bars.** A single bar fills its own
  scale because it *is* the scale — a picture that cannot be wrong and
  cannot inform. The figure is still printed; only the comparison is
  withheld. This is not the single-crop hole from the previous PR: there a
  *figure* vanished, here only a *comparison* does.

- **A refused crop is listed without a bar, and sorts last.** Not a
  zero-length bar (which reads as "made nothing") and not omitted (which
  describes a smaller farm). Sorting it among the numbers would invite
  reading "could not work it out" as a middling result.

- **U+2212, not a hyphen,** for negative money — beside tabular numerals a
  hyphen reads as a dash. `KpiCard.tsx:173` already made this choice.
