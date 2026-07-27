# 2026-07-27 — Cost: a currency, one meaning, and a denominator

**Commit:** _(this PR)_ — second of the cost roadmap, after
`2026-07-27-cost-correctness.md`.

## 1. Money with no currency — FORK: the tenant's, not the row's

`costCurrency` was declared in the journal modal's type and **never sent**,
so it is null for every entry the UI creates, and `money()` printed a bare
unlabelled number. It only looked correct because the demo seed writes
`'EUR'`.

Two vocabularies were being conflated:

| | Holds | Example |
|---|---|---|
| `Tenant.currencySymbol` | a **symbol** | `€` |
| `LogEntry.costCurrency` / `StockTransaction.costCurrency` | an **ISO code** | `EUR` |

There is no mapping between them, and — verified by grep — **no FX table
anywhere in the product** (no `exchangeRate` / `fxRate` / `currencyRate`
concept exists).

**Decision: render every money figure in the tenant's configured display
currency, and stop treating the per-row currency as a display source.**

- The schema already documents `currencySymbol` as "the tenant's display
  currency for every monetary surface". That decision was made; the costs
  page simply ignored it — while importing from the very module that
  exports `useMoneyFormatter`.
- A per-row currency cannot be rendered faithfully (symbol ≠ code) nor
  converted (no rates), so displaying it implies a capability that does not
  exist.
- `costCurrency` is kept as recorded provenance and drives the
  mixed-currency detection below.

**Not done, deliberately:** sending a currency from the journal. The tenant
has no ISO currency code — only a symbol — so the client would have to write
`'€'` into a column whose existing values are `'EUR'`, corrupting the
column's vocabulary to fix a display bug. Adding a tenant currency *code* is
a schema and product decision, not a defect fix. That is the seam if
multi-currency ever becomes real.

`useTenantCurrencySymbol()` is exported alongside `useMoneyFormatter()`
because the latter is **compact** (`€1.2M`) — right for a dashboard tile,
wrong for a financial table where a farmer reconciles against invoices.

## 2. Mixed currencies — refuse, do not blend

`pickCurrency` kept the **first non-null** currency seen, over a read with
no `orderBy`. So 100 BGN + 50 EUR displayed as "150 BGN" *or* "150 EUR"
depending on which row the database happened to return first — and the label
changed between refreshes of the same page.

With no FX table, amounts in different currencies **cannot** be added. The
rollup now collects the distinct currencies (`currencies: string[]`) and
flags `currencyMixed`; the page replaces its description with a warning
naming the currencies, and **suppresses the per-hectare and per-tonne
figures entirely** — a blended total is not a number, so it must not become
a per-unit number either.

### Reconciling `portfolio-grain`

Its tenant row carried one `currency`, resolved from the **dominant contract
price currency**, falling back to the **oldest contract on record** — and
that label was applied to `totalActivityCost`. A farm selling in EUR and
buying inputs in BGN had its spend labelled EUR.

Contract currency now labels contracted value **only**. Activity cost gained
`costCurrencies` / `costCurrencyMixed`, read from the cost rows themselves.

## 3. Three cost metrics, named apart

Three incompatible definitions shipped under one word, so the same season
showed different totals on different pages. They are **not** collapsed,
because each has a legitimate reader:

| Metric | Question it answers | Scope |
|---|---|---|
| `ATTRIBUTED_CROP_COST` | "what did growing this crop cost?" | entries linked to a planting + their consumed stock |
| `TENANT_ACTIVITY_SPEND` | "what did this farm spend?" | every entry and cost-bearing movement, attributed or not |
| `SEASON_ACTIVITY_COST` | "what did activity in this window cost?" | field events inside the season's dates |

Collapsing them would have been the wrong kind of tidy: forcing the org
dashboard onto the attributed definition would **hide unattributed spend**,
which is exactly the spend worth finding.

What makes them consistent rather than arbitrary is that they now share the
movement-type policy, the soft-delete filtering, and the refusal to blend
currencies. `src/lib/grain/cost-metrics.ts` holds the vocabulary, and each
consumer's docstring names its metric; the costs page shows its name in the
header eyebrow, so a reader who sees two different numbers can tell why.

## 4. Cost per hectare and per tonne

Spend with no denominator answers "how much did I spend", never "did this
field pay". Both denominators already existed under the **same** season and
location keys in the yield register, so this needed no new plumbing: one
`groupBy` per grouping.

- The tonnage prefers `netTonnesStd` (the 14% standard-moisture basis from
  the yield roadmap) and falls back to gross where moisture was never
  measured — two harvests at different moistures are not the same quantity
  of grain.
- Null, never zero, when the denominator is missing: "0 per hectare" reads
  as a free crop.

### The margin fork — deferred, with a reason

A gross-margin view joining contract revenue is **not** in this PR. Two
things must be decided first, and neither is a defect fix:

1. **Attribution.** Contracts carry `seasonId` but no field, so revenue can
   be joined per season and not per field — while the question the brief
   poses ("did *this field* pay?") is a per-field one. Shipping a
   season-only margin under a per-field heading would repeat the class of
   error this roadmap is removing.
2. **Currency.** Contract revenue carries `priceCurrency`, cost carries
   `costCurrency`, and there are no rates. A margin across two currencies is
   not computable, only guessable.

Season-level margin is buildable the moment a currency policy exists; the
denominators shipped here are the half that needs no policy decision.

## Files

| File | Role |
|---|---|
| `src/lib/grain/cost-metrics.ts` | the three metrics, named, with label keys |
| `src/lib/tenant-context-provider.tsx` | `useTenantCurrencySymbol()` for precise (non-compact) money |
| `src/app-layer/usecases/cost-rollup.ts` | currency sets + `currencyMixed`; cost/ha + cost/t; metric named |
| `src/app-layer/usecases/portfolio-grain.ts` | contract currency vs cost currency separated |
| `src/app-layer/usecases/season-recap.ts` | metric named in the docstring |
| `src/app/t/[tenantSlug]/(app)/grain/costs/CostsClient.tsx` | tenant formatter, warnings, two new columns, metric eyebrow |

## Decisions

- **Refuse rather than convert.** Every alternative to refusing a
  mixed-currency total requires rates the product does not have. A
  plausible-looking converted figure would be the worst outcome.
- **A mixed row shows no per-unit cost.** Dividing a meaningless total by a
  real area produces a precise-looking meaningless rate.
- **Three metrics, not one.** Named and labelled beats unified-and-wrong.
