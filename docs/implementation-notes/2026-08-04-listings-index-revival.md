# 2026-08-04 — the index nobody could read, and the median one tenant could set

**Commit:** _(this change)_

## Two defects, and why they had to be fixed together

The own-listings index is the only path carrying farmer-owned data into
Trends. It was **dead**, and the thing that would have made it live was
**manipulable**. Reviving it alone would have shipped a "market price" any
single account could set.

### It was dead on one character

```
CreateOfferModal   seeds  'Wheat'      (Title-Case)
TrendCommodity     enum   'wheat'      (lowercase)
getPriceTrends     where: { commodity }  — exact, case-sensitive
```

Nothing normalised anywhere in that chain. So `findListingsSeries` returned
null forever, the tile showed "—" from the day it shipped, and the weekly
median was computed every Monday, written to the database, and never read.

CI did not notice because `listings-index.test.ts` used `commodity: 'wheat'`
— the casing production never writes. The fixture now uses `'Wheat'`.

### One tenant could set the published median

`computeListingsMedianIndex` pushed one price per **listing** but counted one
entry per **tenant**:

| | before | after |
|---|---|---|
| 100 listings @ 9999 from one tenant, plus two honest tenants @ 200/220 | published **9999**, `count: 3` | publishes **220**, `count: 3` |

The `count: 3` was the cruel part — it actively reassured the reader that
three independent parties agreed on a number one account had chosen. Each
tenant is now collapsed to its own median first, and the published figure is
the median of those: one tenant, one vote, however many listings it posts.

**The k-anonymity floor is untouched.** It is a privacy control and it was
correct; the estimator was what was wrong.

### Three incompatible bases were pooled

The scan was `status: 'ACTIVE'` plus a non-null price, and nothing else:

- **`side`** — `SELL` and `BUY` share the model and the `pricePerTonne`
  column, so asks and bids were averaged. They are opposite sides of a
  spread; their mean describes nothing.
- **`kind`** — wheat SEED and feed wheat are both commodity `'Wheat'`. Seed
  trades at a multiple, so admitting non-`CULTURE` rows inflated the index.
- **expiry** — the canonical browse read excludes past-expiry rows, so the
  index drew on a **superset** of what the marketplace shows. A farmer could
  not reconcile the published median against any listing on the board.

## Files

| File | Role |
|---|---|
| `src/lib/market/commodity-vocabulary.ts` | **New.** Canonical slugs + alias fold (incl. Bulgarian names). Pure, dependency-free. |
| `src/lib/market/listings-index.ts` | Normalise at the boundary; collapse per tenant before the median. |
| `src/app-layer/jobs/market-prices-pull.ts` | Narrow the predicate (side/kind/expiry), deterministic `orderBy`, log when the scan cap is hit. |
| `src/app-layer/schemas/exchange.schemas.ts` | `commodity` normalises on write instead of accepting free text. |
| `…/exchange/CreateOfferModal.tsx` | Options derived from the vocabulary; `onCreate` removed. |
| `tests/…` | Fixture switched to production casing; manipulation, normalisation and predicate tests. |

## Decisions

- **Normalisation happens at the index boundary AND on write.** Write-side
  alone would leave every existing row unreadable; boundary alone would let
  new free text keep arriving. Both, and the boundary skips what it cannot
  name rather than grouping it under its raw spelling — a one-off group can
  never clear the k-anon floor anyway, and admitting it would let free text
  fragment a real group's tenants.

- **Bulgarian names are aliases, not separate commodities.** The product is
  bilingual and the column has been free text since it shipped. `пшеница` and
  `Wheat` are the same intent typed by two users; grouping them apart is
  precisely how a real group falls below the floor and disappears.

- **`take` got an `orderBy`, not a bigger number.** With no ordering, `take`
  returned whatever Postgres scanned first, so past the cap the median was
  computed over an arbitrary sample that **resampled week to week** — the
  index moved with nothing in the market changing. Ordering by id makes the
  cut reproducible. Hitting the cap now logs, because a silently truncated
  index reads exactly like a complete one.

- **BUY is filtered out, not published as a second series.** The seam
  supports it — the predicate is one field — but a bid series needs its own
  label and its own place in the UI, and pooling was the defect. Asks only,
  and the tile says "asking prices".

- **BEHAVIOUR CHANGE: free-text commodities can no longer be listed.** The
  Combobox's `onCreate` let a seller invent one, and a rendered test asserted
  it worked. Constraining the vocabulary is what the roadmap asked for, and
  leaving the affordance in place would only produce a 400 after the form was
  filled in — so the affordance is gone and the test now asserts its absence.
  The cost is real: a commodity outside the ten canonical slugs cannot be
  listed until someone adds it to `CANONICAL_COMMODITIES`. That is a one-line
  edit, and making it deliberate is the point, but it is a capability the
  product had yesterday and does not have today.

- **The predicate is tested against real rows, not the pure function.** A
  unit test on `computeListingsMedianIndex` cannot see a `where` clause that
  lets bids in. The integration tests create actual `ExchangeListing` rows —
  SELL/BUY, CULTURE/SEEDS, expired/live — and assert the published median is
  unmoved by each.

## Follow-on

This vocabulary is the seed of the next PR's work: PR 3 maps the remaining
two surfaces (`Contract.commodity`, the tenant crop catalogue) onto it and
backfills existing free text, which is what makes a market-vs-contract
comparison expressible at all.
