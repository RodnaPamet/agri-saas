# 2026-08-12 — Trends → Prices: one chart, and a tile that cannot contradict it

**Commit:** (pending — see PR)

Opening Prices for Пшеница drew **four cards**. Same title, same source label,
same `EUR/t` unit; a small region chip was the only difference.

Design rationale and the rejected alternatives are in
`docs/superpowers/specs/2026-08-12-trends-single-official-price-chart-design.md`.
This note records what shipped.

## Design

The four cards were not four sources. `groupSeriesByRegionUnit` partitions by
`(region, currency, unit)`, and `market-prices-pull` fetches EC prices for four
member states:

```js
const EC_MEMBER_STATES = ['BG', 'RO', 'EL', 'EU'];
```

Bulgaria adopted the euro in 2026, so all four share a currency and a unit and
differ only in region. The grouping is still correct — those series genuinely
must not share a Y axis — but *drawing every group* conflated "must not share an
axis" with "must not share a screen". Diesel had it too: the Oil Bulletin is
pulled for the same four regions.

`selectPrimaryGroup(groups)` now picks the one group to draw:

1. `region === 'BG'` — the market a farmer here is paid in
2. `region === 'EU'` — the union average, when BG has not reported
3. the group holding `primarySeries(...)` — whatever reported most recently

Arm 3 is what makes this one rule instead of a crop rule with exceptions:
fertilizer is World Bank `GLOBAL` and falls through unchanged, and a commodity
arriving in an unlisted region still draws something rather than nothing.

Two things it deliberately does NOT do. It does not narrow *within* a group —
diesel's with-tax and without-tax are one `(BG, EUR, 1000l)` group and stay two
lines, because they are different numbers and both wanted. And it does not lead
with our own noticeboard: a region can hold two groups (EC in `EUR/t` and the
own-listings median in `BGN/t` are both `BG`), so a plain "first BG group" would
have resolved on backend result ordering, and the losing outcome is the page
presenting the median of our users' *asking* prices as the official one. Pure
groups are filtered out of candidacy unless they are all that exists.

## The tile was quietly lying, in the translation file

`PricesTab` derived its headline from `findEcSeries(data.series, 'BG')` with the
region hard-coded, so an EU fallback would print the no-data dash directly above
a populated chart. It now reads `leadSeriesOf(chartGroup)` — EC stage preference
first, then most-recent — so tile and chart cannot disagree.

The copy needed the same treatment, and this is the part no compiler could have
caught: `trends.tiles.bgLatest` held the literal string `"BG price (official)"` /
`"Цена BG (официална)"`. The region lived in the translated **value**, with
nothing relating it to the code selecting `region === 'BG'`.

Region-neutral alone was not enough. The input branch renders the same label, so
a hand-typed MAP price was already publishing itself as *official*. The key is
now `trends.tiles.latestPrice` (`Latest price` / `Последна цена`) — true whether
the headline is EC, the Oil Bulletin, the World Bank or somebody's typing — and
the tile drops `hideSource` so `SeriesProvenance` states which under every
price.

## Files

| file | role |
|---|---|
| `src/components/trends/trends-helpers.ts` | `selectPrimaryGroup` + `leadSeriesOf`, pure |
| `src/components/trends/PricesTab.tsx` | draws one group; tile follows it; narrowed `isInput` fork |
| `messages/{en,bg}.json` | `tiles.bgLatest` → `tiles.latestPrice` |

## Decisions

- **Filtered at the display layer, not at the pull.** Deleting RO/EL from
  `EC_MEMBER_STATES` would have produced the same screenshot for a fraction of
  the diff — and silently moved money. `getMarketReferences` queries
  `MarketPriceSeries` with **no region filter**; any EC or Alpha Vantage series
  whose unit ends in `/t` is a benchmark candidate, and it feeds `contract.ts`
  and `grain-net-worth.ts`. A complaint about chart clutter must not change
  contract benchmark prices.

- **Not filtered in the usecase either.** Smaller payloads matter on rural LTE,
  but the listings and reference tiles read series from other regions and
  sources, so the endpoint would have had to return "one chart series plus two
  tile series" — a presentation decision baked into a Redis-cached global read
  path whose cache key would then have to encode it.

- **The `isInput` fork narrowed rather than vanished.** It existed because EC /
  listings / Alpha Vantage publish nothing for diesel, so inputs would render
  empty crop tiles. With one selection rule the headline tile is identical on
  both sides, so the fork now governs only whether the listings + reference
  tiles render.

- **The ordering bug was found by writing the test, not by reading the code.**
  The first `selectPrimaryGroup` took the first region match and passed the
  fixture — the existing `READY` payload happens to list EC before listings.
  Asserting the same input in reverse order failed, which is what promoted
  "prefer a real quote over our own noticeboard" from an implicit accident of
  backend `ORDER BY source ASC` into a stated rule.
