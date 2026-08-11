# 2026-08-12 — CostEntry: /grain/costs from report to register

**Commit:** `<pending>` feat(grain): /grain/costs becomes the cost-entry register

Design spec: `docs/superpowers/specs/2026-08-11-cost-entry-design.md`

P1 of two. This lands the model and the entry surface; nothing reads a
`CostEntry` yet, so no existing figure moves. P2 wires the calculator and
the domain pages.

## Design

`/grain/costs` was a read-only dimension-toggle rollup of
`COST_METRICS.ATTRIBUTED_CROP_COST`. The grain net-worth calculator
already reports that same figure as part of a larger answer, and
`src/lib/grain/cost-metrics.ts` exists precisely because this product once
shipped one word over three different numbers. So the rollup was
**dropped**, not relocated — including its API route, which had no
remaining callers.

What replaced it is the thing a farmer could not do anywhere: enter a
cost, of any kind, in one place.

```
CostEntry
  category   PAYROLL | RENT | FERTILIZER | FUEL | SEED | PESTICIDE | SERVICE | OTHER
  amount     Decimal(14,2)   plaintext — SUMmed in-DB
  currency   ISO code        never blended; no FX table in this repo
  incurredOn
  supplier   plaintext, sanitised   ← filterable BECAUSE it is not encrypted
  description ENCRYPTED (Epic B) + sanitised
  invoiceFileId → FileRecord, gated on STORED && !deletedAt
  ONE of: plantingId | seasonId | locationId | parcelId | leaseId
```

## Files

| File | Role |
| --- | --- |
| `prisma/schema/{enums,grain}.prisma` | `CostCategory` + `CostEntry`; back-relations on Planting/Season/Location/Parcel/ParcelLease/FileRecord/Tenant/User |
| `prisma/migrations/20260811160000_add_cost_entry/` | Table, 8 indexes, FKs, and the hand-appended RLS trio |
| `src/app-layer/repositories/CostEntryRepository.ts` | Tenant-scoped CRUD; every read bounded |
| `src/app-layer/usecases/cost-entry.ts` | The two invariants Prisma cannot express, sanitisation, audit |
| `src/app-layer/schemas/grain.schemas.ts` | Create/Update schemas + the exported category validator |
| `src/app/api/t/[tenantSlug]/grain/costs/**` | Collection + detail routes, REPLACING the retired rollup endpoint |
| `src/app/t/[tenantSlug]/(app)/grain/costs/**` | `EntityListPage` + create/edit modal + filter defs |
| `src/lib/security/encrypted-fields.ts` | `CostEntry: ['description']` |

## Decisions

- **`supplier` is deliberately NOT encrypted.** The manifest bans
  `contains` / `startsWith` / `orderBy` on an encrypted column and makes
  GROUP BY useless (randomised AES-GCM gives one group per row), so
  encrypting it would foreclose the supplier filter and any typeahead. A
  supplier's name on an invoice is not the commercial detail the manifest
  protects. It is still sanitised — encryption and sanitisation answer
  different questions.

- **`amount` is absent from the manifest, and that is load-bearing.**
  Listing a Decimal there fails SILENTLY: the middleware skips every
  non-string value without logging, so a reviewer reading only the
  manifest would believe the figure is protected while nothing happens.
  The column comment says so.

- **One domain link, enforced in three places.** Prisma cannot express
  "at most one of these five", so `assertSingleDomainLink` does it at the
  usecase, the modal makes it structural by asking for the KIND before the
  target, and an executing test pins both. A row with two links renders on
  two domain pages and is summed twice by anything grouping per domain.
  `updateCostEntry` validates the RESULTING row rather than the patch —
  checking the patch alone would accept a second link arriving next to an
  existing one, while still needing to allow a swap in one operation.

- **The invoice gate is copied from the RIGHT precedent.**
  `attachLogEntryFile` is the obvious model for "point a row at an
  existing FileRecord" and checks tenant ownership ONLY. A `FileRecord` is
  created `PENDING` before its bytes are confirmed and can be soft-deleted
  by the maintenance sweep, so `assertUsableInvoice` checks tenant +
  `STORED` + `deletedAt`, matching `audit-pack-sharepoint-export.ts`.

- **The category facet is a fixed enum, not derived from loaded rows.**
  Every other grain filter builds options from what loaded. For categories
  that is wrong: the facet would offer only the categories already used,
  and the one someone opens the filter to check is precisely the one
  nothing was filed under.

- **The list prints the RECORDED currency code, never the tenant symbol.**
  Entries in different currencies share one list and there is no FX table
  in the repo, so a single `€` over all of them would be a claim the data
  cannot support. This is the opposite call from the calculator, which
  legitimately uses the tenant symbol because it shows one tenant-scoped
  total.

- **Auth follows the PayrollExpense precedent, not `requirePermission`.**
  Grain is not in the Epic C.1 `PRIVILEGED_ROOTS`. Adding a
  `ROUTE_PERMISSIONS` rule for a path outside those roots fails the
  orphan-rule test, and adding the root pulls all ~11 existing grain
  routes into a scope none of them satisfies. A twelfth `PermissionSet`
  domain would also break every stored `TenantCustomRole.permissionsJson`
  and needs the `MECHANISATOR` arm or it mis-resolves. Module gate in the
  route, `assertCanRead` / `assertCanWrite` in the usecase.

- **No date facet.** `Filter.type` is `"default" | "range"` and `range` is
  a numeric min/max panel that `Math.trunc`s — it cannot carry an ISO
  date. A real date facet is a new filter type with its own encoder,
  decoder and tests, which is its own work rather than a line in a feature
  PR. The list sorts `incurredOn` descending instead.

- **One `[tenantId, fk]` composite per foreign key.** Layer B's
  `fkAdequatelyIndexed` tests `group[1] === fk` and never reads
  `group[2]`, so a combined `[tenantId, plantingId, seasonId]` would cover
  plantingId and leave seasonId a violation — and would leave Postgres
  without an index for a seasonId-only filter too.

- **Three stale registrations removed in the same diff.** Rewriting the
  client to `EntityListPage` removes the literal `<DataTable` from the
  file, which HARD-FAILS the stale check on its `filter-toolbar-coverage`
  exemption; the `columns-dropdown-coverage` exemption goes silently dead
  instead; and `costs-page-contract.test.ts` asserted on the rollup's
  `useState('totalCost')` and sliced at `</ListPageShell>`. The contract
  test was rewritten against the new surface, and its first assertion now
  pins the rollup's ABSENCE — a report quietly reappearing here is the
  regression that file exists to catch.

## Not in this PR

The invoice **upload UI**. The column, the completeness gate, the list
indicator and the API's acceptance of an existing file id all ship here,
but there is no file picker in the modal: the repo has **no generic
upload endpoint** — every multipart route mints its `FileRecord` inline as
part of an entity-specific write. Adding one is self-contained work, not a
field on this form.
