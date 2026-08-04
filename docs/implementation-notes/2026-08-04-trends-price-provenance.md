# 2026-08-04 — a price is not a number

**Commit:** _(this change)_

## The problem

The backend computes source, label, currency, stage and observation date
honestly. The UI dropped four of them.

The sharpest consequence was on the dashboard. `MarketTrendsWidget` picks
its headline series `findEcSeries('BG') ?? findListingsSeries() ??
findReferenceSeries()`, and the render block never read `s.source` —
grep for `source` in that file returned nothing. So:

- an **official EU quote**, and
- the **median of three neighbours' ASKING prices on our own noticeboard**

rendered pixel-identically under the same "Market trends" heading. Adjacent
carousel slides could differ in source with no cue whatsoever. A farmer
pricing a harvest off the second, believing it was the first, loses real
money.

Alongside that, three quieter dishonesties:

- **No freshness on the wire at all.** `readFromDb` selected only
  `{ date, price, meta }` and the payload had no `generatedAt`, so the
  client *could not* compute staleness even if it wanted to.
- **Dead series drawn as live.** `buildMergedData` forward-filled to the
  union of all dates in the group, so a feed that stopped reporting in
  January was extended at its last price to whatever the newest date any
  *other* series reported — a confident flat line through today.
- **Barchart called "Other source"**, while the pull already computed
  `'Futures (Barchart, delayed)'` and shipped it as `TrendSeries.label`,
  which no component rendered.

## Design

One component, `SeriesProvenance`, renders WHERE a price came from, HOW OLD
it is, and what it is not. Both the dashboard widget and the Prices tab use
it, so the wording cannot drift between the two places a farmer reads the
same number.

```
TrendSeries ─┬─ source ──→ sourceLabelKey  → "Official prices (EC)"
             │                             → "Asking prices on Agrent"
             │                             → "Futures (delayed)"
             ├─ stage ───→ "Stage: FGATE"
             ├─ lastObservedAt ─┬─ fresh → "as of 17 Mar 2026"
             │                  └─ stale → "Not updated since 2 Feb 2026"
             └─ currency ─→ formatPriceWithCurrency on every tile
```

Staleness is `generatedAt − lastObservedAt`, both server-side. The browser
clock is not a sound reference on a rural device, and the payload is
Redis-cached, so the server's own timestamp travels with the data.

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/trends.ts` | Ship `generatedAt` + per-series `lastObservedAt`; cache key v1 → v2. |
| `src/components/trends/SeriesProvenance.tsx` | **New.** The shared provenance line. |
| `src/components/trends/trends-helpers.ts` | `barchart` source key, `isDelayedSource` / `isOwnMarketplaceSource`, `stalenessDays` / `isStale`, bounded fill, pinned EC stage. |
| `src/components/trends/MarketTrendsWidget.tsx` | Carry provenance out of the headline memo; render it and the currency. |
| `src/components/trends/PricesTab.tsx` | `StatTile` footer slot; provenance on all three tiles; currency on the two bare ones. |
| `messages/{en,bg}.json` | `sources.futures` + the `provenance.*` block. |

## Decisions

- **`lastObservedAt` needed its own aggregate.** It could not ride on the
  `points` include, because that relation is already filtered to the range
  window — on `range='1m'` the last in-window point would masquerade as the
  series' latest, and a series that has since gone quiet would look current.
  A grouped `max(date)` over the same bounded id set answers the real
  question, in one extra query rather than one per series (query-shape
  guardrail D1).

- **The cache key was bumped to v2.** A v1 entry deserialises without the
  new fields, so for up to the 6h TTL the UI would render "as of undefined"
  and treat every series as unjudgeable. Bumping retires them instantly.

- **The stale threshold is 15 days, and the reasoning is in the code.** The
  pull is weekly, so one missed publication is routine; a warning that fires
  whenever a feed slips a day is a warning nobody reads. Two full cycles plus
  slack means a genuinely missed publication.

- **The fill is bounded to each series' own reporting span, at both ends.**
  Trailing fill was the bug that drew dead series as live. Leading back-fill
  was the same lie pointing backwards — inventing pre-history across weeks a
  series never reported. Forward-fill *within* the span stays, because a
  one-week gap in an otherwise-reporting series is a reporting-calendar gap
  and dipping to zero would be its own falsehood.

- **The EC stage is pinned AND named.** Naming alone would leave the tile
  silently switching stage the day EC adds one that sorts earlier; pinning
  alone would just make a possibly-wrong-stage reading stable. Ex-farm leads
  the preference order because it is the number a farmer actually receives —
  `readFromDb` orders by stage ascending, so `DEPPORT` previously beat
  `FGATE` on spelling alone.

- **A test that encoded the defect was rewritten, not deleted.**
  `buildMergedData` had a passing test asserting that leading gaps ARE
  back-filled. It now asserts the opposite, and a sibling test pins the
  dead-series case, so the honest behaviour has the same protection the
  dishonest one had.

- **The negative rendered assertions are the point.** "Does it render a
  label" keeps passing under almost any regression; `queryByText('Listings
  index')` returning null is what proves an asking price cannot read as a
  market quote.

## Not addressed here

The Listings tile is still empty in production — the index is dead on
commodity casing, and reviving it exposes an estimator one tenant can move.
That is the next PR in this roadmap; the wording added here is what it will
land on top of.
