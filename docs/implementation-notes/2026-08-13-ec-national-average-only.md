# 2026-08-13 — EC: store the country-wide price, not nine market-level copies

**Commit:** (pending — see PR)

Companion to #550, which stopped *drawing* EC's per-market series. This stops
*storing* them.

## The shape of the problem

EC publishes cereals per market — Burgas, Plovdiv, Varna, Ruse, Dobrich,
Pleven, Stara Zagora — alongside a country-wide "National Average" row.
`ecObservationsToItems` keys a series on `stage` and **drops `market`**, so
ingesting everything gave production twelve series in one Bulgarian wheat
group:

| | count | latest |
|---|---|---|
| National Average | 1 | 2026-07-27 |
| per-market, EC's old stage naming | 9 | 2026-07-20 (dead) |
| per-market, EC's new stage naming | 2 | 2026-08-03 |

The nine are dead because EC moved the market out of `stageName`
(`"Burgas - DEPPROD"` → `"Departure from farm…"` plus a separate `marketName`)
shortly before 2026-08-10. That changed the series key, so the old rows stopped
receiving points and flatline mid-chart.

The two survivors are worse than noise: because `market` is dropped, seven
market rows now collapse onto ONE key, and the job's per-(series, day)
aggregation turns them into a **median across seven markets** — an aggregation
nobody chose and nothing documents.

## The filter, and the arm that matters

`nationalAverageOnly` keeps the country-wide rows and discards the rest.

The interesting half is the fallback: when a region has no country-wide row,
**everything is kept**. That is not defensive padding, it is the live path for
sunflower — the oilseeds endpoint publishes no national average at all — and it
is the guard against the failure mode this codebase has already seen once. EC
restructures its vocabulary. When it next moves the words "National Average",
a filter that can return nothing would turn a rename into the silent, total
loss of a commodity's feed. Losing nine redundant series is a tidy-up; losing
wheat is an outage.

Scoped per REGION, because EC coverage genuinely differs by member state: BG
having a national average must not empty EL, which does not.

Recognition reads `market` OR `stage`, lower-cased, as a substring — the text
is EC's and they have already moved it once.

## Files

| file | role |
|---|---|
| `src/app-layer/jobs/market-prices-pull.ts` | `nationalAverageOnly` + both EC call sites |
| `tests/unit/market/ec-national-average-filter.test.ts` | the filter, executed |

## Decisions

- **Filtered at ingest as well as at display, not instead of it.** #550's
  `chartSeriesFor` still stands. The two answer different questions — what is
  worth *storing* versus what is worth *drawing* — and the display rule has to
  survive whatever is already in the database, including the twelve series
  currently there. Removing it once ingest is clean would break every existing
  deployment until its rows aged out.

- **Existing per-market rows are NOT deleted here.** They stop receiving points
  and `chartSeriesFor` already hides them. Pruning eleven years of history is
  destructive and belongs in its own reviewed step with real row counts in
  front of a human, not as a side effect of a code change. EC serves full
  history, so a prune is recoverable by re-pull — but "recoverable" is not
  "reversible without noticing".

- **The mutation proof is the fallback, not the filter.** Removing
  `? national : rows` and keeping only the matches makes the sunflower
  assertions return **zero observations** — precisely the silent-outage shape
  the arm exists to prevent. Two tests caught it.

## Not fixed here

`areas.tsx:91,132` and `PricesTab`'s `valueAccessor` both coerce a missing
value with `?? 0`. `buildMergedData` deliberately omits a series' key outside
its own reporting span so a dead series *stops*; the `?? 0` turns that into a
cliff to the floor and drags the Y axis down with it (visible in production on
2026-08-13, axis 0–200 for data spanning 175–200). The EC collapse hides it —
one line, no gaps — but diesel's two tax stages will hit it the first week EC
publishes one and not the other. It belongs in the Epic 59 chart platform with
its own tests, not bolted onto this.
