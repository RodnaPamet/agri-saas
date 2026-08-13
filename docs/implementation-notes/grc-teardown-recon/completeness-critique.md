## 1. The under-run modality: **relation-traversal and runtime-string identifiers**

The four modalities all key on a *literal token that names the surface*: an import specifier, a `prisma.<model>` delegate, a URL path, or a registry key. The category none of them can see is **a reference to a KILL model that never spells the model's name in any of those four positions**. Two families, both found:

**(a) Prisma relation-field traversal on a KEEP delegate.** `db.task.findFirst({ include: { practice: {…} } })` names `Practice` nowhere — the token is `task`. I ran this (relation keys inside `include`/`select`/`_count` blocks, excluding doomed directories) and it returns hits the 713-item list does not contain a single entry for:

- `src/app-layer/repositories/WorkItemRepository.ts:340` — `practice: { select: { id, code, name } }` inside `getById`. This is **the farm-task repository**, imported by `farm-task.ts`, `field-operation.ts`, `asset.ts`, `issue.ts`, `automation/action-executor.ts`.
- `src/app-layer/repositories/AssetRepository.ts:50`, `:76` — `_count: { select: { practices: true } }`, and `:124` — `include: { practices: { include: { practice: true } } }`. `/assets` is on the plan's "never touch" list (§7).
- `src/app-layer/repositories/EvidenceRepository.ts:80` (`practice: { select: … }`), `:188` (`practice: true`), `:142-143` (`where.practiceId`). `/evidence` is the surviving "Docs" nav surface.
- `src/app-layer/repositories/ProcessMapRepository.ts:147`, `:398`, `:478`, `:619` — the automation rule builder the plan explicitly KEEPS (§1d).
- `src/app-layer/repositories/AuditRepository.ts:12` and `VendorRepository.ts:26` are in this family too (the list caught only the first).
- `src/app-layer/usecases/evidence-retention.ts:104`, `:125`, `:258`; `src/app-layer/usecases/compliance-calendar.ts:507`; `src/app-layer/repositories/AssetMaintenanceRepository.ts:29`.

**(b) Model names used as runtime strings.** These are not registry keys in the "list of route paths" sense — they are identifiers *reconstructed at execution time*:

- `src/lib/retention-purge.ts:41-49` — `for (const model of SOFT_DELETE_MODELS) { $executeRawUnsafe(\`DELETE FROM "${model}" …\`) }`. The sweep classified `src/lib/soft-delete.ts:19/21/25/27-29` as a "registry-entry", which understates it: those strings become **SQL table names**. One stale entry after phase 3 throws `relation "Policy" does not exist` and, because it is a single loop with no per-model try/catch, kills the nightly purge **for every surviving model too** — `Asset`, `Evidence`, `FileRecord`, `Task`, `Contract`.
- `src/app-layer/usecases/soft-delete-operations.ts:43` and `:96` — the delegate is `(db as unknown as Record<string, ModelDelegate>)[model.charAt(0).toLowerCase() + model.slice(1)]`, where `model` arrives from an HTTP parameter. `:115-116` then does `DELETE FROM "${model}"`.
- `src/app-layer/jobs/data-lifecycle.ts:112`, `:303` — same `(db as unknown as Record<string, ModelDelegate>)[key]` shape.
- `src/app-layer/usecases/soft-delete-lifecycle.ts:96-100` — `const tableName = model; … DELETE FROM "${tableName}"`.

**(c) The scope gap underneath both.** Every test reference in the 713 comes from `tests/guards/` or `tests/guardrails/`. There are **zero** entries from `tests/unit`, `tests/integration`, `tests/rendered`, `tests/e2e` — yet **45 files** under those three tiers import a doomed `@/app-layer/{usecases,repositories,policies}` module directly (`tests/unit/usecases/vendor.test.ts`, `tests/unit/finding-usecase.test.ts`, `tests/integration/finding-create-modal.test.ts`, `tests/unit/security/sanitize-write-paths.test.ts`, …), and **24 e2e specs** navigate a doomed surface, including shared ones that are not obviously GRC: `tests/e2e/fixtures.ts`, `tests/e2e/auth.spec.ts`, `tests/e2e/a11y.spec.ts`, `tests/e2e/responsive.spec.ts`, `tests/e2e/core-flow.spec.ts`, `tests/e2e/data-table-platform.spec.ts`. Task T2.7 says "delete the GRC E2E specs" — but `fixtures.ts` and `a11y.spec.ts` cannot be deleted, they must be **edited**, and nothing in the sweep tells you that.

Also unswept: **57 files under `prisma/migrations/**/*.sql`** reference a KILL table by quoted name — the phase-3 blast radius for RLS policy drops and `.down.sql` inverses.

## 2. The unswept KILL surface: **requirement mapping (`/mapping`)**

`RequirementMappingSet` (`prisma/schema/compliance.prisma:534`), `RequirementMapping` (`:554`) and `FrameworkMapping` (`:521`) are all three on the plan's KILL list at `docs/implementation-notes/2026-08-12-grc-teardown-plan.md:136`. None of the ten swept surfaces covers them — "frameworks" and "clauses" are separate surfaces with separate models. The mapping surface is not small:

- `src/app/t/[tenantSlug]/(app)/mapping/page.tsx` + `layout.tsx`
- `src/app/api/t/[tenantSlug]/mapping/route.ts` **and** `src/app/api/mapping/route.ts` (the latter is *outside* the tenant tree, so a `rm -r src/app/api/t/*/mapping` leaves it live)
- `src/app-layer/repositories/RequirementMappingRepository.ts` — 13 delegate calls across `requirementMapping` and `requirementMappingSet`
- `src/app-layer/repositories/MappingRepository.ts` (`db.practice.findMany`)
- `src/app-layer/services/mapping-resolution.ts`, `src/app-layer/services/mapping-set-importer.ts` (`db.framework.findFirst`, `db.frameworkRequirement.findMany`, `db.requirementMapping.upsert`)
- `src/app-layer/usecases/mapping.ts`, `src/app-layer/domain/requirement-mapping.types.ts`
- `src/components/InheritedMappingsPanel.tsx`, `src/data/libraries/mappings/`

**And the mirror-image error: two swept surfaces are not on the KILL list at all.** `access-reviews` is backed by `AccessReview` (`prisma/schema/auth.prisma:539`) and `AccessReviewDecision` (`:597`) — in **auth.prisma**, named nowhere in the KILL list. `issues` is backed by nothing GRC: `src/app-layer/usecases/issue.ts:289/397/426` queries `db.auditLog`, `db.task` and `db.taskLink` — `AuditLog` is explicit KEEP (plan §"KEEP — staying where they are"), and `Task`/`TaskLink` are explicit KEEP (`work.prisma`). Sweeping those two while missing `/mapping` means the sweep's surface list was assembled from directory names, not from the KILL model list.

## 3. Files that fail to compile after deletion and are absent from the 713

- **`src/app-layer/usecases/journal.ts:16-20`** and **`src/app-layer/usecases/field-operation.ts:11`** — both `import { attachAutoEvidenceFromLogEntry } from './auto-evidence'` (journal also imports `syncDerivedEvidenceTitle`, `setDerivedEvidenceWithdrawn`). `auto-evidence.ts:113/123/201` reads `db.frameworkRequirement`, `db.practiceRequirementLink`, `db.practiceEvidenceLink` — all KILL. The plan names this at §1a/§5, but the sweep list contains **no entry for journal.ts, field-operation.ts, or auto-evidence.ts**, so a phase-2 executor working from the 713 alone breaks the journal.
- **`src/app-layer/repositories/WorkItemRepository.ts:509`** — `db.practice.findMany({ where: { id: { in: practiceIds } }, … })`. This is a plain `prisma-delegate` reference, exactly the modality the sweep claims to have run, and it is missing. Combined with `:340` (relation include), `:165-167`, `:286`, `:322`, `:398`, `:432`, `:500-515` (all `Task.practiceId`, a documented phase-3 dropped column), this file breaks in both directions. It is the repository behind farm tasks.
- **`src/app-layer/usecases/portfolio.ts:479`, `:812`** — `db.practice.findMany`. Consumed by `src/app/api/org/[orgSlug]/portfolio/route.ts:32` and `…/export/route.ts:39`, both org-scoped survivors. The sweep listed `PortfolioRepository.ts:48` but not `portfolio.ts`.
- **`src/app-layer/usecases/farm-record-traceability.ts:95/107/113/140`** — `db.frameworkRequirement`, `db.practiceRequirementLink`, and a `practice: { select: … }` include. This one is the trap: the filename says *farm-record*, so a name-driven delete keeps it, and it then fails to compile because every model it touches is gone. Its only importer, `src/app/api/t/[tenantSlug]/frameworks/[frameworkKey]/route.ts:10`, is itself doomed — so the correct action is delete, and nothing in the sweep says so.
- **`src/lib/framework-tree/{types,build,tree-helpers,minimap,builder-state}.ts`** — an entire `src/lib` directory absent from the list, and its consumers are **platform primitives under `src/components/ui/`**: `TreeView.tsx:63-64`, `TreeExpandCollapseToggle.tsx:23`, `ComplianceStatusIndicator.tsx:27`, `FrameworkMinimap.tsx:42-43`, `FrameworkBuilder.tsx:46-47`. Those four `ui/` files carry no GRC noun in their path and would be orphaned or broken depending on delete order.

## 4. Dynamic references a literal grep misses

Beyond the `(db as unknown as Record<…>)[…]` sites in §1(b):

- **Permission scopes are never spelled as literals.** `src/lib/auth/api-key-auth.ts:82-83` builds them — `` `${resource}:*` `` and `` `${resource}:${action}` `` — and `:130` destructures a stored key with `scope.split(':')`, `:184/:187` compare against the reconstruction. So the string `vendors:read` exists in code only at `src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx:57` (a display label). The **live values sit in `ApiKey.scopes` rows in the production database** and no code scan reaches them: after the teardown, every issued key carrying `vendors:*`/`audits:*`/`policies:*` silently fails `assertScope`.
- `src/lib/permissions.ts:431` — `over.push(\`${domain}.${action}\`)` reconstructs custom-role override keys from `TenantCustomRole.permissionsJson`, again a **DB-resident** reference to `policies.approve`, `vendors.edit`, `audits.freeze`.
- `src/app-layer/services/export-service.ts:151-153`, `:226`, `:255` and `import-service.ts:165-167`, `:253` — the list caught these; note they are the *same* pattern as the soft-delete sites, so the fix is one class, not eight one-offs.
- `src/i18n.ts:33` and `src/lib/i18n/server-messages.ts:38` — `await import(\`../messages/${locale}.json\`)`. Not a GRC reference itself, but it means the i18n key deletions in T2.12 have **no static import edge to validate against**; only `scripts/i18n-diff.mjs --check` will catch a key removed from `en.json` but left in `bg.json`.
- Same-class, DB-resident and worth a pre-flight row count before phase 3: `AutomationRule.event` holding `'POLICY_REVIEW_DUE'` / `'VENDOR_ASSESSMENT_OVERDUE'` (`src/app-layer/automation/events.ts:61-62`), `TenantModule.moduleKey = 'VENDORS'` (`src/lib/modules.ts:19`), and `Notification.entityType` / due-item `'VENDOR'` (`src/app-layer/jobs/types.ts:69`). Deleting the enum members orphans live rows; none of the four modalities looks at data.