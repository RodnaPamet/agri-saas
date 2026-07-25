# 2026-07-25 — Closing the grain contract loop (fulfilment, season rollup, value, delivery window)

**Commit:** `<pending>` feat(grain): close the contract loop — deliveries, season coverage, value, delivery-window alerts

Before this change a `Contract` was a flat register. `grep contractId
prisma/schema/*.prisma` returned nothing, so nothing in the system could
be delivered *against* a contract, and `status = DELIVERED` meant only
that somebody picked it from a dropdown. Three other promises sat
alongside it — a per-season rollup, a contract value, and a delivery
window — each described in the schema and implemented nowhere.

## The fork: (a) hard link, via a new `GrainDelivery` model

**Chosen: (a).** The farmer's question is per-counterparty — *"how much
do I still owe THIS buyer?"* — and fork (b) (correlating Contract and
YieldRecord on `(seasonId, commodity)`) cannot answer it at any price. It
can tell you a farm grew 800 t and sold 700 t forward; it cannot tell you
that 300 t of the 500 t owed to Cargill is still sitting in a bin. Two
further requirements settle it: the prompt's own acceptance ("how much of
a contract has been delivered and how much remains") and gating DELIVERED
on real movement, which needs tonnage attributable to *one* contract.

**But not `contractId` on `YieldRecord`.** The schema is explicit that a
YieldRecord is "the FIELD-level production total" — production, not
dispatch. Hanging a contract link on it would model a genuine N:M as a
1:1 and conflate three different events:

- one harvest can serve several buyers;
- grain sits in a bin between harvest and delivery;
- one contract is typically filled from several harvests.

So deliveries get their own row:

```
Contract ──1:N──> GrainDelivery
   volumeTonnes        tonnes        ← Σ = delivered-to-date
   (what was sold)     deliveredAt   ← contracted − delivered = still owed
                       reference     ← weighbridge ticket no.
```

`contractId` is REQUIRED: a movement with no contract is an inventory
transfer and belongs to the stock ledger, not here. The FK is the
composite `[contractId, tenantId] → [id, tenantId]` barrier used
throughout `grain.prisma`, so a delivery can never point at another
tenant's contract even if an id leaks. RLS gets the canonical trio +
FORCE, matching Contract / YieldRecord.

**Every column is plaintext, and that preserves rather than breaks the
Epic-B split.** `tonnes` is a magnitude the rollups SUM in-DB (an
encrypted column cannot be `SUM()`d) and `reference` is a short external
identifier operators filter on. The commercially-sensitive narrative for
a deal stays on the parent Contract (`terms` / `pricingNotes`, both
encrypted), so this model carries no free text needing the manifest —
the split holds by construction, not by omission.

### The DELIVERED gate — and why the bar is movement, not completion

`updateContract` now refuses ACTIVE → DELIVERED unless the ledger holds
at least one delivery. The seam left in the previous PR is filled.

The bar is deliberately **> 0 delivered**, not "fully delivered". Grain
marketing runs on tolerance: moisture shrink, a short final load, a
contract closed at 499.2 t against 500 t. Refusing to let an operator
close that would push them straight back to lying to the system, which is
exactly the disease being cured. `fulfilment.complete` on the read side
distinguishes fully- from partially-delivered without blocking anyone.

Recording a delivery against a DRAFT or CANCELLED contract is refused
(nothing is signed / the deal is void); ACTIVE, DELIVERED and SETTLED all
accept a late or corrective ticket.

## The `seasonId` promise (flag 5) — implemented, not deleted

`grain.prisma` promised "portfolio rollup: contracted-vs-produced per
season" and `portfolio-grain.ts` had no season dimension at all —
contracted tonnes and harvested tonnes rendered as two unrelated tiles.

Implemented as `PortfolioGrainSummary.perSeason`: two bounded `groupBy`s
per tenant (contracts by `seasonId`, yield records by `seasonId`) plus one
bounded season-name lookup, folded into an org-level table with
`coveragePct` and `deltaTonnes`.

**Seasons aggregate by NAME, not id.** A season is a per-tenant row, so
"2026 Harvest" is a different `Season.id` in every farm; at group level
the name is what the operator means.

**A second, wider status set — `CONTRACTED_SEASON_STATUSES`.** The live
book (`CONTRACTED_COMMITMENT_STATUSES`, ACTIVE + DELIVERED) answers "what
am I on the hook for now". The season rollup answers "how much of this
harvest did I sell forward", which must include SETTLED — a completed
season's contracts are mostly settled, so scoring it against the live
book would report ~0% coverage for exactly the seasons an operator
reviews. Both sets exclude DRAFT and CANCELLED.

**Coverage is not clamped at 100%.** Selling more than you grew is the
single most actionable thing this table can surface, so >100% renders in
the warning tone rather than being rounded away.

## Contract value (flag 8)

`grain.prisma` has said "contract value = volume × price" since the module
shipped; `grep contractValue src/` returned zero hits. Now computed in
`src/lib/grain/contract-value.ts` under two non-negotiable rules:

**Decimal, never float.** `Decimal(14,3) × Decimal(14,2)` needs five
decimal places to be exact and a book total is money. Everything goes
through `Prisma.Decimal` and crosses the wire as strings so JSON's float
parse never touches it. (`1234.567 × 89.12 = 110024.61104`, exactly.)

**Never sum across currencies.** €100k + $100k is not 200k of anything.
`summariseContractBook` groups by `priceCurrency`; contracts priced
without a currency get their own bucket rather than being folded into a
neighbour's. At org level the total covers the reference currency only
and sets `mixedCurrency: true` so the UI can say the figure is partial —
a partial total presented as complete is worse than no total.

Surfaced as a per-row `Value` column, per-currency book tiles above the
list, and a Contract-value KPI on the org dashboard, which previously
showed activity COST with no revenue figure to weigh it against.

Unpriced contracts yield `null`, never `0` — zero would claim the deal is
worth nothing and would silently drag the book down. The buckets carry
`unpricedCount` so a total can say so.

## Delivery window / expiry (flag 3)

`deriveContractWindowState` in `src/lib/grain/contract-window.ts` is the
single definition of "late", shared by the list badge and the nightly
sweep so the badge on screen and the notification in the bell can never
disagree. Scoped to ACTIVE: a DRAFT is unsigned, CANCELLED is void, and
DELIVERED / SETTLED are fulfilled, so none of them can be late. A contract
with no `deliveryEnd` is never flagged — absence of a date is not a
deadline of zero.

`contract-delivery-window-sweep` follows `lease-expiry-sweep` exactly
(registry + schedules + `JobPayloadMap` + queue options), running daily at
07:30 UTC. Two details worth keeping:

- **Dedupe buckets on `(contract, recipient, deliveryEnd, phase)`**, so a
  contract alerts once on approach and once when it lapses — not every
  morning for a month. Moving the delivery date mints a fresh bucket,
  which is correct: a renegotiated window is a new deadline.
- **The message carries the outstanding tonnage**, from one batched
  `groupBy` over the ledger. "Your window closes in 3 days" is far less
  useful than "300 t of 500 t still to deliver".
- **A fully-delivered contract still flagged ACTIVE is skipped.** The
  grain moved; the status is just stale. That is a hygiene problem, and
  this alert must not impersonate a late delivery.

The new `[tenantId, status, deliveryEnd]` index backs the sweep's scan.
The pre-existing `[tenantId, deliveryStart]` index still backs no query —
left in place rather than dropped in the same migration as a new table.

## Files

| File | Role |
|---|---|
| `prisma/schema/grain.prisma` | `GrainDelivery` model; production-vs-dispatch header note; `seasonId` / `pricePerTonne` / `deliveryEnd` comments now name the code that honours them. |
| `prisma/migrations/20260725120000_add_grain_delivery_fulfilment/` | Table + composite FK + RLS trio + the sweep index + `CONTRACT_DELIVERY_DUE`. |
| `src/app-layer/domain/contract-status.ts` | `CONTRACTED_SEASON_STATUSES` + why it is wider than the live book. |
| `src/lib/grain/contract-value.ts` | **New.** `computeContractValue` + `summariseContractBook` (Decimal-exact, currency-grouped). |
| `src/lib/grain/contract-window.ts` | **New.** `deriveContractWindowState` — the shared "late" predicate. |
| `src/app-layer/usecases/grain-delivery.ts` | **New.** Ledger CRUD, `deriveFulfilment`, `aggregateDeliveredTonnes` (one groupBy per page). |
| `src/app-layer/usecases/contract.ts` | Rows decorated with fulfilment + value; DELIVERED movement gate. |
| `src/app-layer/usecases/portfolio-grain.ts` | Per-season rollup; per-currency value; `mixedCurrency`. |
| `src/app-layer/jobs/contract-delivery-window-sweep.ts` | **New.** Daily ACTIVE-contract window sweep. |
| `…/grain/contracts/DeliveriesSheet.tsx` | **New.** Record + review the ledger against one contract. |
| `…/grain/contracts/ContractFulfilmentCell.tsx` | **New.** Progress cell + window badge. |
| `…/grain/contracts/ContractBookTotals.tsx` | **New.** Per-currency book tiles. |
| `…/org/…/grain/PortfolioGrainClient.tsx` | Contract-value KPI + contracted-vs-produced season table. |

## Decisions

- **Fork (a), but with a new model rather than a column on
  `YieldRecord`.** The prompt offered "YieldRecord and/or an inventory
  movement / a new GrainDelivery row". Production is not dispatch; the
  cheap version would have made every later question (partial fills,
  multi-buyer harvests, bin residence) unanswerable.
- **`contractId` is NOT nullable.** A delivery with no contract is an
  inventory movement. Making it optional would have invited exactly the
  ambiguity the model exists to remove.
- **Movement gate at "> 0", not "fully delivered".** See above — the
  strict version optimises for a tidy invariant and against the operator
  telling the truth.
- **No `locationId` / `yieldRecordId` on GrainDelivery (yet).** Both are
  defensible, neither is needed for the acceptance, and each adds an FK,
  an index, and guardrail surface. Bin provenance belongs to the inventory
  ledger and can be added without a breaking change.
- **The list endpoint returns `{ rows, totals }`.** Totals are computed
  from the SAME bounded page as the rows, so they cannot disagree with
  what is on screen and need no second query. A DB-side SUM was not an
  option: value is a per-row product, not a column.
- **Two status sets, not one.** The temptation was to reuse
  `CONTRACTED_COMMITMENT_STATUSES` everywhere. That would have made the
  season table read ~0% for every completed season — a number that is
  wrong in the most confident-looking way.
- **`mixedCurrency` is surfaced, not hidden.** The alternative (blend, or
  silently show one currency) puts a number on a marketing dashboard that
  someone might price a crop against.
- **Sheet, not modal, for the ledger.** Recording deliveries is
  inspect-and-edit work against the list, and operators log two or three
  tickets in a row.
- **No PATCH on a delivery.** An edited weighbridge ticket is a new fact,
  not a revised opinion; correcting tonnage is delete-and-re-record so the
  audit trail shows both.
