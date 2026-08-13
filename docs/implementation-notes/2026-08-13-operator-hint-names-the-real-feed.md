# 2026-08-13 — The operator hint names the feed that actually publishes the price

**Commit:** (pending — see PR)

A farmer opened Trends → Торове → Урея, saw an empty chart, and read this:

> **За оператори** — Пазарните данни се зареждат от планирана задача.
> Конфигурирайте `EC_AGRIFOOD_BASE_URL` и `ALPHA_VANTAGE_API_KEY`, за да ги
> активирате.

Every clause of that is wrong for urea:

- Urea comes from the **World Bank Pink Sheet**, which the hint never mentions.
- `ALPHA_VANTAGE_API_KEY` feeds the wheat/maize global reference and cannot
  produce a urea row under any configuration.
- `EC_AGRIFOOD_BASE_URL` is not a credential at all. It is an optional base-URL
  override for pointing at a mirror; its correct production value is **unset**.

The hint was one hard-coded string rendered for every commodity, so it could
only ever be right for the case its author had in mind.

And the actual cause was neither: both the Pink Sheet and the Oil Bulletin
feeds shipped on 2026-08-12 (#535, #536), the pull runs Mondays 05:30 UTC, and
the last Monday preceded the code. Nothing was misconfigured — the job had not
had a tick. An operator following the hint would have set two irrelevant
variables and still seen nothing.

## Design

`CommodityMeta` gains a `feed` field naming the upstream that publishes each
slug: `'ec-agrifood' | 'oil-bulletin' | 'world-bank' | 'none'`. The Record is
total over `AnyCommodity`, so adding a commodity without classifying it is a
compile error rather than a `feeds.undefined` rendered to an admin.

`'none'` is a statement, not a gap. MAP and ammonium nitrate have no free feed
anywhere; oats, rye, peas, lentils and rapeseed are named by the exchange
vocabulary but quoted by nothing the job pulls. For those the operator box does
not render at all — there is no pipeline to fix, and implying one sends someone
hunting for a job that was never built. The existing empty state already tells
everyone to ask an admin.

For the three real feeds the copy says what is true: the source by name, that
it is public and needs no key or configuration, the cron cadence, and where to
look if it is still empty after the next run.

## The second copy, and the seam that holds it

The `feed` field duplicates knowledge that lives in the clients —
`PINK_SHEET_FERTILIZERS` in `world-bank-client.ts`, the commodity constant in
`oil-bulletin-client.ts`, `TREND_CROPS`. A second copy that drifts would make
the hint lie again, in the same way and for the same reason.

`tests/unit/market/commodity-feed-consistency.test.ts` is the seam. It derives
one side from the real exported constants rather than restating them, so adding
a Pink Sheet fertiliser without classifying it fails there. Both mutations were
applied to prove it bites: dropping urea's feed to `'none'` (the original bug's
exact shape) failed one assertion, and claiming `'ec-agrifood'` for rapeseed —
which the EC oilseeds endpoint *does* serve but the job does not map — failed
two.

## Files

| file | role |
|---|---|
| `src/lib/market/commodity-vocabulary.ts` | `CommodityFeed` + the `feed` field |
| `src/components/trends/PricesTab.tsx` | renders the feed-specific hint; nothing when there is no feed |
| `messages/{en,bg}.json` | `operator.body` → `operator.feeds.*` + `operator.stillEmpty` |
| `src/app-layer/jobs/schedules.ts` | description named 3 of 6 sources |
| `src/lib/market/barchart-client.ts` | corrected licence cost + inverted `mode` doc |
| `deploy/env.prod.example` | corrected EC default URL; states which feeds are keyless |

## Decisions

- **The intl mock in the new rendered suite appends interpolated params.**
  Under the project's usual key-only mock, `t('operator.body', { ec, av })`
  renders just `"operator.body"` — the env-var strings never reach the DOM, so
  the assertion "the hint must not name an environment variable" would have
  passed no matter what the component did. The RED run confirmed the
  difference: it printed the literal `EC_AGRIFOOD_BASE_URL` in the body text.

- **The corrected Barchart figures came from Euronext's schedule, not
  Barchart's.** The docblock said `~€164/mo`; the fee schedule effective
  2026-01-01 (v18.0) says €167.55. Barchart's own exchange-fees page still
  quotes the old €163.60, so it is a cycle behind its own supplier. More
  materially, the note now records that this is **two** bills — EMDA clause
  13.2 makes a Sub Vendor's use governed by its own agreement, invoiced
  directly by Euronext, and clause 6.8 obliges Barchart to verify it exists.
  Paying Barchart alone does not make the display lawful.

- **The `mode` comment was backwards and the cost of that is licensing.**
  Barchart documents `R` real-time, `I` delayed, `D` end-of-day; the comment
  said `'d' delayed`. Nothing reads it today, but the natural future use is
  proving a quote is delayed before displaying it — which the licence requires
  — and `mode === 'd'` would select precisely the quotes that are not.
