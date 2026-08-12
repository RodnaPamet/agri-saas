# 2026-08-12 — Trends: the inputs a farm buys

**PRs:** #531 (vocabulary), #532 (manual prices), #534 (XLSX reader),
#535 (diesel), #536 (fertilizer), #538 (Trends UI), #539 (guards)

Trends charted four crops. It now charts three categories — **зърно**
(grain), **горива** (fuel), **торове** (fertiliser) — because fuel and
fertiliser are the two largest cash costs in an arable budget, and a farmer
deciding when to buy urea needs the same trend line as one deciding when to
sell wheat.

## Design

```
commodity-vocabulary.ts        CANONICAL_COMMODITIES   crops the farm SELLS
                               INPUT_COMMODITIES       inputs it BUYS
                               normalizeCommodity()    crops only  ← safe default
                               normalizeAnyCommodity() crops + inputs
        │
        ├── exchange write schema ──── normalizeCommodity ⇒ refuses diesel
        │
        └── price feeds ───────────── normalizeAnyCommodity
                 │
                 ├── oil-bulletin-client   diesel, EUR/1000l, weekly   ┐
                 ├── world-bank-client     urea + DAP, USD/mt, monthly ├─ xlsx.ts
                 └── market-manual-prices  MAP + ammonium nitrate      ┘  (both
                          │                                               feeds are
                          ▼                                               XLSX-only)
                 MarketPriceSeries (GLOBAL, no tenantId)
                          │
                          ▼
                 GET /trends/prices?commodity=…  ← TrendCommodity widened
                          │
                          ▼
                 PricesTab   category → commodity, one chart per unit-group
```

## Decisions

### Inputs live OUTSIDE `CANONICAL_COMMODITIES`, and the split is load-bearing

Extending the canonical list was one line. It would also have put diesel
and urea in the **seller's dropdown on the grain exchange**:
`CreateOfferModal` maps that array straight to `ComboboxOption[]`, and
`exchange.schemas.ts` builds its accept-set from it and quotes it back in
its 400. A farmer must never be able to list a tonne of fertiliser as a crop
for sale.

So there are two lists — and, more importantly, **two resolvers**:

| | resolves | callers |
|---|---|---|
| `normalizeCommodity` | crops only, `null` for an input | exchange schema, contract canonicaliser, listings index |
| `normalizeAnyCommodity` | crops and inputs | the price feeds |

The exchange is protected by the resolver it *already called*, not by
patching call sites. Adding fuel and fertiliser to the vocabulary therefore
changed **zero** call sites — 1336 suites and 23869 tests passed on the
first PR — and a new caller that genuinely wants inputs has to reach for
`normalizeAnyCommodity` by name, which is a visible, reviewable act.

A prototype-pollution bug fell out of the same PR: the alias table was a
plain object, so `normalizeCommodity('constructor')` returned a **function**
typed as a commodity slug — the `?? null` fallback never fired — reachable
from any free-text commodity field. It is a `Map` now.

### "нафта" means DIESEL FUEL, not crude

The trap this whole feed exists to avoid. Alpha Vantage is already wired in
and offers WTI and BRENT, which are **crude**. Crude tracks diesel loosely
and is the wrong number for a farmer budgeting fuel: pump diesel carries
refining margin, excise and VAT and moves on a different curve. `нафта` /
`дизелово гориво` is what the operator means, and the EC Weekly Oil Bulletin
is what publishes it — Bulgaria back to 2008-01-07, 930 weekly observations,
CC BY 4.0, no key.

### Units and currency are stored AS REPORTED

`EUR/1000l` for diesel, `USD/mt` for fertiliser, whatever the admin typed
for manual entry. No normalisation on write, per this repo's rule that a
number is only comparable to another in the same currency and conversion
belongs at the display boundary with the rate named. `PricesTab` already
draws one chart per `(region, currency, unit)`, so three unit families
coexist without a nonsense shared axis.

It is also load-bearing in a way worth knowing: `EUR/1000l` deliberately
does not match the `/\/t$/i` filter in `getMarketReferences`, so **diesel
can never be used to benchmark a grain contract**.

Currency and unit are part of the series' six-column natural key. That
means a mismatched write does not collide — it mints a SECOND series and
the chart draws two half-histories. The manual path therefore does an
explicit pre-write lookup and refuses, naming the stored denomination; the
constraint cannot catch this, and the schema comment records that the
silent-fork version already happened once and was fixed by hand-written SQL.

### Which fertilisers have a real feed, and which are typed

Verified per item against the actual workbook — a full 72-column
enumeration plus an exhaustive string search, cross-checked against an
independent mirror — before any client was written:

| item | status |
|---|---|
| **urea** | World Bank Pink Sheet, `'Urea '` (trailing space upstream), USD/mt, monthly |
| **dap** | World Bank Pink Sheet, `'DAP'`, USD/mt, monthly |
| **map** | **No free machine-readable source exists.** Zero hits for `monoammonium` / `\bMAP\b` in the workbook; the EC agri-food API is nutrient-only (N/P/K); Eurostat has no MAP series. → **admin-entered** |
| **ammonium-nitrate** | Not in the Pink Sheet. Eurostat `apri_ap_ina` has a BG series but it is ANNUAL, missing 2023, and priced per 100 kg of **nutrient** rather than per tonne of product — a different quantity wearing a similar name. → **admin-entered** |

**MAP is not DAP and is never proxied by it.** A farmer pricing a purchase
off the wrong compound is worse served than by an honest gap. That is what
the admin-entered path exists for, and it de-risks every feed: an upstream
that changes shape has a fallback that needs no deploy.

### The manual path takes the platform-SUPPORT gate, not the API key

The brief named `verifyPlatformApiKey` **and** required a `logEvent` audit
trail. Those are mutually exclusive here: `AuditLog.tenantId` is
non-nullable with an FK and its hash chain is anchored per tenant, so a
request with no session has no tenant to hang a row on — `agri-events.ts`
states outright that such writes "are not written to `AuditLog`, and cannot
be". `assertPlatformSupport` + `requirePermission('admin.manage')` inside
`PLATFORM_TENANT_SLUG` has a real session and therefore a real audit row,
and `promotion-admin.ts` already curates a global catalogue that way.
Manual price entry moves money decisions; a structured log line is not the
trail that deserves.

### An XLSX reader, because both feeds are spreadsheets

Neither source publishes CSV, JSON or an API — the Oil Bulletin's
`data.europa.eu` entry is metadata whose every distribution points back at
an HTML landing page. SheetJS is blocked: the npm-registry copy is pinned at
0.18.5 with unfixed HIGH advisories and `security-gate-strictness.test.ts`
locks `npm audit` at MODERATE+. An XLSX is a ZIP of XML and the repo already
ships `jszip` and `fast-xml-parser`, so `src/lib/market/xlsx.ts` is glue
with **no new dependency**.

Three properties of it are the reason it is tested hard, because each
produces a plausible WRONG number rather than an error:
`parseTagValue: false` (or a shared string of `"2026"` becomes the number
2026 and a header comparison silently stops matching); columns bind by
header, never position (Bulgaria's block sits at `AE:AK` and moves when a
member state is added); and the missing marker is the literal `'...'`,
which read as 0 is a fertiliser priced at nothing.

Excel's epoch is not one epoch — serial 60 is a 29 February that never
existed, so dates before the phantom day count from 1899-12-31 and after it
from 1899-12-30. The single-epoch shortcut is right for every observation
these feeds carry and wrong by a day for early 1900.

### Both feeds lie about their own freshness, differently

- **The Oil Bulletin's filename lies.** `content-disposition` says
  `…2024-02-19.xlsx` on a file containing 2026-08-03 data. The observation
  date is read from cell A2 and nowhere else.
- **The Pink Sheet's URL lies.** Its doc-id segment rolls annually and the
  PREVIOUS generation still returns **HTTP 200** with a frozen file — last
  period 2025M12, seven months stale, no redirect, no 404. Freshness is
  therefore asserted from the DATA, and the throw names the likely cause,
  because the fix is an operator repointing a URL rather than a code change.

Both clients also CHECK their unit row rather than assuming it. If DG ENER
republished in EUR/litre, an assuming reader would store 1.74 under a
per-1000-litre label and the chart would show a 1000× collapse that reads as
a market event.

### Staleness is a property of the source's cadence

`STALE_AFTER_DAYS = 15` is two weekly cycles — right for the EC and
listings feeds, and simply wrong for a monthly one. The Pink Sheet publishes
monthly with a ~1-month lag, so a urea point is 30-60 days old *at all
times* and would have rendered permanently orange with a "not reported
recently" warning: a false alarm on every single view, which is how a
warning stops being read at all. A manual series gets a wide bound for a
different reason — its age is already stated next to it, so the warning
would be redundant and unactionable.

### Provenance is not an implementation detail

`manual`, `oil-bulletin` and `world-bank` all fell through to the `other`
label key and rendered as **"Other source" / "Друг източник"**. A hand-typed
МАП price that looks like a live quote is the exact failure the manual path
would otherwise introduce, so each source has its own label in both locales,
and an input's stat tile SHOWS its source rather than hiding it.

The empty state was hardcoded too: a commodity nobody publishes rendered the
operator hint naming `EC_AGRIFOOD_BASE_URL`. For МАП the honest answer is
not "someone misconfigured this" — it is that no source publishes it.

## Guards

`tests/guards/input-commodity-invariants.test.ts` holds three, each with a
mutation proof planted in real source, watched fail, and restored:

1. No input slug reaches the exchange — the highest-consequence regression.
2. Every input slug has a Bulgarian alias. A missing alias does not fail; it
   silently splits one series into two and the commodity merely looks
   under-represented.
3. Every source the job writes has a label key in **both** locales.

The third was re-scoped during recon. As briefed ("the read path exposes
`source`, and PricesTab renders it") it was **already true** — `TrendSeries`
has carried `source` since the trends backbone landed — so guarding it would
have locked in a property that already held and could never fail. The
falsifiable version is the one that was false: three sources shipped with no
label.

Two of the three EXECUTE their subject (`normalizeCommodity`,
`sourceLabelKey` are pure and importable) rather than scanning source text,
which is strictly stronger. Per CLAUDE.md's "Green is not the same as
executed", the arithmetic and parsing are covered by executing tests
elsewhere: `commodity-vocabulary`, `oil-bulletin-client`,
`world-bank-client`, `manual-prices`, `xlsx`.
