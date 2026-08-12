# 2026-08-10 — Payroll expense (first-class labour cost)

> **SUPERSEDED — this describes a surface that no longer exists.** Payroll
> became a CATEGORY on the `/grain/costs` cost register two days later, and
> `PayrollExpense` (model, routes, usecase, repository, page) was retired.
> Kept as the record of why the surface existed and what its data meant.
> See `2026-08-12-retire-payroll-expense.md`.

**Commit:** (pending — see PR)

## Design

Adds `PayrollExpense` as a new tenant-scoped model in the enterprise-grain
domain (`prisma/schema/grain.prisma`), alongside `Contract` / `YieldRecord`
/ `GrainDelivery`. It is a first-class COST producer, sitting next to
`LogEntry.costAmount` / `StockTransaction.costAmount` (the two sources
`getCostRollupByPlanting()` already aggregates in
`src/app-layer/usecases/cost-rollup.ts`) — the existing `/grain/costs`
report's own copy explicitly documents the gap it leaves: "Machinery,
labour, land rent, fuel and purchase contracts are not included." Payroll
closes the labour half of that list with its own surface rather than
folding into the read-only rollup.

```
PayrollExpense
  amount     Decimal(14,2)   plaintext — matches ParcelLease.rentAmount's precision
  currency   String          ISO-4217 code, e.g. "BGN" / "EUR"
  incurredOn DateTime        pay-period / disbursement date
  description String?        ENCRYPTED (Epic B) — can name an employee/contractor
  plantingId String?         optional attribution
  seasonId   String?         optional attribution
  createdByUserId String?    actor FK, SET NULL on user deletion
```

Layers, matching the existing grain-module shape exactly:

- **Repository** — `PayrollExpenseRepository` (`src/app-layer/repositories/`),
  class-of-static-methods over a `PrismaTx`, mirroring `LocationRepository`
  / `AssetRepository`. `list`/`count` share a `buildWhere`; `update`/
  `softDelete` use `where: { id }` only (the usecase's tenant-scoped
  `getById` is the gate, matching `AutomationRuleRepository`/
  `YieldRecord`'s usecase-level pattern — not the codebase's convention for
  `.update()` calls).
- **Usecase** — `src/app-layer/usecases/payroll-expense.ts`. Policy check →
  sanitize → validate FKs → repository call → `logEvent` → automation is
  intentionally NOT wired (no existing `PAYROLL_*` event in the Epic 60
  catalogue; out of scope for this PR).
- **Routes** — `/api/t/[tenantSlug]/grain/payroll` (GET/POST) and
  `/api/t/[tenantSlug]/grain/payroll/[payrollExpenseId]` (GET/PATCH/DELETE).
  Both call `assertModuleEnabled(ctx, 'GRAIN')` (registered in
  `module-gate-coverage.test.ts`), same as every other grain route.
- **Page** — `/grain/payroll`, `EntityListPage` + `DataTable` (`mobileFallback:
  'card'`, all five columns carry `meta.mobileCard`, including the row
  actions via `slot: 'actions'` — the RentClient pattern, so edit/delete
  stay reachable on a phone). `GrainSectionNav` gained a fifth `payroll`
  entry; the sidebar's Grain section gained a `Banknote`-icon item.

## Files

| File | Role |
|---|---|
| `prisma/schema/grain.prisma` | `PayrollExpense` model |
| `prisma/schema/auth.prisma` | `Tenant.payrollExpenses` / `User.payrollExpensesCreated` back-relations |
| `prisma/schema/planning.prisma` | `Season.payrollExpenses` / `Planting.payrollExpenses` back-relations |
| `prisma/migrations/20260810120000_add_payroll_expense/migration.sql` | Hand-written (PgBouncer down locally) — table + indexes + FKs + RLS trio |
| `src/lib/security/encrypted-fields.ts` | `PayrollExpense: ['description']` manifest entry |
| `src/app-layer/schemas/grain.schemas.ts` | `Create/UpdatePayrollExpenseSchema` |
| `src/app-layer/repositories/PayrollExpenseRepository.ts` | Tenant-scoped CRUD |
| `src/app-layer/usecases/payroll-expense.ts` | Business logic orchestration |
| `src/app/api/t/[tenantSlug]/grain/payroll/route.ts` | GET/POST |
| `src/app/api/t/[tenantSlug]/grain/payroll/[payrollExpenseId]/route.ts` | GET/PATCH/DELETE |
| `src/app/t/[tenantSlug]/(app)/grain/payroll/{page,PayrollClient,PayrollFormModal,filter-defs}.tsx` | List page |
| `src/app/t/[tenantSlug]/(app)/grain/GrainSectionNav.tsx` | +`payroll` section |
| `src/components/layout/SidebarNav.tsx` | +`payroll` sidebar item |
| `messages/{en,bg}.json` | `payroll.*` namespace + `grain.nav.payroll` + `sidebarNav.payroll` |
| `tests/guardrails/schema-index-coverage.test.ts` | FK exemption (`createdByUserId`) + Layer-C composite entry |
| `tests/guardrails/sanitize-rich-text-coverage.test.ts` | `PayrollExpense` classified into `RICH_TEXT_COVERAGE` |
| `tests/guardrails/module-gate-coverage.test.ts` | Both routes registered as GRAIN-gated |
| `tests/unit/payroll-expense-usecase.test.ts` | Executing coverage: list/get/create/update/delete |

## Decisions

- **No `requirePermission` / `route-permissions.ts` entry.** Every sibling
  grain route (`contracts`, `yield-records`, `bins`, `blend`, `costs`) uses
  the coarse `assertCanRead`/`assertCanWrite` usecase-layer gate, not the
  Epic C.1 `requirePermission` model — `GRAIN` has no `PermissionSet` flags
  and `src/app/api/t/[tenantSlug]/grain` is not one of the `PRIVILEGED_ROOTS`
  in `api-permission-coverage.test.ts`. Payroll follows the same
  convention its module neighbours use rather than introducing a second,
  inconsistent enforcement model within one domain. If GRAIN ever gains a
  permission-key model, all six routes should move together.
- **`description` IS encrypted, `amount` is NOT (and cannot be).** A
  payroll note can name an employee or contractor ("Overtime, combine
  operator I. Petrov") — personal as well as commercial detail, the same
  class of risk as `Contract.terms`/`pricingNotes` and `YieldRecord.
  valuationNotes`. `amount` stays a plaintext `Decimal(14,2)` because an
  encrypted column cannot be `SUM()`'d — required for the (not-yet-built)
  labour-cost rollup this model is the producer for.
- **List projection omits `description`.** Mirrors `YIELD_LIST_SELECT`:
  broadcasting encrypted commercial/personal text into every reader's page
  payload (including READERs who can never open the edit form) is the
  exact mistake that pattern was introduced to avoid. Fetched on demand by
  the edit modal via the single-record GET.
- **Search excludes `description`** for the same reason — a `contains`
  filter against ciphertext matches nothing and would read as "thorough
  but broken." The list search covers `currency`, the linked season's
  name, and the linked planting's crop-plan name instead.
- **No allocation logic here.** `plantingId`/`seasonId` are optional by
  design; a future net-worth / whole-farm P&L calculator is expected to
  spread unattributed rows pro-rata by harvested area (mirroring the
  `computePlantingCostRows` even-split precedent for multi-planting
  `LogPlanting` links). This PR is the producer only.
- **`/grain/costs` stays read-only.** `getCostRollupByPlanting()` is
  unmodified — folding payroll into it would need the labour figure to
  attribute the same way stock/journal costs do, which it structurally
  cannot (most payroll rows have no crop attribution at all). Payroll gets
  its own surface, matching the task brief.
- **Currency picker reuses `src/lib/grain/currencies.ts`.** Despite the
  file's doc-comment saying "offered for contract pricing," the function
  is generically an ISO-4217 short-list picker with an unknown-value
  passthrough; duplicating it for payroll would fork the currency
  vocabulary for no reason.
- **`no-hardcoded-ui-strings` baseline unchanged.** Every string in the
  new pages goes through `next-intl` from the start (nothing to extract),
  so the guard's `CURRENT_BASELINE = 20` was not touched — it still holds
  at the same count after this PR (verified: the guard passes unmodified).
- **Migration was hand-written**, not `prisma migrate dev`-generated —
  PgBouncer (:5433) is down in this dev environment, so the CLI cannot
  reach the DB. The SQL mirrors the canonical shape from
  `20260725120000_add_grain_delivery_fulfilment` (the most recent grain
  table addition) exactly: table → indexes → FKs → RLS trio via the `DO $$
  ... FOREACH ...` block. Purely additive (new table only) — no
  `deploy/rollback/*.down.sql` needed per the repo's rename/drop-only
  rollback policy.
- **Not verified locally: the migration's actual application, and any
  DB-backed integration test.** PgBouncer is down in this environment, so
  `npm run db:migrate` / `db:push` could not run, and `rls-coverage.test.ts`
  (which failed in the pre-existing sweep against a stale, unmigrated local
  test DB — 14 failures across 3 suites, none naming `PayrollExpense`,
  all reproducing the documented "stale local DB" / "incomplete worktree
  node_modules" gotchas) could not confirm the new RLS policies against a
  real Postgres. The migration SQL was checked by hand against the two
  most recent precedent migrations in the same file
  (`20260616071027_add_enterprise_grain`,
  `20260725120000_add_grain_delivery_fulfilment`) for byte-for-byte shape
  parity instead.
