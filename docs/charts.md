# Chart Platform (Epic 59)

Inflect's chart platform lives under `src/components/ui/charts/`
(interactive primitives) and alongside it in `src/components/ui/`
(compact widgets). This doc is the decision tree for contributors —
pick the right primitive before writing new chart JSX.

## TL;DR — decision table

| I want to show… | Use | Lives in |
|---|---|---|
| A **time-series** someone will hover/scrub/compare | `TimeSeriesChart` + `Areas`/`Bars` + `XAxis`/`YAxis` | `@/components/ui/charts` |
| A **sparkline** inside a KPI tile / table cell (no tooltip, no axes) | `MiniAreaChart` | `@/components/ui/mini-area-chart` |
| A **dashboard trend tile** (label + current value + hoverable sparkline) | `TrendCard` | `@/components/ui/TrendCard` |
| A **single-value progress** metric (one bar, advances toward a max) | `ProgressBar` | `@/components/ui/progress-bar` |
| A **signed magnitude** either side of zero (profit/loss per row, on a shared scale) | `DivergingBar` | `@/components/ui/diverging-bar` |
| A **categorical distribution** of rows sharing a total (status / severity / coverage breakdown) | `StatusBreakdown` | `@/components/ui/status-breakdown` |
| A **headline gauge** (single percentage that deserves its own real estate) | `ProgressCircle` | `@/components/ui/progress-circle` |
| A **segmented % bar with a legend** (e.g. control coverage breakdown) | `ProgressCard` | `@/components/ui/ProgressCard` |
| A **percent-share donut** | `DonutChart` | `@/components/ui/DonutChart` |
| A **risk heat-map** | `RiskHeatmap` | `@/components/ui/RiskHeatmap` |

If none of the above fits, **don't open a new file with raw `<svg>` in a
dashboard page**. Ask about extending the platform instead — a one-off
hand-rolled chart is exactly the pattern this epic replaced.


### `ProgressBar` vs. `DivergingBar` — the sign decides

`ProgressBar` floors its input with `Math.max(0, value)` before computing
anything, so **a negative and a zero are indistinguishable** in the fill,
the visible label, `aria-valuenow` and `aria-valuetext`. That is correct
for progress — you cannot be less than 0% done — and wrong for any signed
quantity.

If the value can go below zero and the reader needs to know that it did,
use `DivergingBar`. It renders either side of a visible baseline, takes a
shared `max` (pass `max(|value|)` across the group, or every row looks the
same length), announces itself as `role="meter"` with a negative
`aria-valuemin`, and states `data-scale="none"` rather than drawing
anything when there is no positive scale to draw on.

Note it plots a bare magnitude, so pass `valueText` with the units — or,
if the row already prints the figure as text, mark the bar `aria-hidden`
so the value is not announced twice. The grain calculator does the latter.


## `TimeSeriesChart`

The canonical interactive chart. Renders one or more series with a
time-based x-axis, a numeric y-axis, responsive sizing, and a shared
tooltip-hover surface.

```tsx
import {
    Areas,
    TimeSeriesChart,
    XAxis,
    YAxis,
    type TimeSeriesDatum,
} from "@/components/ui/charts";

<TimeSeriesChart
    data={data} // TimeSeriesDatum<YourDatum>[]
    series={[
        {
            id: "coverage",
            isActive: true,
            valueAccessor: (d) => d.values.coverage,
            colorClassName: "text-emerald-500",
        },
    ]}
    type="area" // or "bar"
>
    <YAxis showGridLines />
    <Areas />
    <XAxis />
</TimeSeriesChart>
```

Rules:

- **Always** set `isActive: true` on at least one series — `<Areas>` /
  `<Bars>` filter by it.
- **Use token-backed classes** (`text-emerald-500`, `text-content-error`)
  on `colorClassName`. Never hardcode hex in call sites.
- **Leave axes off** if the chart is a compact sparkline — reach for
  `MiniAreaChart` instead unless you actually need hover/tooltip.
- **Empty-state handling is built in.** Pass a custom `emptyState` when
  the default "No data available" is too loud for the surface (e.g.
  sparklines inside cards should use a soft baseline instead).

## `MiniAreaChart`

Compact sparkline. No tooltip, no axes, token-backed colour variants.
Renders a dashed baseline when `data` is empty.

```tsx
<MiniAreaChart
    data={[{ date, value }, ...]}
    variant="success"          // brand | success | warning | error | info | neutral
    aria-label="Coverage trend — last 30 days"
/>
```

Use it when the trend *direction* is the signal and hover detail isn't
required. Inside KPI cards, table cells, summary tiles.

## `TrendCard`

A `MiniAreaChart`-style tile with a header row (label + current value)
and a **`TimeSeriesChart`**-backed hoverable sparkline below. The
dashboard consumer — use it whenever you have a labelled trend in a
grid of trend cards.

```tsx
<TrendCard
    label="Coverage"
    value={75.3}
    format="%"
    points={[{ date, value }, ...]}
    colorClassName="text-emerald-500"
/>
```

## `ProgressBar` vs `ProgressCircle`

Both are token-backed, ARIA-complete, carry the same variant tokens
(`brand | success | warning | error | info | neutral`).

**Pick `ProgressBar`** when:

- You have **several related metrics** to show together (pass/fail/
  inconclusive; or a row per framework)
- The metric reads naturally as a **horizontal segment** of 0–100%
- **Space is tight vertically** — `size="sm"` fits into a KPI tile
  or a table row
- You want a **label + value** alongside the fill (use `showValue`)

**Pick `ProgressCircle`** when:

- One metric **deserves its own headline** — a gauge the eye lands on
  first
- You want the metric to be **scannable at a distance** (donut shape
  reads faster than a thin bar at small widths)
- You're showing **overall health** summarising more granular bars
  below (the pattern used in `/tests/dashboard` Result Distribution)

Don't use both for the same metric in the same card — pick one.

## Shared chart context, tooltips, axes

Three patterns every interactive chart should follow:

### 1. Compose, don't reimplement

`TimeSeriesChart` provides `<ChartContext.Provider>` and
`<ChartTooltipContext.Provider>` wrapping its children. Every axis,
shape layer, and overlay reaches into those contexts via:

```tsx
const { data, series, xScale, yScale } = useChartContext();
const { tooltipData } = useChartTooltipContext();
```

Never re-scale, re-measure, or rebuild tooltip state inside a custom
overlay — `TimeSeriesChart` already did it.

### 2. Token-backed surfaces only

Tick colours, grid lines, axis text, and the focus ring all resolve
against design tokens already. If you pass a `colorClassName` to a
series, use `text-*` / `bg-*` / `border-*` utilities — they inherit
the light/dark theme flip.

### 3. Empty/loading/error states

`ChartState<T>` from `@/components/ui/charts` models `loading / empty /
error / ready` uniformly. Use the constructors (`chartLoading`,
`chartEmpty`, `chartError`, `chartReady`) + the type guard
(`isChartReady`) when wiring server data into a chart. Don't branch on
`data.length === 0` — the chart handles that itself and renders the
caller-provided `emptyState`.

## Do-not-bypass list

A dashboard page failing the guard in
`tests/guardrails/dashboard-chart-bypass.test.ts` almost certainly
bypassed the platform with one of these:

- Raw `<polyline>` / `<path d="M…">` SVG sparklines (use `MiniAreaChart`
  or `TrendCard`).
- Inline `<div style={{ width: \`${percent}%\` }}>` progress bars (use
  `ProgressBar`).
- `<div className="h-full bg-<color>-400 rounded-full">` — same.
- Imports of legacy files (`@/components/ui/TrendLine` — removed in
  Epic 59).

If you have a real need the platform doesn't cover, extend the
platform: add a new primitive under `src/components/ui/charts/` and
re-export it from `src/components/ui/charts/index.ts`.

## ProgressBar vs. StatusBreakdown — the one decision everyone confuses

Both render percentage-shaped visuals, but they mean different things.
Get the choice wrong and the UI misleads the user about what's being
measured.

### `ProgressBar` (single value toward a max)

One bar. One value. One goal. Use it when you're saying:

> "We are 73% of the way to some target."

Examples: framework coverage ("73% of requirements mapped"), audit
readiness score, file-upload progress, retention SLO attainment.

```tsx
<ProgressBar
    value={coveragePercent}
    size="md"
    variant={coveragePercent === 100 ? 'success' : 'brand'}
    aria-label="Framework coverage"
/>
```

### `StatusBreakdown` (categorical distribution sharing a total)

Several rows. Several values. A shared denominator. Use it when you're
saying:

> "Of 16 tasks, 12 are Active, 3 Pending, 1 Offboarding."

Examples: task status breakdown, vendor severity distribution, risk
status rollup. The row-level bar represents that row's **share of the
total**, not its progress toward a goal.

```tsx
<StatusBreakdown
    ariaLabel="Tasks by status"
    items={[
        { label: 'Active',  value: 12, variant: 'success' },
        { label: 'Pending', value: 3,  variant: 'warning' },
        { label: 'Offboarding', value: 1, variant: 'neutral' },
    ]}
/>
```

### Smell test

- Does each row add to the total? → `StatusBreakdown`.
- Is there one value and a target (even if the target is 100%)? →
  `ProgressBar`.
- Are you tempted to render multiple `<ProgressBar value=…>` in a
  stack? Stop — that's `<StatusBreakdown>`.
- Are you tempted to render `<StatusBreakdown>` with a single row?
  Stop — that's `<ProgressBar>`.

## Anti-patterns — do not revive

The `dashboard-chart-bypass` guard (`tests/guardrails/dashboard-chart-bypass.test.ts`)
scans every `(app)/**/*.tsx` and fails CI on any of the following
patterns. Don't try to work around it — the guard exists because each
of these was the specific drift Epic 59 had to migrate away from.

- `style={{ width: `${pct}%` }}` on a raw `<div>` — use `ProgressBar`
  (single) or `StatusBreakdown` (multi-segment) instead.
- A raw `<polyline>` / `<svg>` sparkline — use `MiniAreaChart` or
  `TrendCard`.
- An import of `@/components/ui/TrendLine` — that file was deleted;
  the replacement is `TrendCard` or `MiniAreaChart`.
- A hand-picked hex colour (`#22c55e`, `#38bdf8`, …) for chart /
  progress fill — use a semantic variant (`success`, `warning`,
  `error`, `info`, `brand`, `neutral`) so re-theming under Epic 51
  light-mode works.

If you genuinely need an escape hatch for a categorical visual the
shared platform can't serve, annotate the line with `//
chart-bypass-ok: <one-sentence justification>` and note the missing
primitive on the platform backlog. The suppression tag is documented
at the top of the guard file. It was at 0 active users after the
StatusBreakdown rollout; keep it that way.

## New primitives — when to add one

Before opening a new file with `<svg>` / inline widths in a dashboard
or detail page, check:

1. Does the TL;DR decision table cover this case? If yes, use that
   primitive.
2. Is the same pattern appearing in ≥3 places across the app? If
   yes, propose a new primitive + a ratchet to prevent regression.
3. Is this a one-off requiring bespoke shape / interaction? Push
   back — it's almost always the sign of a missing table row in the
   decision tree, not a legitimate exception.

The shared platform started with two primitives and grew to a dozen
by converging every dashboard on the same set. Future growth follows
the same path: new primitive + guard entry + doc row.

## Where to look first

- Barrel: `src/components/ui/charts/index.ts`
- Canonical chart: `src/components/ui/charts/time-series-chart.tsx`
- Shared layout helpers: `src/components/ui/charts/layout.ts`
- Public types: `src/components/ui/charts/types.ts`
- Single-value progress: `src/components/ui/progress-bar.tsx`
- Multi-segment breakdown: `src/components/ui/status-breakdown.tsx`
- Guidance tests: `tests/unit/chart-layout-helpers.test.ts`,
  `tests/rendered/time-series-chart.test.tsx`,
  `tests/rendered/micro-visuals.test.tsx`,
  `tests/rendered/trend-card.test.tsx`,
  `tests/rendered/kpi-card-trend.test.tsx`,
  `tests/rendered/status-breakdown.test.tsx`,
  `tests/guardrails/dashboard-chart-bypass.test.ts`.
