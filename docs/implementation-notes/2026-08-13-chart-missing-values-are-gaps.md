# 2026-08-13 — A missing value is a gap, not a zero

**Commit:** (pending — see PR)

Two pieces of care cancelled each other out, and the result was worse than
either failure alone.

`buildMergedData` goes to real trouble to **omit** a series' key outside its own
reporting span — its docblock explains that forward-filling a dead feed to today
"draws a confident flat line that says *still trading here* about a feed that
went silent months ago". Then the consumer wrote:

```ts
valueAccessor: (d) => d.values[k] ?? 0
```

which turned the carefully-omitted key into a real price of **zero**.

Observed in production on 2026-08-13: two EC wheat series that stopped on
2026-07-20 plunged from ~190 to the floor at the right edge of the chart. And
because a genuine `0` enters the y-domain, the axis rendered **0–200 for data
spanning 175–200**, flattening every real price movement into the top tenth of
the plot.

`computeYDomain` was already correct — `if (v != null)` at `layout.ts:148,154`.
It never got the chance: the accessor handed it a number.

## The type was the root cause

```ts
export type AccessorFn<T extends Datum, TValue = number> =
    (datum: TimeSeriesDatum<T>) => TValue;
```

`number`. Not `number | undefined`. So every consumer's null-handling looked
like paranoia against a case the compiler said could not happen — and each
author resolved it alone, in the way that made local sense:

| site | what it did with "impossible" undefined |
|---|---|
| `computeYDomain` | skipped it (correct) |
| `Areas` y-coordinate | `?? 0` (became the cliff) |
| `Bars` filter/sort | compared it as a number |
| tooltip dot | `yScale(undefined)` → NaN |
| default tooltip text | `.toString()` on undefined |

Widening the default to `number | undefined` surfaced all nine sites at once
and turned "what does missing mean here?" into a question the compiler asks
rather than one each author answers privately.

## The fix per site

- **`Areas`** — `defined={(d) => s.valueAccessor(d) != null}` on both
  `AreaClosed` (fill) and `Area` (stroke). The `?? 0` on `y` STAYS: d3 invokes
  `y` for undefined points regardless of `defined`, and `yScale(undefined)` is
  NaN, which poisons the whole path. `defined` decides whether a point is
  drawn; `y` only has to not throw.
- **Latest-value dot** — walks back to the series' own last reported point.
  `data.at(-1)` is the last row of the *dataset*, which belongs to whichever
  series is still reporting; reading a stopped series there gives undefined.
- **`Bars`** — `?? 0` in the filter and sort, deliberately. For a STACK an
  absent value and a zero-height bar are the same thing; that equivalence is
  what makes the line case different, not an inconsistency.
- **Tooltip dot** — renders nothing where the series has nothing. A dot at NaN
  is dropped by some browsers and painted at the origin by others, and a dot on
  the floor of a hovered chart reads as a real reading of zero.
- **Tooltip text** — `?? "—"` instead of `undefined`.

## Files

| file | role |
|---|---|
| `src/components/ui/charts/types.ts` | `AccessorFn` / `Series` admit `undefined` |
| `src/components/ui/charts/areas.tsx` | `defined` on both shapes; dot on the last REPORTED point |
| `src/components/ui/charts/bars.tsx` | stack arithmetic tolerates absent |
| `src/components/ui/charts/time-series-chart.tsx` | no tooltip dot / no `"undefined"` text |
| `src/components/ui/charts/use-tooltip.ts` | tooltip position never NaN |
| `src/components/trends/trends-helpers.ts` | `chartValueAccessor` — the contract, named |
| `tests/unit/chart-missing-values.test.ts` | accessor + y-domain composition, executed |
| `tests/guards/chart-gap-rendering.test.ts` | the `defined` wiring |

## Decisions

- **The split between the executed test and the guard is stated, not implied.**
  CLAUDE.md is right that a guard proves a pattern exists and never runs the
  subject. The value contract IS executed — the unit test runs the real
  accessor and the real `computeYDomain` over real `buildMergedData` output,
  and asserts the domain is `[178, 191]` rather than starting at 0. What no
  jsdom test can reach is the path `d`: both shapes are `motion.path` whose `d`
  framer-motion animates from `path(zeroedData)`, so an assertion would read
  the zeroed initial frame or flake. Hence a guard for the wiring, with a
  mutation proof — removing `defined` from the line only (the subtle
  half-wiring case, which leaves a filled region under a broken stroke) drops
  the match count 2 → 1 and fails.

- **A genuine zero still plots.** `0` is a price; absent is not. The accessor
  returns `d.values[key]` with no coalescing, so a real zero passes through and
  only a missing key is a gap.
