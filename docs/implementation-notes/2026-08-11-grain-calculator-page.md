# 2026-08-11 — Grain calculator page (the `GRAIN_NET_WORTH` surface)

**Commit:** `<pending>` feat(grain): the calculator — what the grain is worth after everything it cost

`getGrainNetWorth` landed as the fourth named cost metric in #525 with no
surface to read it on. This is that surface: `/t/:slug/grain/calculator`,
a read-only report answering the one question the other three grain cost
pages cannot — *what is the grain worth, after everything it cost me?*

## Design

### Data path

`page.tsx` is a Server Component doing exactly what `grain/costs/page.tsx`
does: resolve tenant context, call the usecase, hand a serialised payload
to a client island. `force-dynamic`, no API route, no client refetch —
unlike /grain/costs there is no dimension toggle, so there is one shape
and one payload. The island formats and arranges; it never re-derives a
cost, a yield or a price. The module gate is NOT repeated here —
`grain/layout.tsx` already runs `requireModule(ctx, 'GRAIN')` for the
whole route group, and a second check would be redundant work per request
plus a second place to forget.

### Page shape, top to bottom

```
PageHeader        eyebrow = the METRIC NAME, meta = "Priced <when>"
GrainSectionNav
ToggleGroup       commodity selector (only when >1 commodity)
HeroMetric card   THE ANSWER — net worth, or the stated refusal
                  + price / observed-at / currency basis / source
two ValuePanels   standing crop (EXPECTED) | grain on hand (ACTUAL)
sharedCostNote    why the two panel nets cannot be added
ExclusionsCard    a count that is ALWAYS rendered + an accordion of ids
DataTable         every commodity, five money columns, the appendix
```

### The cost side is shared, not split

The usecase attributes cost per COMMODITY, not per "growing vs stored".
Both panels therefore charge the SAME `cashCostTotal`, and the page says
so in `sharedCostNote`: the two nets cannot be added, and the combined
authoritative figure is the `HeroMetric` above. The alternative was to
invent a split — apportion cost between standing and stored by tonnage or
by value — which would have produced two numbers that *look* addable and
are not derived from anything the usecase measured.

### Refusals are stated, never blanked

Four separate refusal surfaces, because a missing number that renders as
blank or zero is the failure mode this metric is most exposed to:

- `netWorth === null` → em-dash in `attention` tone, the refusal named in
  the `HeroMetric` description, and the usecase's own reason sentence
  printed verbatim underneath. Both panels drop their net line for the
  same reason, gated on the same `netWorth != null` certification rather
  than re-deciding locally whether the currencies combine.
- `payrollAllocated` → an "Allocated" badge and a sentence, so an
  allocation by area share is never read as a measurement.
- exclusions → a visible count *even at zero* ("0 records excluded" is a
  statement; an absent line is not), with the ids behind an accordion.
- `truncated` → replaces the header description outright, because a
  caveat nobody reads is not a caveat.

The reason string is authored server-side and is English today. It is
surfaced verbatim rather than dropped: an untranslated explanation beats
a missing one.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/grain/calculator/page.tsx` | Server Component — tenant ctx → usecase → serialised payload |
| `src/app/t/[tenantSlug]/(app)/grain/calculator/CalculatorClient.tsx` | Client island — DTOs, layout, the two panels, exclusions, table |
| `src/lib/format-currency.ts` | Gains `formatExactCurrency` — the to-the-cent sibling of `formatCompactCurrency` |
| `src/lib/tenant-context-provider.tsx` | Gains `useExactMoneyFormatter()` — its tenant-bound hook |
| `src/app/t/[tenantSlug]/(app)/grain/costs/CostsClient.tsx` | Migrated off its local `useCostFormatter` onto the shared hook |
| `messages/{en,bg}.json` | 65 `grain.calculator` keys, plus the 6 missing `trends.commodities` names (4 → 10) |
| `src/lib/grain/cost-metrics.ts` | `UNKNOWN_RENT_CURRENCY` moved here from the usecase so a client can recognise the sentinel |
| `tests/e2e/mobile/horizontal-drift.spec.ts` | One line adding the calculator to the phone-overflow sweep |
| `tests/guards/{list-page-shell,filter-toolbar,columns-dropdown}-coverage.test.ts` | Three written exemptions for the report |
| `tests/unit/costs-page-contract.test.ts` | Retargeted onto the shared hook; gained a no-compact-formatter assertion |

### The bug the surface exposed

`finalizeRow` answered "no cost currency recorded anywhere" with
`netWorth = netAssetPosition` — subtracting no cost at all. That branch is
not an edge case: `LogEntry.costCurrency` is nullable and the journal modal
never sends it, and `addCurrency` in cost-rollup skips nulls, so a real
magnitude arrives with an empty currency set for any farm that records
spend through the journal and has no lease or payroll rows.

Nothing inside the usecase could see it. `netWorth = netAssetPosition` is
internally consistent and its unit tests passed. It became a contradiction
only when this page put `cashCostTotal` on screen four inches from it: a
hero of €25,000 beside panels of €11,000 / €6,000 and a table row reading
cost €4,000, net worth €25,000.

The branch now subtracts. That treats an unlabelled magnitude as the
tenant's display currency — the assumption the product already makes
wherever it *prints* these numbers, since `/grain/costs` renders every cost
under `Tenant.currencySymbol` regardless of `costCurrency`. The refusals
that guard real ambiguity are untouched: mixed currencies, an unknown rent
currency, and a cost currency disagreeing with the price currency all still
withhold the figure.

## Decisions

- **Three DataTable exemptions, not three retrofits.** The table's row set
  is `CANONICAL_COMMODITIES` — ten rows, hard-capped by an `as const`
  array, all on screen at once. A filter facet whose options enumerate the
  visible rows can only hide data the reader can already see; a column
  gear is worse than useless here because net worth is a SUBTRACTION and a
  reader who hides "Farm cost" is left with a value figure that looks like
  profit. `ListPageShell` was declined for a different reason: the panels
  are the answer and the table is the appendix, so viewport-clamping would
  pin the panels and give a ≤10-row table its own scrollbar.

- **`mobileFallback="scroll"`, not `"card"`.** `MobileCardList` omits every
  column without `meta.mobileCard`. These money columns are only meaningful
  side by side — a card showing a net worth without the cost beside it is
  the misleading half of the row.

- **The exact-currency formatter got a home, because it already existed
  twice.** `formatMoney` here and `useCostFormatter` on /grain/costs were
  the same `symbol + formatDecimal(v, 2)` expression, and
  `polish-06-single-currency.test.ts` fired on the second one. The guard
  missed the first only because a hook name reads nothing like
  `formatMoney`. The fix was extraction rather than a rename: one
  `formatExactCurrency` in `src/lib/format-currency.ts`, one
  `useExactMoneyFormatter()` binding it to tenant context, and both pages
  migrated. Note the pre-existing `useMoneyFormatter` is COMPACT (€1.2M)
  and documented as wrong for reconciliation surfaces — the two hooks now
  differ by one word, so `costs-page-contract` gained an explicit
  `not.toContain('useMoneyFormatter')` assertion.

- **Two timestamps at two scopes.** `generatedAt` is report-level and sits
  in `PageHeader`'s `meta` slot; `priceObservedAt` is row-level and sits
  beside the price it qualifies. Putting them on one line would show a
  reader toggling commodities one value moving and one frozen with nothing
  to explain the difference. The distance between the two dates is the
  staleness signal — a valuation generated this morning off a quote
  observed three weeks ago is arithmetically correct and operationally
  worthless.

- **`HeroMetric` over a hand-rolled `text-2xl`.** `metric-typography`
  requires it, and it was right anyway: this figure IS the page. A refused
  net worth prints the em-dash rather than the refusal sentence as the
  value — a refusal shouted in 60px is not more honest than one stated in
  14px.

- **Two guards read comments as source, and both bit this file.**
  `dashboard-chart-bypass` failed it for a docblock that *quoted* the
  hand-rolled percentage-width bar in order to say the page does not use
  one. Then `heromemtric-canonical-home` failed it for a comment saying
  "KPIStat, NOT `<HeroMetric>`" — the ratchet matches `/<HeroMetric\b/`
  anywhere in the file. Both scanners read raw text and cannot tell a
  bypass from a comment disclaiming one. **Describe a guarded
  anti-pattern in prose; never spell its tag or its code.** Worth knowing
  before writing "we deliberately do not do X" about anything ratcheted.

- **`<KPIStat>`, not the 72px hero primitive.** `metric-typography` bans a
  raw `text-2xl font-semibold` next to a number and names two acceptable
  primitives; the larger one is separately fenced to the dashboard
  masthead, whose ratchet warns that spreading 72px dilutes the masthead
  signal. A report summary card is exactly that spread. Note the fence is
  a text scan on the tag, so the repo's *second* component of the same
  name (`ui/metric.tsx` vs `ui/HeroMetric.tsx`) does not sidestep it —
  nor should it.

- **`StatusBreakdown` prints `item.value` raw, and `showCount` defaults
  to on.** Left at the default, the cost breakdown rendered `4000`
  directly above `Total farm cost €5,500` — the unnamed-money-figure
  failure this whole page exists to prevent. The amount moved into the
  `label` and `showCount` is off. The label had to stay a *string*: the
  primitive only names its `role="progressbar"` when
  `typeof item.label === 'string'`, so passing a ReactNode to get
  formatted money would have silently unnamed three progress bars. A
  `formatValue` prop on the primitive would fix the class rather than the
  instance, but that is a shared-UI change for another PR.

- **A placeholder is not a general-purpose blank.** `currencyNotRecorded`
  ("not recorded" / "не е записана") was being substituted into
  `"Price in {currency}"`, which wants an ISO code — yielding "Price in
  not recorded", and in Bulgarian a preposition followed by a finite
  verb. The absent case now has its own standalone sentences.

- **`UNKNOWN_RENT_CURRENCY` moved to a client-safe module.** The sentinel
  ships inside `cashCostCurrencies`, so it is not private in any useful
  sense — the page was joining the array verbatim and printing "Costs in
  UNKNOWN". A value that travels in a DTO must be nameable at both ends,
  so it lives in the import-free `@/lib/grain/cost-metrics` and the
  usecase imports it.

- **`formatDate`, not `formatDateTime`, for the observation stamp.**
  `trends.ts` builds `observedAt` as `date.toISOString().slice(0, 10)` —
  date-only. Rendering it with a time appended a midnight nobody
  observed, on the very line whose job is to let a reader judge staleness.
  The test fixture had used a full ISO timestamp, which made the wrong
  helper look right.

- **Six commodity names were missing in both locales.** `trends.commodities`
  covered wheat/maize/barley/sunflower while `CANONICAL_COMMODITIES` has
  ten. The calculator groups by canonical commodity, so rapeseed, oats,
  rye, soybean, peas and lentils would have fallen through
  `tCommodity.has(slug)` to the raw English slug — including for Bulgarian
  readers. Adding them is a fix to `/trends` too, not just to this page.
