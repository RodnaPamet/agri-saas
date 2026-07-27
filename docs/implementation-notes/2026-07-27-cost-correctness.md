# 2026-07-27 — Cost correctness: the movement-type policy

**Commit:** _(this PR)_ — first of the cost roadmap.

The "Input cost" column was dead, and the one thing that could fill it had
the wrong sign.

## 1. Consumed inputs had no value

`InventoryLot.unitCostAmount` is documented as the "per-unit acquisition
cost". It was **written at lot creation and read by nothing** —
`getFefoLot`'s select was `{ id, unitId, lotCode, quantityOnHand }` — and the
spray CONSUMPTION posted no `costAmount`. So `stockCost` was not "usually
small", it was **structurally zero**, and every total that included it
omitted the dominant variable cost on a real farm.

The FEFO lookup now selects the cost, and the CONSUMPTION posts
`consumed × unitCostAmount`.

**The dimensional catch.** `consumed` is converted into the **product's**
default unit; `unitCostAmount` is per unit of the **lot** (units are fixed at
lot creation and mixed-unit lots are forbidden). Those normally coincide, but
when they do not the multiplication is meaningless. Cost is therefore posted
only when the two units agree, and skipped with a warning otherwise — a
missing cost is recoverable, a wrong one is a number somebody budgets
against.

## 2. Output was being booked as spend

`HARVEST_IN` is a POSITIVE `quantityDelta` — the grain the farm produced —
and it carries a `costAmount`. The rollup summed every movement type, so
harvest value was added into cost. That is not a rounding error: it moves the
total in the wrong direction, and it grows with a good harvest.

`HarvestLotPayloadSchema` exposes `costAmount` publicly, so any API client
could inflate its own cost report.

### The policy

`COST_BEARING_MOVEMENTS = ['CONSUMPTION']` — a **whitelist**, so a new
`StockTransactionType` must be argued into it rather than silently landing in
every farmer's cost total the day it is added.

| Type | Counts? | Why |
|---|---|---|
| `CONSUMPTION` | **yes** | The moment an input is applied to a crop is the moment it becomes that crop's cost. |
| `RECEIPT` | no | Buying stock is working capital. The spend lands on a crop when the stock is consumed; counting both would double-count every input. Receipts also carry no `logEntryId`, so they never joined — the exclusion is explicit so a future receipt that DOES carry one cannot quietly change what this total means. |
| `HARVEST_IN` | no | Output. |
| `SALE_OUT` | no | Revenue. |
| `TRANSFER` | no | Stock moving between locations costs nothing. |
| `ADJUSTMENT` | no | A correction to a count, not money spent. |
| `DISPOSAL` | not yet | Written-off stock is a real loss, but a LOSS rather than a cost of growing this crop. Folding it in silently would overstate production cost; if wanted, it belongs in its own column. |

The module docstring previously described a capability that did not exist. It
now describes this policy.

## 3. A money total that changed between identical requests

`LIST_TAKE = 500` / `BATCH_TAKE = 5000` with **no `orderBy`** meant that past
the cap an arbitrary subset was summed — and PostgreSQL is under no
obligation to return the same subset twice. The same page, refreshed, showed
a different total. Season and field rollups reused that same capped set.

Three changes:

- **Deterministic order** on every capped read. `createdAt` alone is not a
  total order, so ties resolved arbitrarily; `id` breaks them.
- **`take + 1`** to *detect* the cap rather than infer it — a page of exactly
  `take` rows is ambiguous.
- **Stock cost aggregated in-DB** (`groupBy` + `_sum`), so the sum is the
  database's rather than a sample's and there is nothing to truncate.

`truncated` is threaded through all three rollups → route → SSR page →
client. A partial financial total must say it is partial.

## 4. Soft-deleted entries kept their stock cost

The `logEntry` read filtered `deletedAt: null`, but the `stockTransaction`
read reused the **unfiltered** id set, so a deleted journal entry kept
contributing. It now uses `liveLogEntryIds`, derived from the rows that
survived the filter. Latent while consumption was unvalued; a live money bug
the moment §1 lands.

## 5. A per-unit price posted as a movement total

The RECEIPT posted `costAmount: input.unitCostAmount` — a **rate** — as the
movement total, so 1000 L at 5/L booked **5**. It bypasses the planting
rollup but lands in the org dashboard's activity cost. Now
`quantity × unitCost`.

## Files

| File | Role |
|---|---|
| `src/app-layer/repositories/InventoryRepository.ts` | FEFO selects the lot's cost |
| `src/app-layer/usecases/inventory.ts` | consumption valued (unit-checked); receipt magnitude fixed |
| `src/app-layer/usecases/cost-rollup.ts` | type whitelist, deterministic caps, in-DB stock aggregate, soft-delete fix, `truncated` |
| `src/app/api/t/[tenantSlug]/grain/costs/route.ts` + costs page/client | `truncated` surfaced |

## Decisions

- **Skip the cost rather than guess the unit.** When lot and product units
  disagree the consumption is recorded unvalued and logged. The brief's
  framing decided this: a silently-wrong financial figure is worse than a
  missing one.

- **Whitelist, not blacklist.** A blacklist fails open — the next movement
  type added to the enum would join the cost total by default.

- **`truncated` is a flag, not a bigger cap.** Raising the limit would only
  move the cliff; the honest fix is to say when the edge is hit.

- **Truncation slices, it does not mutate.** The first version shortened the
  query result in place (`plantings.length = take`). Harmless against a fresh
  Prisma read, but it mutates a value the function does not own — and the
  propagation test caught it immediately, because the season and field
  rollups shared one fixture array and the first call shortened it under the
  second.
