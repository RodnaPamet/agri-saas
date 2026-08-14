# 2026-08-14 — The grain calculator's diagnoses become destinations

**Commit:** (pending — see PR)

Second of a four-prompt roadmap.

## The defect

The only `href` in the entire feature was the dashboard breadcrumb. The page
diagnosed precisely and then stranded the reader: nine named classes of excluded
record with no way to reach one, an empty state naming a precondition it offered
no way to satisfy, and a refusal explaining itself with nothing to do about it.

Knowing what is wrong never became fixing it. That is the gap between an honest
report and a tool.

## What the routes actually support

The brief asked to verify each destination before wiring it, because the GRC
teardown removed pages recently. That check changed the design:

| destination | reality |
|---|---|
| `/inventory?lotId=<id>` | **works** — opens that lot's detail modal, an affordance built for QR codes |
| `/rent` | reads `?locationId`, **not** a lease id — these entries carry lease ids |
| `/planning` | only detail route is `[cropPlanId]` — a crop PLAN; entries carry planting ids |
| `/trends`, `/grain/costs` | read no query parameters at all |

So **only lots get a per-entry deep link**. Everything else gets a class-level
list destination, which is a finding rather than laziness: a link that appears
to target a record and lands on an unfiltered list is worse than one that plainly
says "Open Rent".

The lot link is keyed on the CLASS, not the entry's shape — `lotsUnresolvedUnit`
carries `{lotId, unitKey}` while `lotsUnknownCommodity` carries a bare id string,
and a bare lot id is indistinguishable from a bare planting id. The class knows
what its entries are.

## `leasesProduceRentUnpriced` → `/rent`, and why

The proximate cause is a missing market price, which argues for `/trends`. But a
farmer cannot add one: prices arrive from EC and the World Bank, and a hand-typed
price is a platform-admin action. What they CAN change is the lease — rent
recorded in money instead of grain values without a market price at all. The
price side is already reachable from `commoditiesWithNoPrice`.

## Files

| file | role |
|---|---|
| `…/grain/calculator/CalculatorClient.tsx` | `destination` on every class; empty-state action; refusal link |
| `…/grain/calculator/components.tsx` | renders class destinations + per-entry lot links |
| `messages/{en,bg}.json` | seven strings |

## Decisions

- **`destination` is REQUIRED on the class table, not optional.** A new class
  added without one fails to compile, and the rendered test derives its
  assertions from `EXCLUSION_CLASS_DESTINATIONS` rather than listing nine cases
  — so a tenth class cannot ship silently linkless. A hand-written list would
  simply not mention it.

- **The destination lives in the accordion CONTENT, with the entries it relates
  to.** That is what a farmer does: look at what was excluded, then go fix it.
  It also means the rendered test has to expand each class, which is
  `type="single"` so they open one at a time — the test does exactly that.

- **A `Link` wearing the primary button's clothes.** `Button` is not
  polymorphic and has no `as`; `buttonVariants` is exported for this and
  `TenantsTable` already does it.

- **Not every refusal gets an action.** `NO_MARKET_PRICE` links to `/trends`.
  `MIXED_COST_CURRENCY` and `RENT_CURRENCY_UNRECORDED` do not: one needs an FX
  rate this product deliberately does not have, the other a column
  `ParcelLease` does not carry. A destination that cannot resolve the cause is
  worse than the plain explanation.

- **Nothing softens a finding.** Counts, class names and the render-at-zero
  behaviour are untouched; the links only add somewhere to go.
