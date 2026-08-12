# 2026-08-12 — Trends → Prices: one official-price chart per commodity

## Problem

Opening Trends → Prices for Пшеница renders **four chart cards**. All four
carry the same title, the same source label ("Официални цени (ЕК)") and the
same `EUR/t` unit; only a small region chip distinguishes them.

The cause is not four sources. `groupSeriesByRegionUnit` partitions by
`(region, currency, unit)`, and `market-prices-pull.ts` pulls EC prices for
four member states:

```js
const EC_MEMBER_STATES = ['BG', 'RO', 'EL', 'EU'];
```

Bulgaria adopted the euro in 2026, so BG / RO / EL / EU share a currency and a
unit but not a region — hence four cards. Alpha Vantage (`GLOBAL`/USD) and the
own-listings index add a fifth and sixth where configured.

The region split guards a real invariant — two regions sharing a currency must
not be conflated — but that justifies separate *axes*, not separate *cards*.
Romania and Greece are noise for a Bulgarian operator.

Diesel has the identical problem: `market-prices-pull.ts` pulls road diesel for
the same four regions from the EC Oil Bulletin.

## Decision

Render **exactly one chart card per commodity**, chosen by a single rule that
applies to every commodity — crop, fuel and fertilizer alike.

### The selection rule

A new pure helper in `trends-helpers.ts`, beside the `findEcSeries` /
`primarySeries` family it resembles:

```ts
const REGION_PREFERENCE = ['BG', 'EU'] as const;

export function selectPrimaryGroup(groups: ChartGroup[]): ChartGroup | null;
```

First match wins:

1. the group whose `region === 'BG'` — the market a Bulgarian farmer is paid in
2. the group whose `region === 'EU'` — the EU average, when BG has no data
3. the group containing `primarySeries(...)` — the most recently observed series

Step 3 is what makes this one rule rather than a crop rule with exceptions.
Fertilizer's only group is `GLOBAL` and falls through to it unchanged; a future
commodity in an unlisted region still draws a chart instead of a blank.

Series *within* the chosen group are untouched. Diesel's `with-tax` and
`without-tax` are two stages of the same `(BG, EUR, 1000l)` group and remain two
lines on one card — they are genuinely different numbers.

### The headline tile follows the chart

`PricesTab` currently derives its headline tile from
`findEcSeries(data.series, 'BG')` with the region hard-coded. Once the chart can
fall back to EU, that tile would read "no data" above a populated chart.

The tile now takes the **lead series of the chosen group**: EC stage preference
(`FGATE`, `EXW`, `DEPSILO`, `DEPPORT`) when the group holds EC series, otherwise
`primarySeries(group.series)`. Tile and chart cannot disagree.

### The tile copy stops naming a region

`trends.tiles.bgLatest` is `"BG price (official)"` / `"Цена BG (официална)"` —
the region is baked into the translated **value**, where no compiler can relate
it to the code selecting `region === 'BG'`. Renamed to
`trends.tiles.officialLatest`, region-neutral in both locales (`Official price`
/ `Официална цена`).

Region stays legible: the chart legend directly below renders `{s.region}` next
to the source name, and there is now exactly one legend. `SeriesProvenance` is
deliberately NOT given a region field — it is shared with the dashboard widget,
and the information would be redundant two lines from the legend.

### The `isInput` fork narrows

The fork exists because EC / listings / Alpha Vantage publish nothing for diesel
or urea, so inputs would render three "no data" tiles. With one selection rule
the headline tile is identical on both sides, so the fork collapses to a single
question: do the listings + reference tiles render (`!isInput`). All three tiles
are kept for crops.

## Rejected alternatives

**Filter in the `/trends/prices` usecase.** Smaller payload, which matters on
rural LTE. But the listings and reference tiles read series from other regions
and sources, so the endpoint would have to return "one chart series plus two
tile series" — a presentation decision baked into a Redis-cached global read
path, with the cache key forced to encode it.

**Stop pulling RO/EL in the job.** Rejected on blast radius.
`getMarketReferences` queries `MarketPriceSeries` with **no region filter** —
any EC or Alpha Vantage series whose unit ends in `/t` is a benchmark candidate
— and it feeds `contract.ts` and `grain-net-worth.ts`. Dropping regions from the
pull would silently move contract benchmark prices and net-worth valuations. A
display complaint must not change money numbers.

## Files

| file | role |
|---|---|
| `src/components/trends/trends-helpers.ts` | `selectPrimaryGroup` + `leadSeriesOf`, pure |
| `src/components/trends/PricesTab.tsx` | render one group; tile follows it; narrowed fork |
| `messages/{en,bg}.json` | `tiles.bgLatest` → `tiles.officialLatest` |
| `tests/unit/trends-helpers.test.ts` | the rule, executed |
| `tests/rendered/trends-prices-tab.test.tsx` | one card from a four-region payload |
| `tests/rendered/trends-input-categories.test.tsx` | picks up the key rename |

## Out of scope

`groupSeriesByRegionUnit` (still correct, still the input to selection), the
pull job's `EC_MEMBER_STATES`, and the `/trends/prices` payload shape.
