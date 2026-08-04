# 2026-08-05 — one vocabulary, and Trends stops being an island

**Commit:** _(this change)_

Third and last PR of the trends roadmap.

## The product gap, and why it was unbuildable

Nothing outside the trends components consumed market prices. The product
could show a farmer what wheat costs and, on the next screen, a wheat
contract, and never put the two in one sentence — no "am I selling above or
below market?" anywhere.

The root cause was not a missing feature. It was that **four vocabularies
named commodities and none agreed**:

| surface | spelling |
|---|---|
| `TrendCommodity` enum | `'wheat'` |
| `ExchangeListing.commodity` | free text, `'Wheat'` |
| `Contract.commodity` | free text, `'Malting Barley'` |
| tenant crop catalogue | free text, any language |

With no join key the integration was **unbuildable**, not merely unbuilt.

## STEP 1 — the vocabulary reaches every surface

`commodity-vocabulary.ts` (PR 2) now backs a derived
`commodityCanonical` column on `Contract`, `YieldRecord` and `CropType`,
backfilled by `20260805090000_commodity_canonical` using the same fold the
TypeScript uses, and maintained on every write.

**The free text stays.** "Malting Barley" is not "Barley" — the distinction
is commercially real and it is what the farmer read off the paper contract.
Destroying it to gain a join key would be a bad trade, so the slug lives
*beside* it. That differs from `ExchangeListing`, where the commodity IS the
trading category buyers filter on and the create form only ever offered a
fixed list, so canonical-in-place was right there.

## STEP 2 — the fork, and which way it went

The roadmap offered three: contract-vs-market on the contracts list,
listing-vs-index on the exchange, stored-inventory value on yield/bins.

**Chosen: contract price vs market.** It is the literal question the brief
poses, `Contract` already carries `pricePerTonne` + currency + volume, and a
contract is a commitment a farmer can still act on — a signed price they can
weigh against today's market before signing the next one. Stored-inventory
value is derivative of the same join and is the natural follow-up;
listing-vs-index compares a farmer's ask against the median of other asks,
which is a weaker question.

`benchmarkContract` refuses more than it answers, on purpose:

- **Never converts currencies.** A BGN contract against a EUR/t quote returns
  `CURRENCY_MISMATCH`. Inventing an FX rate to make them look comparable is
  exactly the defect the no-conversion invariant exists to prevent — the rate
  would be wrong, undated and invisible in the output.
- **A missing contract currency is a mismatch, not a match.** Assuming is how
  two incomparable prices get subtracted.
- **Never benchmarks against a stale market.** "You are 12% below market" is a
  claim about today.
- **Never benchmarks against our own noticeboard.** `getMarketReferences`
  excludes the listings index: comparing a farmer's contract to the median
  asking price on our own board would be telling them how they compare to
  their neighbours' hopes and calling it the market.

## The rest

| Item | What it was |
|---|---|
| **Intraday cron nullified** | Barchart pulled every 20 min; the read cached 6h with no invalidation. Licensed requests spent writing rows no reader would see for hours. The pull now invalidates the exact key space it touched. |
| **Series labels going stale** | `currency`/`unit` sat outside the natural key and were written only on create, so a denomination change appended new-currency points to the old series under the old label. It happened, and was fixed by hand-written SQL. They are now part of series identity in the code AND the DB unique, so a change mints a new series. |
| **API keys reachable by Sentry** | Both market clients put the key in the QUERY STRING, Sentry's HTTP breadcrumbs capture outbound URLs, and rate-limit throws are the expected steady state. `apikey` and friends added to `SENSITIVE_PARAMS`. |
| **Errors looked like empty** | `error != null \|\| isEmptyPayload(data)` meant a 500, a 429, and a dropped rural connection all read as "No data for this period" plus an env-var lecture. Split, on both tabs. |
| **Env-var hints shown to farmers** | `EC_AGRIFOOD_BASE_URL` is an instruction a farmer cannot act on, and it leaks deployment shape. Admin-gated. |
| **Interests ignored by Prices** | `UserInterest` synced across devices and only the news filter read it; Prices always opened on wheat. It now opens on the first stated interest that has a price series. |
| **Interests silently lost** | `onClose()` sat outside `if (res.ok)` with no catch, so a failed save closed the modal exactly like a success. The modal now stays open holding the draft. |
| **Headline frozen in the past** | Point pagination took the OLDEST 1000, so on `range='all'` a long series' "latest" price was wherever the cap stopped. Ordered desc + reversed. |
| **Cold-start cost** | Both trends GETs now use `jsonWithETag`. |

## Decisions

- **`commodityCanonical` is derived and never user-supplied**, and is
  recomputed on every commodity edit including clearing it. A stale canonical
  would silently keep benchmarking a contract against the wrong market.

- **References are fetched once per PAGE, not per row.** One extra query for
  the whole contracts page (query-shape guardrail D1).

- **Cache invalidation enumerates keys rather than SCAN.** The key space is
  (commodity × range) — both small closed sets — so the exact list is cheap
  and carries none of the hazards of a pattern scan on a shared Redis.

- **Widening the series unique is safe for existing rows** — they were already
  unique under the narrower key.

- **A test fixture had to change to stay honest.** `trends-usecase.test.ts`
  mocked points in ascending order; the query now asks for descending. The
  fixture mimics the DB, or the test proves nothing about the real ordering.

## Not done

- **`YieldRecord` and `CropType` carry the join key but nothing reads it
  yet.** They were mapped because leaving two of four surfaces unreconciled
  would leave the vocabulary half-built, but stored-inventory value is a
  follow-up.
- **No backfill of `ExchangeListing` rows whose commodity is outside the
  vocabulary** — they keep their free text and stay out of the index, which is
  the safe direction.
