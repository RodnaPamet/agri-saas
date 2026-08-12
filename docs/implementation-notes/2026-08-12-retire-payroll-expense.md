# 2026-08-12 — Retire `PayrollExpense`

**Commit:** (pending — see PR)

## Design

`PayrollExpense` (#524, 2026-08-10) gave labour cost its own model, its own
API routes and its own page. Two days later `/grain/costs` became the
register where **every** kind of cost is entered (#533), with `PAYROLL` as
one of eight `CostCategory` values on `CostEntry`. That left two places to
type the same fact, and a farmer choosing between them is a farmer who can
get the total wrong.

The retirement ran in three migrations, deliberately spread across releases
so each one could be rolled back by the cheap lever before the next
narrowed the options:

```
20260810120000_add_payroll_expense           table exists, page exists
20260811160000_add_cost_entry                CostEntry lands beside it
20260812090000_payroll_expense_to_cost_entry rows COPIED, ids reused
                                             page becomes a redirect
                                             table LEFT IN PLACE
20260812180000_drop_payroll_expense          ← this change: DROP TABLE
```

The middle step is what makes this one safe. It copied every live row into
`CostEntry` with `category = 'PAYROLL'` **reusing the `PayrollExpense` id
verbatim**, and stopped there — an additive migration whose release could be
undone by pinning the image, because the old table was still sitting there
for the old code to find.

This change spends that grace period: the routes, usecase, repository, Zod
schemas, model and back-relations go, and the table is dropped.

### What is deliberately KEPT

`src/app/t/[tenantSlug]/(app)/grain/payroll/page.tsx` — a `redirect()` to
`/grain/costs?category=PAYROLL`. The URL is in browser histories, in the
sidebar of any still-open tab, and quite possibly in a bookmark. A 404 there
does not read as "this page moved"; it reads as "my payroll data is gone".
The category filter is pre-applied so the redirect lands on the rows the
farmer was looking for. It costs one file.

### The rollback problem this creates

`prisma migrate deploy` runs from `scripts/entrypoint.sh`, so shipping the
image is what applies the drop. Pinning Watchtower back then reverts the
CODE and leaves the SCHEMA dropped — the previous image queries a table that
is gone and fails outright. Snapshot restore is the only other lever, and
the schedule is daily at 02:00 UTC: up to 24 hours of farm data to undo a
release.

So this is the first change in the feature to require an inverse.
`deploy/rollback/20260812180000_drop_payroll_expense.down.sql` recreates the
shape, the four FKs, the three indexes and the RLS trio, then reads the rows
back out of `CostEntry WHERE category = 'PAYROLL'`. The id-for-id restore is
only possible because the forward copy reused the ids.

It restores what a pinned-back image can use. It does NOT restore
`supplier` / invoice / location / parcel / lease / item data a `CostEntry`
gained after the copy — the old table has no columns for those — nor rows
hard-deleted from `CostEntry` since. Both limits are stated in the script's
header rather than discovered at 2am.

### Before deploying

The claim "nothing writes here any more" is a claim about CODE. Whether
anything DID write is a claim about DATA, and this diff cannot settle it.
The migration header carries the query; run it first:

```sql
SELECT count(*) FROM "PayrollExpense"
 WHERE "createdAt" > (SELECT "finished_at" FROM "_prisma_migrations"
                      WHERE "migration_name" LIKE '%payroll_expense_to_cost_entry');
```

Non-zero means something still writes there and the drop would destroy data.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20260812180000_drop_payroll_expense/migration.sql` | `DROP TABLE`, with the pre-deploy verification query in its header |
| `deploy/rollback/20260812180000_drop_payroll_expense.down.sql` | The inverse — shape + RLS trio + id-for-id row restore from `CostEntry` |
| `tests/guards/destructive-migration-has-inverse.test.ts` | New. DERIVES the destructive-migration set by scanning SQL; requires each to have an inverse |
| `prisma/schema/grain.prisma` | Model removed; the header's back-relation inventory and the `CostEntry` doc corrected |
| `prisma/schema/auth.prisma`, `prisma/schema/planning.prisma` | The three back-relations removed |
| `src/app/api/t/[tenantSlug]/grain/payroll/**` | Both route files deleted |
| `src/app-layer/usecases/payroll-expense.ts`, `src/app-layer/repositories/PayrollExpenseRepository.ts` | Deleted |
| `src/app-layer/schemas/grain.schemas.ts` | Both payroll Zod schemas removed; `MAX_PAYROLL_AMOUNT` → `MAX_COST_AMOUNT` (still used by the `CostEntry` schemas) |
| `src/lib/security/encrypted-fields.ts` | `PayrollExpense` manifest entry removed; the `CostEntry` entry now carries the personal-detail reasoning |
| `tests/guardrails/{module-gate,sanitize-rich-text,schema-index}-coverage.test.ts` | The four registry entries whose stale-entry tests would otherwise fail |
| `src/app/t/[tenantSlug]/(app)/grain/payroll/page.tsx` | KEPT — redirect only; its docblock updated to say the backend is gone |
| `messages/{en,bg}.json` | The dead `payroll` namespace (25 keys) and `sidebarNav.payroll` removed from both locales |
| `deploy/rollback/README.md`, `CLAUDE.md` | Both now name the derived guard alongside the rename-bijection one |

## Decisions

- **Drop in a separate release from the data migration, not the same one.**
  Copying and dropping together is one deploy and one rollback story, and
  that story is "restore a snapshot". Splitting them meant the risky half
  shipped alone, after the new surface had run in production for a release.

- **The redirect page survives the model.** Deleting the route with the
  table is tidier and worse. Retiring a feature is not the same as retiring
  its URL, and the redirect is the cheapest possible apology to a bookmark.

- **The new guard DERIVES the destructive set rather than listing it.**
  `rename-rollback-inverse.test.ts` guards one migration by hardcoded path
  and proves a deeper property about it — a real bijection, with a mutation
  proof. But a hardcoded path cannot notice the *second* destructive
  migration, which is precisely the one nobody remembers. The new guard
  scans every `migration.sql` for `DROP TABLE` / `DROP COLUMN` / `DROP TYPE`
  / `RENAME TO` / `RENAME COLUMN` and requires an inverse that runs in one
  transaction and deletes its own `_prisma_migrations` row. The two are
  complementary: breadth and depth.

- **Fifteen historical migrations are grandfathered, not fixed.**
  `PREDATES_RULE` holds every destructive migration that shipped before
  `deploy/rollback/` was a convention. Writing fifteen retrospective
  inverses would be ceremony — no image old enough to need them is
  deployable. The list is a baseline with a stale-entry test, and the
  direction of travel is that it never grows: adding a name to it instead
  of writing an inverse is a decision that has to happen in a diff, in
  front of a reviewer.

- **The dead i18n namespace went in this diff, not a follow-up.** 25 keys ×
  2 locales that no component reads. `i18n-diff.mjs --check` compares
  locales against each other, so dead keys are invisible to it forever —
  nothing would ever have flagged them.

- **`RequiredPositiveAmount` was kept and renamed, not deleted.** The
  `CostEntry` schemas use it. Only the constant's payroll-specific name was
  misleading after the retirement.
