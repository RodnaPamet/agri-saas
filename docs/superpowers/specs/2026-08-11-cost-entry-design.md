# 2026-08-11 — CostEntry: /grain/costs from report to entry surface

Blends two prompts plus a codebase investigation. Ships as **two PRs**: P1
(model + entry surface, reads nothing) and P2 (calculator + domain fan-out).

## The rule everything hangs off

`src/lib/grain/cost-metrics.ts` exists because three incompatible
definitions of "cost" once shipped under one word. This change can
recreate that in one step, so the split is explicit:

| Category | Feeds COST | Feeds CASH-OUT | Why |
| --- | --- | --- | --- |
| `PAYROLL` | ✅ | ✅ | No consumption path — nothing else records labour |
| `RENT` | ❌ | ✅ | Rent cost is the lease-terms ACCRUAL (see below) |
| `FERTILIZER` `FUEL` `SEED` `PESTICIDE` | ❌ | ✅ | Purchases. Crop cost is CONSUMPTION-based; counting both bills the same sack twice |
| `SERVICE` `OTHER` | ❌ | ✅ | A contractor is very likely ALREADY recorded as `LogEntry.costAmount` on the operation's journal entry. Counting the CostEntry too would double-count the same contractor. The existing path for "this operation cost me X" remains `LogEntry.costAmount` |

Cash-out is a NEW named metric in `COST_METRICS`, not a quiet addition to
an existing one.

### Rent: accrual and cash are different questions

Investigation confirmed three separate records:

- `ParcelLease` — lease TERMS (`rentAmount`, `rentUnit`, per decare).
- `resolveRentBasis` — a pure ACCRUAL: `perHectare = rentAmount * DCA_PER_HA`
  (`rent-basis.ts:173`). It never imports anything payment-related, and
  `grain-net-worth.ts` deliberately omits the `payments` relation that
  `rent-roll.ts` selects.
- `LeasePayment` — money actually paid. **It exists**, and is read ONLY by
  `getRentRoll`.

So `computeRent` is untouched: rent COST stays the contractual accrual, and
a farmer who has not paid still sees the rent they owe. `CostEntry(RENT)`
joins CASH-OUT. This generalises the purchase-vs-consumption rule rather
than inventing a second one.

Produce rent (кг/дка) has no money amount and is unaffected throughout.

## P1 — model + entry surface

### CostEntry (prisma/schema/grain.prisma)

Fields per prompt 1. `CostCategory` enum in `enums.prisma`.

**RLS.** Class-A table (NOT NULL `tenantId`, nullable FKs) ⇒ the split pair
`tenant_isolation` + `tenant_isolation_insert` + `superuser_bypass` +
`FORCE ROW LEVEL SECURITY`. Template: migration
`20260810120000_add_payroll_expense` — same shape, two days old. No
registration needed anywhere; `rls-coverage` is DMMF-derived. The policy
block is HAND-APPENDED to the generated migration — `prisma migrate dev`
knows nothing about RLS.

**Indexes.** `@@index([tenantId, incurredOn])` for the list shape, plus a
SEPARATE `[tenantId, fk]` composite for EACH of `plantingId`, `seasonId`,
`locationId`, `parcelId`, `leaseId`, `invoiceFileId`. A `[tenantId, a, b]`
composite covers only `a` — `fkAdequatelyIndexed` tests `g[1] === fk` and
never reads `g[2]`. Register in `LIST_QUERY_INDEXES` with a reason.

**Encryption.** `description` only. It is already in
`ALL_ENCRYPTED_FIELD_NAMES`, so a model carrying that column MUST be in
the manifest deliberately rather than by accident. `supplier` stays
plaintext: encrypting it forecloses `contains`/`orderBy`/GROUP BY, which
kills the supplier filter and any supplier typeahead — and a supplier name
on an invoice is not the commercial detail the manifest protects. `amount`
is `Decimal` and CANNOT be encrypted (the middleware skips non-strings
silently, so listing it would be a lie a reviewer could not see).
Classify in `sanitize-rich-text-coverage` under `RICH_TEXT_COVERAGE`
naming `sanitizePlainText`; `KNOWN_UNCOVERED` is capped at 1 and occupied,
so deferring is not available.

### Validation, usecases, routes

- One-link-only: at most ONE of planting/season/location/parcel/lease set.
  Validated at the usecase layer, with `leaseId` permitted only when
  `category === 'RENT'`.
- `sanitizePlainText` on `supplier` and `description` BEFORE persisting.
- `logEvent()` after every mutation — this is money entry.
- Repository reads all carry `take:`. **D2 has ZERO headroom** — the budget
  is 40 and the live count is exactly 40, so the first unbounded `findMany`
  fails CI.
- Auth follows the PayrollExpense precedent: `getTenantCtx` +
  `assertModuleEnabled(ctx, 'GRAIN')` in the route, `assertCanRead` /
  `assertCanWrite` in the usecase. NOT `requirePermission` — grain is not
  in `PRIVILEGED_ROOTS`, and adding a rule without adding the root turns CI
  red (orphan-rule test), while adding the root pulls all ~11 existing
  grain routes into scope and fails every one.

### Invoice upload

There is **no generic upload endpoint** — every multipart route mints its
`FileRecord` inline. So the costs route gets a multipart branch modelled on
the journal dual-mode route: write bytes → scan → `createPending` →
`markStored` inside one `runInTenantContext`.

For attaching an ALREADY-uploaded file by id, the completeness gate is
`status === 'STORED' && deletedAt == null`, copied from
`audit-pack-sharepoint-export.ts:90` — NOT from `attachLogEntryFile`, which
checks tenant ownership only and would reproduce exactly the defect prompt 1
asks to prevent.

### Page

`/grain/costs` becomes an `EntityListPage` (reference adopter:
`ContractsClient`, closer than practices — it already does
FilterProvider + create modal as a child + `GrainSectionNav` in
`toolbarActions`). Facets: category multi-select + live search. **No date
facet** — `Filter.type` is `"default" | "range"`, `range` is numeric and
`Math.trunc`s, so a date facet is net-new platform work deferred out of
this PR. Sorted `incurredOn` desc.

**The rollup does not vanish silently: it is DROPPED**, and the docblock
says so. The calculator already reports the same `ATTRIBUTED_CROP_COST`
figure as part of its cost side, so keeping both is precisely the
two-pages-one-number problem that prompted this rework.

Three existing registrations must be removed in the same diff or CI breaks:
- `tests/guards/filter-toolbar-coverage.test.ts` EXEMPTIONS — its stale
  check asserts the exempt file still matches `/<DataTable\b/`, which an
  EntityListPage rewrite removes ⇒ **hard fail**.
- `tests/guards/columns-dropdown-coverage.test.ts` EXEMPTIONS — goes
  silently dead rather than failing; delete manually.
- `tests/unit/costs-page-contract.test.ts` — asserts on the rollup's
  `useState('totalCost')`, `sortableColumns`, and slices at
  `</ListPageShell>`. Rewritten wholesale against the new surface.

Shell-adoption ratchet goes to `tests/unit/costs-list-shell-adoption.test.ts`
(all six existing siblings live under `tests/unit/`, not `tests/guards/`).

## P2 — calculator + domain fan-out

- `grain-net-worth` payroll switches from `PayrollExpense` to
  `CostEntry(PAYROLL)`. Note `grain-net-worth.ts:848` reads
  `db.payrollExpense.findMany` DIRECTLY, bypassing
  `PayrollExpenseRepository` — both sites need patching or the calculator
  keeps reading the old source.
- A data migration copies existing `PayrollExpense` rows into `CostEntry`.
  The table is LEFT IN PLACE (additive only, so the previous image still
  runs and no `deploy/rollback/` inverse is required). `/grain/payroll`
  redirects to `/grain/costs?category=PAYROLL`.
- Cash-out is computed per currency and reported per currency. No blending,
  no FX table. A mixed set returns an explicit mismatch the UI names.
- Domain pages READ their linked entries in ONE batched
  `findMany({ where: { xId: { in: [...] } } })` + an in-memory map. Never
  per row (D1), always `take:` (D2).
- Nothing writes into `StockTransaction`. It is hash-chained append-only
  with an `IMMUTABLE_STOCK_LEDGER` trigger on UPDATE **and DELETE**, needs
  `lotId`/`unitId`/`quantityDelta` a money form does not have, and its
  `costAmount` is a MOVEMENT TOTAL not a rate. A mistyped cost would be
  permanent and would relink every subsequent hash in the tenant.

## Testing

Executing, not just structural:

- A `FERTILIZER` CostEntry AND a CONSUMPTION StockTransaction for the same
  fertilizer ⇒ crop cost counted ONCE. The regression that matters most.
- `PAYROLL` entries move the calculator total; `RENT` entries do NOT move
  crop cost but DO move cash-out.
- Input entries appear in cash-out and not in crop cost.
- Per-currency grouping holds.
- Create with and without an invoice; a `PENDING` FileRecord is rejected;
  two domain links set is rejected; tenant isolation on list.
- Rendered: create modal + category facet (jsdom is a PHONE by default).

Plus a structural guard that input-category entries are never summed into
the crop-cost path, **with a mutation proof** — plant the violation, watch
it fail, restore.
