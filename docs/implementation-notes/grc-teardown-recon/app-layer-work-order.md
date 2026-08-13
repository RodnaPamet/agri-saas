# GRC Teardown Phase 2 — Consolidated Work Order

Baseline verified at HEAD (`6475536d`): `npx tsc --noEmit` **clean**, `git status` clean. `tsconfig.json` includes `**/*.ts(x)` and **excludes `scripts/` and `prisma/seed.ts`** — so test files ARE typecheck-gated, and `scripts/`/`seed.ts` breakage is invisible to tsc. Plan §8g (2026-08-13) is authoritative: **every KILL table on prod has 0 rows**; `TenantApiKey`/`TenantCustomRole`/`AutomationRule`/`TenantModuleSettings` all 0 rows. **No data migration is needed for the §8d.4 orphaned-enum class on this stack.** Delete every "pre-flight row count + data migration" gate the cluster plans propose; re-run the count immediately before the phase-3 migration instead.

---

## A. BLOCKING — do these, or the named edit breaks a KEEP surface

Each is verified. `✗` = what a cluster plan told you to do. `✓` = do this instead.

### A1. `admin/api-keys/page.tsx` is a live scope picker, not a display label
Three clusters (vendor, framework, audit/registries) tell you to delete a resource from `SCOPE_ACTION_MAP` and call the page "display-only". Verified `src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx:52-63` — `SCOPE_GROUPS` renders checkboxes whose values POST to `createApiKey` → `validateScopes()` (built from `SCOPE_ACTION_MAP`).
- ✗ Remove the map row only.
- ✓ Delete `practices`/`policies`/`vendors`/`tests`/`frameworks`/`audits` from **both** `SCOPE_ACTION_MAP` (`src/lib/auth/api-key-auth.ts:63-74`) **and** `SCOPE_GROUPS` (page.tsx:52-63) **in one commit**.

### A2. `permissions.ts` and `api-key-auth.ts` must land in the SAME commit
Verified `api-key-auth.ts:114-118` seeds `result` from `getPermissionsForRole('READER')` (i.e. from `PermissionSet`) and `:138`/`:147` do `permAction in result[resource]` keyed off `SCOPE_ACTION_MAP`. Drop a `PermissionSet` domain while the scope map keeps it ⇒ `result[resource]` is `undefined` ⇒ **`TypeError` on every API-key-authenticated request**. `result` is `any`, so tsc will not catch the split.
- ✓ One commit: `permissions.ts` (6 domains × type + `PERMISSION_SCHEMA` + 6 role arms) + `api-key-auth.ts` + `api-keys/page.tsx` + `evidence-import.ts:271` (A3).

### A3. `evidence-import.ts:271` reads `audits.view` on a NEVER-TOUCH surface
Verified. Removing the `audits` domain is a hard tsc break on the `/evidence` ZIP importer.
- ✗ "Delete the field."  ✗ "`role === 'AUDITOR' || appPermissions.admin.view`" — that flips EDITOR/READER from true→false.
- ✓ Import `computePermissions` from `src/lib/tenant-context.ts:54` (or inline `canAudit: role === 'AUDITOR' || ROLE_LEVEL[role] >= 4`) and document the EDITOR/READER change in the commit body. Same line exists at `sharepoint-delta-sync.ts:37` — see A4.

### A4. `sharepoint-delta-sync.ts` is KEEP, not GRC
The registries plan says it "goes". Verified: its only delegates are `prisma.tenantMembership` (:20, :67) and `prisma.integrationConnection` (:58); its context is `evidence.view`/`evidence.upload`; `providers/sharepoint/import.ts` has **0** policy references and calls `uploadEvidenceFile`. Live wiring: `src/app/api/t/[tenantSlug]/integrations/sharepoint/sync/route.ts`, `executor-registry.ts:1000,1014`, `schedules.ts:79`.
- ✓ KEEP `sharepoint-delta-sync.ts`, `import.ts`, `client.ts`, `token.ts`, `service.ts`, `mapper.ts`, `types.ts`, `index.ts`, `health.ts` (sever `policyLinks` only), all 7 `/integrations/sharepoint/*` + 4 `/admin/integrations/sharepoint/*` routes.
- ✓ KILL only: `usecases/policy-sharepoint-sync.ts`, `jobs/sharepoint-policy-jobs.ts` (19 policy refs, verified), `providers/sharepoint/docx.ts`, `src/app/api/webhooks/sharepoint/route.ts`, `executor-registry.ts:1026,1039`, `schedules.ts:85`.
- ✓ Sever `sharepoint-delta-sync.ts:37` `canAudit` exactly as A3.

### A5. `AddTaskLinkSchema` (`src/lib/schemas/index.ts:420`) is on the farm-task path
Verified: `entityType: z.enum(['PRACTICE','FRAMEWORK_REQUIREMENT','ASSET','POLICY','EVIDENCE','FILE','AUDIT_PACK','VENDOR'])` is `AddTaskLinkSchema`, parsed by `src/app/api/t/[tenantSlug]/tasks/[taskId]/links/route.ts` and `.../issues/[issueId]/links/route.ts` — **both exist, both NEVER-TOUCH (§8a)**.
- ✗ Four clusters each "drop my member" ⇒ four conflicting diffs.
- ✓ ONE edit in T4: enum becomes `['ASSET','EVIDENCE','FILE']`. Companion edits required in the same commit: `src/components/ui/entity-picker.tsx` (`EntityPickerKind` :56, switch arms :94, :104-117, :143, :152-166), `FarmTaskDetailClient.tsx:60`, `NewTaskFields.tsx:53-58`, `useNewTaskForm.ts:116,249-264`, `LinkedTasksPanel.tsx:114-115`, `src/lib/schemas/index.ts:580`.
- ✓ Then `npm run openapi:generate` + `npx jest tests/contracts -u` — `public/openapi.json` (8 vendor hits) and `tests/contracts/__snapshots__/` are committed generated artifacts that no cluster plan mentions.

### A6. `Task.practiceId` removal breaks `usecases/task.ts` and disables 3 WorkItemTypes
Verified `task.ts:35-63` `validateTypeRelevance` throws unless the task has `practiceId` **or** a `PRACTICE`/`FRAMEWORK_REQUIREMENT` link — and A5 removes both link options. `AUDIT_FINDING`/`PRACTICE_GAP` become uncreatable; `INCIDENT` survives only via `ASSET`.
- ✗ "Drop `practiceId` from WorkItemRepository; farm-task creation untouched."
- ✓ One commit removing: `task.ts:40-63` (delete `validateTypeRelevance` and its call sites `:146-151`, `:350`), `:133`, `:179`, `:213`, `:931-940` (`listTasksByPractice`), `src/app/api/t/[tenantSlug]/tasks/route.ts:21,48,70`, `src/lib/schemas/index.ts:372,385`, plus the WorkItemRepository sites.
- ✓ **Delete** `src/app/api/t/[tenantSlug]/issues/by-practice/[practiceId]/route.ts` (verified: `@deprecated`, calls `listTasksByPractice`) and `usecases/issue.ts:427` `listIssuesByPractice` (verified: `TaskLinkEntityType.PRACTICE`, an enum VALUE — invisible to any delegate or relation-key scan, breaks at phase 3).
- ✓ Decide with the operator whether `AUDIT_FINDING`/`PRACTICE_GAP`/`INCIDENT` stay in the `TaskType` picker (`NewTaskFields.tsx:35-37`) at all.

### A7. The asset Evidence tab holds an AGRI panel
Verified `assets/[id]/page.tsx:359-381`: `AttachedEvidencePanel` (endpoint `/assets/${id}/evidence/attached`, backed by `Evidence.assetId`) **stacked above** `InheritedEvidencePanel` (KILL). `grep AttachedEvidencePanel src tests` → this page is its **only mount**.
- ✗ "Remove the evidence/mappings/traceability tabs."
- ✓ Keep the `evidence` tab and the `AttachedEvidencePanel` block; delete only the `InheritedEvidencePanel` block (:376-381) and the `<Heading>{t('inheritedFromPractices')}</Heading>`. Delete the `mappings` and `traceability` tabs.
- ✓ **Move `{ key: 'evidence' }` out of the `showCompliance` spread** so plain-farm tenants get it. KEEP `src/app/api/t/[tenantSlug]/assets/[id]/evidence/attached/**` (2 routes).

### A8. Deleting the `mappings` tab turns a guardrail red
Verified `tests/guardrails/b6-usezodform-adoption.test.ts:66-95`: `CANONICAL_TABS` includes `'mappings'`, `PAGES` = the assets detail page, and the test regex-matches `['"]mappings['"]` against that file.
- ✓ Same commit as A7: drop `'mappings'` and `'traceability'` from `CANONICAL_TABS`, rename the describe to "4-tab".

### A9. `AssetMaintenance.vendorId` — sever the WRITE, not just the read
Verified `AssetMaintenanceRepository.ts:28` (`vendor:` include), **`usecases/asset-maintenance.ts:44,82`** (`vendorId: input.vendorId ?? null` — always emitted), **`assets/[id]/maintenance/route.ts:30`** (zod field). Severing only the include leaves every maintenance-record creation throwing `Unknown argument 'vendorId'` at phase 3.
- ✓ All four sites in one commit.

### A10. `action-executor.ts` has TWO practice sites
Verified `:145` + `:177` (`createTask` resolves `practiceId` and always spreads it into `db.task.create`) in addition to `:219` (`case 'Practice'`). Every automation create-task action breaks at phase 3, not just practice-configured ones.
- ✓ Remove both. `:219` falls through to the existing `default:` (`{ ok: false, summary: 'Unsupported entityType' }`).

### A11. `encrypted-fields.ts` — `Finding` is the Epic B test exemplar
Verified `tests/unit/encryption-middleware.test.ts:43-58` asserts `isEncryptedModel('Finding'|'Audit'|'AuditChecklistItem'|'Vendor'|'PolicyVersion')` is `true`. Six suites (`encryption-middleware`, `encryption-middleware.tenant-dek`, `encrypt-existing-data`, `key-rotation-job`, `integration/epic-b-encryption`, `integration/tenant-dek-rotation`) use `Finding` as the fixture for the KEEP encryption extension, the v1→v2 sweep and the per-tenant DEK fallback.
- ✗ Delete the manifest rows and the six suites.
- ✓ **Re-point every suite to a surviving manifest model** (`Task`, `TaskComment`, `Contract`, `EvidenceReview` — all verified present) in the same commit as the manifest edit. Deleting them ships the DEK rotation with zero behavioural coverage.

### A12. `messages/en.json` `policies` namespace is guarded
Verified `tests/guards/list-page-descriptions.test.ts:32-39` — `ENTITIES` includes `'policies'`, `'audits'`, `'findings'`, `'practices'` and throws if `messages[entity].listDescription` is missing.
- ✓ Narrow `ENTITIES` to `['assets','evidence']` in the same commit as the i18n purge.

### A13. `NewTenantForm.tsx` strands users on a deleted page
Verified `src/app/org/[orgSlug]/(app)/tenants/new/NewTenantForm.tsx:196-200` — 5 of 6 options `router.push('/t/{slug}/frameworks?install=…')`; `find src/app -ipath '*frameworks*'` → nothing. A live 404 on the org tenant-creation flow, in no cluster's list.
- ✓ Delete `FRAMEWORK_OPTIONS` (:54-60) and the whole framework step; always `router.push('/t/{slug}/dashboard')`. Update `tests/e2e/ciso-portfolio.spec.ts:236`.

### A14. `usecases/practice` barrel — `/evidence` is its last src importer
Verified: `grep -rn "usecases/practice" src` → only `evidence/page.tsx:4`. Its full closure is larger than any plan states: `buildEvidenceFilters(practices, evidence)` (`filter-defs.ts:156`, **required first param**), `UploadEvidenceModal.tsx:110` and `NewEvidenceTextModal.tsx:51` (`practices: PracticeOption[]`, **non-optional**), `EditEvidenceModal.tsx`, `EvidenceDetailSheet.tsx`.
- ✓ Sever page + client + `filter-defs.ts` + 4 modals/sheet + `tests/unit/evidence-filter-defs.test.ts` in ONE commit, **before** deleting `src/app-layer/usecases/practice/`.

### A15. `no-unsafe-any.test.ts` asserts DTO/hook files EXIST
Verified `tests/guards/no-unsafe-any.test.ts:107-135` — `expect(fs.existsSync(...)).toBe(true)` over `practice.dto.ts`, `policy.dto.ts`, `vendor.dto.ts`, `framework.dto.ts`, `audit.dto.ts` and `use-practices.ts`, `use-policies.ts`. Also `tests/guards/contract-drift.test.ts:15-22` `require()`s all five modules (MODULE_NOT_FOUND on delete), and `tests/unit/openapi-foundation.test.ts` / `tests/rendered/lib-domain-hooks.test.tsx` hold **top-level namespace imports** (whole suite fails to resolve).
- ✓ Narrow all four registries to `['task.dto.ts','asset.dto.ts','evidence.dto.ts']` / `['use-api.ts','use-tasks.ts','use-assets.ts','use-evidence.ts','index.ts']` in the same commit as the deletions.

### A16. `src/app-layer/utils/__tests__/cadence.test.ts` is collected
Verified the file exists and `jest.config.js:368` jsdom `testMatch` includes `'<rootDir>/src/**/__tests__/**/*.test.{ts,tsx}'`.
- ✓ Delete it with `src/app-layer/utils/cadence.ts`.

### A17. `search-palette-migration.test.ts` requires the line you are deleting
Verified `tests/unit/search-palette-migration.test.ts:157` `expect(usecase).toMatch(/db\.policy\.findMany/)`. Plus `Record<SearchHitType, …>` totality: `src/lib/palette/filter.ts:66-74`, `src/lib/search/types.ts:117` (`perTypeCounts`), `search.ts:248-251` and `:436` (`__SEARCHABLE_TYPES__`), `palette/recents.ts:122-136`, `command-palette.tsx:157-196`, `search/rank.ts:38,111`.
- ✓ One atomic commit across all eight files + the seven asserting suites (`search-palette-migration`, `search-route`, `search-rank`, `search-asset-coverage`, `palette-filter`, `palette-recents`, `command-palette-entity-search`).
- ✓ While there, **add** `'asset'` and `'task'` (+ icons `'package'`, `'check-square'`) to `recents.ts` `VALID_TYPES`/`VALID_ICONS` — they are already missing, so trimming without adding leaves ⌘K Recents permanently empty.

### A18. `Record<ModuleKey, …>` cannot lose `VENDORS` in phase 2
Verified `src/lib/modules.ts:12` (`import type { ModuleKey } from '@prisma/client'`), `:51` `MODULE_LABELS: Record<ModuleKey, string>`, `src/lib/entitlements.ts:99` `MODULE_MIN_PLAN: Record<ModuleKey, BillingPlan>`, and `prisma/schema/enums.prisma:1064-1075` still carries `VENDORS`.
- ✓ Phase 2: remove `'VENDORS'` from `ALL_MODULES` (plain array, `modules.ts:14-25`) and from `admin/modules/route.ts:10` only. **Keep both Record rows until phase 3.**

### A19. `computeRag` turns every org tenant RED
Verified `src/app-layer/schemas/portfolio.ts:346-355` — `coveragePercent < 60 → 'RED'`, fed by `practiceCoverageBps`, which `jobs/snapshot.ts` already stopped computing in the §8f trim (writes `@default(0)`).
- ✗ "Drop the practices fields from the DTO."
- ✓ Decide explicitly: re-base `computeRag` on `overdueEvidence` alone (change `RagInputs` so a caller cannot forget) **or** remove the RAG badge from `PortfolioSummary` + `TenantHealthRow` + the two org pages. Ship in the same commit as the `portfolio.ts` sever; say which in the commit body.

### A20. `downloadEvidenceFile` READER/AUDITOR gate is a security decision
Verified `src/app-layer/usecases/evidence.ts:841-853` — READER/AUDITOR may download only when `evidence.practiceId` is non-null. Deleting the condition **widens privilege to every file in the tenant**; keeping it throws at phase 3.
- ✓ Its own commit, reviewed. Option (a) re-base on `assetId ?? taskId ?? sourceLogEntryId` non-null (preserves posture); option (b) widen deliberately and record it in the docblock at `:814` and `docs/epic-d-completeness.md`. Add an executing test either way — there is none today.

### A21. `canonical-parents.ts` back-links for live admin pages
Verified: `admin/vendor-templates/**` and `admin/vendor-assessment-reviews/**` **still exist on disk**, and `canonical-parents.ts:57-59` are their `PARENT_MAP` entries. `BackAffordance.tsx:118` returns `null` when `resolveCanonicalParent` misses.
- ✓ Delete those 3 entries **in the same commit that deletes the 3 page trees** (T1), never before. Same rule for `page-segregation.ts:108-110`.

---

## B. Cluster disagreements — resolved

| File | Conflict | Resolution |
|---|---|---|
| `usecases/inherited-practice-data.ts` | practice: delete-whole · framework: sever (keep `getAssetInheritedEvidence`) | **DELETE WHOLE.** Both importing routes (`assets/[id]/{mappings,evidence}/route.ts`) are deleted; `getAssetInheritedEvidence` has no surviving caller once A7 lands. |
| `jobs/calendar-deadlines.ts` | vendor/audit/keep-file each claim it; each severs a third | **AUDIT cluster owns it, delete-whole in T3.** All 3 scanners (`auditCycle`:84, `vendorDocument`:138, `finding`:193) are KILL. Sever `notification-dispatch.ts:115-133` down to `runDeadlineMonitor` in T2. |
| `policies/framework.policies.ts` | framework: delete-whole · unclaimed 4th importer `farm-record-traceability.ts:38` | Verified 4 src importers, all KILL. **Delete `farm-record-traceability.ts` in T1, `framework.policies.ts` in T3.** |
| `usecases/report.ts`, `ReportRepository.ts`, both `reports/route.ts` | registries + keep-file both claim delete-whole | **REGISTRIES owns.** Delete `src/app/api/reports/route.ts` (outside tenant tree) and `src/app/api/t/[tenantSlug]/reports/route.ts` **as files** — the 5 agri siblings (`field-briefing`, `rent-roll`, `season-diary`, `season-recap`, `year-on-farm`) stay. |
| `services/editable-lifecycle.ts` + `usecases/editable-lifecycle-usecase.ts` + `domain/editable-lifecycle.types.ts` + `policies/lifecycle.policies.ts` | brief assigned to policy cluster · policy plan says KEEP | **KEEP all four** (zero KILL delegates; one docblock example at `editable-lifecycle.ts:387` to reword). Delete only `services/policy-lifecycle-adapter.ts` and `services/vendor-assessment-lifecycle-adapter.ts`. |
| `integrations/prisma-local-store.ts` | practice: "delete file or sever" · keep-file: sever | **SEVER.** Both importers survive (`webhook-processor.ts:389`, `jobs/sync-pull.ts:67`). Flag in the PR that the class is now a no-op and that retiring the GitHub sync orchestrator is a follow-up. |
| `DashboardRepository.ts` | policy/vendor/keep-file each sever one method | **ONE edit (keep-file owns):** delete `getPracticeCoverage`, `getPracticesByStatus`, `getPolicySummary`, `getVendorSummary` + dead DTOs. Keep `getEvidenceExpiry`/`getTaskSummary`/`getAssetSummary` — `jobs/snapshot.ts:134-136` is the only src caller. |
| `tests/e2e/global-teardown.ts` | audit: "no later than phase 3" · vendor/practice: phase 3 | **PHASE 3.** Verified the loop is savepoint-per-statement with a swallowing catch, so a dropped table does not break teardown. Remove all 11 GRC table names in the migration diff. |
| `src/lib/soft-delete.ts` line numbers | registries plan cites 17,19,22,26,28,29,30 | Verified actual: **17 Practice, 19 Policy, 21 Vendor, 25 Finding, 27 Audit, 28 AuditCycle, 29 AuditPack**. `:22` is `FileRecord` (KEEP), `:30` is a comment. **Edit by name, never by line.** |
| `src/lib/retention-purge.ts` | plan §8d.2 + 4 clusters call it "the nightly purge" | Verified **zero src importers**. The scheduled purge is `schedules.ts:207` → `executor-registry.ts:370` → `jobs/data-lifecycle.ts:98`, which guards `if (!delegate) continue` at `:113`/`:304`. Trim `SOFT_DELETE_MODELS` (fixes both); add a per-model try/catch to `retention-purge.ts` or delete it as dead code. Do not claim "fixed the nightly purge" unless `data-lifecycle.ts` was edited. |
| §8d.4 pre-flight counts (5 clusters) | all propose SQL against `ApiKey`/`TenantModule`/`AutomationRule.event` | **Delete every one.** §8g: those are `TenantApiKey`/`TenantModuleSettings.enabledModules`/`AutomationRule.triggerEvent`, and all have 0 rows. The proposed SQL errors on 3 of 5 names. |
| `usecase-test-coverage.test.ts` `BASELINE` | framework says lower to 8, practice says 8, audit/vendor/keep-file each remove entries | Verified `EXEMPTION_COUNT` is 10, assertion is `<= BASELINE`. Entries removed across all clusters: `clause.ts`, `framework/catalog.ts`, `framework/tree.ts`, `report.ts`, `inherited-practice-data.ts`, `vendor-audit.ts`, `traceability.ts` = 7 → final count **3**. Set `BASELINE = 3` **once, in T5**. |
| `entity-picker.tsx` | vendor severs `VENDOR`, framework severs `FRAMEWORK_REQUIREMENT`, keep-file severs `PRACTICE` | **ONE edit** (see A5). Verified the cast sites (`FarmTaskDetailClient.tsx:60`, `NewTaskFields.tsx:53-58`) never offer `VENDOR`, so the vendor plan's "behaviour lost" claim is wrong — no behaviour is lost there. |
| `tests/load/vendor/k6-summary.js` | vendor plan flags it | **DO NOT DELETE.** Vendored MIT k6 library, imported by 5 surviving load scripts. Exclude `tests/load/vendor/` by name from any glob. |

---

## C. Merged single-owner edits (one diff each, not N)

`src/lib/permissions.ts` · `src/lib/auth/api-key-auth.ts` · `admin/api-keys/page.tsx` · `src/lib/soft-delete.ts` · `src/lib/security/classification.ts` · `usecases/soft-delete-operations.ts` · `domain/restore-validators.ts` · `jobs/data-lifecycle.ts` · `src/lib/schemas/index.ts` · `src/lib/dto/index.ts` · `src/lib/hooks/index.ts` · `src/lib/swr-keys.ts` · **`src/lib/queryKeys.ts`** (second registry, named by no plan) · `src/lib/nav/page-segregation.ts` · `src/lib/nav/canonical-parents.ts` · **`src/components/nav/BackAffordance.tsx`** (third nav registry, `SECTION_LABELS:36-65`, named by no plan) · `jobs/executor-registry.ts` · `jobs/schedules.ts` · `jobs/types.ts` · `jobs/notification-dispatch.ts` · `jobs/deadline-monitor.ts` · `notifications/{templates,enqueue,index,digest-templates}.ts` · `automation/{events,event-contracts}.ts` · `lib/automation/event-labels.ts` · `domain/entity-status-mapping.ts` · `domain/due-item-ownership.ts` · `usecases/search.ts` + `lib/search/*` + `lib/palette/*` + `command-palette.tsx` · `lib/security/encrypted-fields.ts` · `src/app-layer/schemas/calendar.schemas.ts` + `lib/design/status-tone.ts` + 5 calendar consumers · `messages/{en,bg}.json`.

---

## D. Tranches

Each tranche must end `npx tsc --noEmit` clean. Tests are in tsconfig, so **test edits ship in the same tranche as their subject**.

---

### T1 — Orphans and already-broken surfaces
*Position: zero surviving importers (all grep-verified), so nothing else can depend on the order.*

Delete: `src/app/vendor-assessment/**` (2 files) · `src/app/t/…/admin/vendor-templates/**` (4) · `src/app/t/…/admin/vendor-assessment-reviews/**` (2) · `src/app/audit/shared/[token]/page.tsx` (verified: its API route was deleted in `ef96908a`, page is in `PUBLIC_ROUTES`) · `usecases/farm-record-traceability.ts` + its test + `no-direct-prisma.test.ts:246` · `services/vendor-assessment-lifecycle-adapter.ts` · `lib/schemas/vendor-form.ts` · `src/data/{frameworks,clauses,annex-a}.ts` · `components/frameworks/FrameworkExplorer.tsx` + `ui/{TreeView,TreeViewItem,TreeExpandCollapseToggle,ComplianceStatusIndicator,FrameworkMinimap,FrameworkBuilder}.tsx` + `src/lib/framework-tree/**` · the data-portability closure (`usecases/data-portability.ts`, `policies/data-portability.policies.ts`, `services/{export-service,import-service,export-graph,export-schemas,import-snapshot,bundle-codec,tenant-safety}.ts`) + its 8 test files.

Sever in the same commit: `src/lib/auth/guard.ts:31-34` (all four public prefixes) · `tenant-isolation-structural.test.ts:81` · `page-segregation.ts:108-110` + `canonical-parents.ts:57-59` (**A21**) · the 7 guard registries keyed on the deleted page paths (`entity-detail-layout-coverage`, `pageheader-adoption`, `heading-primitive-discipline`, `no-raw-palette-greys:60`, `single-h1-per-page:56`, `typography-eradication`, `page-breadcrumbs-coverage`) · `no-lucide.test.ts` LEGACY entries · `no-horizontal-drift-patterns.test.ts:165-169` · `shortcut-conflict-scenarios.test.tsx:194` · **re-home** `tests/unit/tenant-safety-selfref.test.ts:440-484` (a repo-wide self-referencing-FK scan that would die with the closure).

Verify: `npx tsc --noEmit && npx jest tests/guards tests/guardrails`

---

### T2 — KEEP→KILL **module import** seams
*Position: after this, no surviving file imports a KILL module, so T3 can delete freely. Two of these are dynamic `await import()` — tsc will NOT catch a wrong order.*

- **A14** `/evidence` closure (page + client + filter-defs + 4 modals + its test).
- **A7 + A8** `assets/[id]/page.tsx` tabs + `b6-usezodform-adoption.test.ts`.
- `AssetsClient.tsx:317,402-412` practices column + `hasComplianceModules` import.
- `jobs/executor-registry.ts` — remove `automation-runner` (:328-343), `policy-review-reminder` (:406-418), `sharepoint-policy-pull` (:1026), `sharepoint-subscription-renew` (:1039), `vendor-renewal-check` (:565-570). **Keep `sharepoint-delta-sync` + `-dispatch`** (A4).
- `jobs/schedules.ts` — remove `automation-runner` (:59-64), `policy-review-reminder` (:213), `sharepoint-subscription-renew` (:85). Keep `:79`.
- `jobs/types.ts` — the matching `JobName`/`JobPayloadMap`/`JOB_DEFAULTS` entries (exhaustive maps; partial removal fails tsc, which is the desired signal).
- `jobs/notification-dispatch.ts` — collapse `:115-133` to `runDeadlineMonitor` only; delete the `VENDOR_RENEWAL_DIGEST` branch (`:184-215` + `:40,:51,:58,:65,:80`).
- `src/lib/dto/index.ts` (5 lines) · `src/lib/hooks/index.ts:35-36` — **with A15** in the same commit.
- `tests/regression/infrastructure-guards.test.ts:92,105` — verified expects `toHaveLength(24)` and lists `'automation-runner'`; drop to 23 and remove the name.
- `tests/unit/{job-scope-audit,job-tenant-isolation-regression,jobs-context-and-fanout,periodic-monitors,notification-pipeline-regression,notification-pipeline-single-run,calendar-deadlines-monitor,sharepoint-webhook}.test.ts` — narrow/delete. `job-scope-audit` does `readFileSync` on deleted paths (ENOENT).
- `tests/guards/epic49-calendar-ratchets.test.ts:127-152` — asserts `calendar-deadlines.ts` EXISTS.
- `scripts/` (tsc-invisible, verify by hand): `scripts/openapi-build.ts:57,61,150,154` · `scripts/seed-demo.ts:38` · delete `scripts/framework-import.ts`, `scripts/import-schemes.ts`, `prisma/catalog-{loader,applier}.ts`, `prisma/catalogs/` + `package.json:27-28`.

Verify: `npx tsc --noEmit && npx jest tests/unit/notification-pipeline-regression tests/unit/notification-pipeline-single-run tests/unit/periodic-monitors tests/regression && npx tsx scripts/openapi-build.ts 2>/dev/null || npm run openapi:generate`

---

### T3 — Delete the KILL closure
*Position: T2 removed every surviving importer. `grep -rn "usecases/\(practice\|policy\|vendor\|audit\|framework\|clause\|finding\|traceability\|report\|mapping\|gap-analysis\|library-sync\)" src` must return **zero** before starting.*

usecases: `practice/**` (7), `policy.ts`, `policy-attestation.ts`, `policy-sharepoint-sync.ts`, `vendor.ts`, `vendor-audit.ts`, `vendor-assessment-{reminder,response,review,send,template}.ts`, `vendor-reassessment-reminder.ts`, `audit.ts`, `finding.ts`, `clause.ts`, `audit-readiness/**` (5), `audit-readiness-scoring.ts`, `audit-pack-sharepoint-export.ts`, `framework/**` (4), `gap-analysis.ts`, `library-sync.ts`, `mapping.ts`, `traceability.ts`, `inherited-practice-data.ts`, `report.ts`.
repositories: `Practice`, `Policy`, `PolicyVersion`, `PolicyApproval`, `PolicyTemplate`, `Vendor`, `Assessment`, `Audit`, `Finding`, `Clause`, `Framework`, `Mapping`, `RequirementMapping`, `Traceability`, `Report`.
policies: `practice`, `vendor`, `framework`, `audit-readiness` (**sever, not delete** — see below).
services: `vendor-{enrichment,renewals,scoring,assessment-scoring-engine}`, `policy-lifecycle-adapter`, `mapping-{resolution,set-importer}`, `library-{importer,updater}`, `cross-framework-traceability`.
jobs: `automation-runner.ts`, `calendar-deadlines.ts`, `policyReviewReminder.ts`, `sharepoint-policy-jobs.ts`, `vendor-renewal-check.ts`.
other: `domain/requirement-mapping.types.ts`, `libraries/**` (7), `src/data/libraries/**`, `lib/pdf/policyLayout.ts`, `reports/pdf/policyDocument.ts`, `lib/security/external-assessment-access.ts`, `lib/dto/{practice,policy,vendor,framework,audit}.dto.ts`, `lib/hooks/use-{practices,policies}.ts`, `components/{InheritedMappingsPanel,InheritedEvidencePanel,TraceabilityPanel}.tsx`, `providers/sharepoint/docx.ts`.
routes: `assets/[id]/{traceability,practices,practices/[practiceId],mappings,evidence}/route.ts` (**not the directory** — `evidence/attached/**` stays), `src/app/api/webhooks/sharepoint/route.ts`, `src/app/api/reports/route.ts`, `src/app/api/t/[tenantSlug]/reports/route.ts` (**not the directory**), `issues/by-practice/[practiceId]/route.ts`, `src/app/org/[orgSlug]/(app)/practices/**`.

**SEVER, do not delete** — `usecases/audit-hardening.ts`: keep `verifyFileIntegrity` + `computeFileHash` (imported by the live `files/[fileName]/verify/route.ts`); move `assertCanVerifyIntegrity` out of `policies/audit-readiness.policies.ts` into `policies/common.ts` **preserving `['OWNER','ADMIN','AUDITOR']` verbatim** (widening it re-opens a cross-tenant hash oracle). Rename to `usecases/file-integrity.ts`, update the one route import, update `no-direct-prisma.test.ts:98` allowlist, and **write an executing test** — `verifyFileIntegrity` has none.

Delete in the same tranche: all ~90 pure-cluster test suites listed by the seven plans.

Verify: `npx tsc --noEmit && npx jest --listTests | wc -l && npx jest tests/guards tests/guardrails`

---

### T4 — KEEP-file **model / column / relation / enum-value** severs
*Position: these files never imported a KILL module, so they compiled through T3. They break only at the phase-3 migration — this is the tranche that must be complete before it.*

- **A5** task-link enum + entity-picker + 5 consumers + `openapi:generate` + `jest tests/contracts -u`.
- **A6** `task.ts` / tasks route / `issue.ts` / WorkItemRepository (`:111-198` counters, `:286`, `:313-322`, `:340`, `:364,398,417,432`, `:499-516`, `:549`).
- **A9** `AssetMaintenance.vendorId` ×4.
- **A10** `action-executor.ts:145,177,219` + `schemas/automation.schemas.ts:35`.
- **A19** `portfolio.ts` + `computeRag` + org portfolio route/export.
- **A20** `evidence.ts` download gate (own commit) + the 5 other practice sites + `bumpEntityCacheVersion` ×2 + `lib/cache/list-cache.ts:72`.
- Relation-key includes (§8d.1, invisible to a delegate grep): `AssetRepository.ts:50,76,119-125` · `EvidenceRepository.ts:21,80,142-143,188` · `evidence-retention.ts:104,125,249-284` · `retention-notifications.ts:23,35,41,76,120,212`.
- `auto-evidence.ts` (delete `attachAutoEvidenceFromLogEntry` + `AUTO_EVIDENCE_RULES`; **keep** `syncDerivedEvidenceTitle`/`setDerivedEvidenceWithdrawn`) + `journal.ts:17,357-360` + `field-operation.ts:11,477` (**keep the БАБХ snapshot block**).
- `deadline-monitor.ts` scanPractices/scanPolicies + `MonitoredEntityType` (`jobs/types.ts:65-77`) + its two exhaustive Records: `notifications/digest-templates.ts:46,58` and `domain/due-item-ownership.ts:39` (+ `due-item-ownership-guard.test.ts:96,194`).
- **A17** search/palette atomic commit.
- **A2/A1/A3** permissions + api-key-auth + api-keys page + evidence-import, one commit; + `permissions.test.ts`, `custom-role-permissions.test.ts:57-61`, `rbac-guardrails.test.ts:129-131`, `enterprise-identity-epic.test.ts:171-174`, `sync-conflict-deep.test.ts:153`, `sync-concurrency-failure.test.ts:75`, `sync-orchestrator.test.ts:72`.
- Soft-delete family, one commit, **by name not line**: `soft-delete.ts` (drop Practice/Policy/Vendor/Finding/Audit/AuditCycle/AuditPack) · `security/classification.ts` SOFT_DELETE_TARGETS + PII rows · `soft-delete-operations.ts:25-28` · `restore-validators.ts` (delete `TASK_VALIDATOR`+`AUDIT_PACK_VALIDATOR`, keep `EVIDENCE_VALIDATOR` verbatim; `Task → NOOP_VALIDATOR`) · `jobs/data-lifecycle.ts:44-51` · + `soft-delete.test.ts:102,142,211-221`, `soft-delete-guardrails.test.ts`, `soft-delete-operations.test.ts`, `restore-validators.test.ts`, `integration/soft-delete.test.ts:279-286`, `integration/data-lifecycle.test.ts:213`, `encryption.test.ts:301`, `audit-s10-tenant-isolation.test.ts:23-57`, `integration/rls-isolation.test.ts:26,27,63,64,250`.
- **A11** encrypted-fields + 6 re-pointed encryption suites + `sanitize-rich-text-coverage.test.ts:63,81-89`.
- **A18** modules + entitlements + `admin/modules/route.ts:10` + `modules.test.ts:80-93`.
- `lib/schemas/index.ts` (all GRC blocks + enums, one edit) · `swr-keys.ts` (9 entries) · **`queryKeys.ts`** (7 groups) · `page-segregation.ts` + `canonical-parents.ts` + **`BackAffordance.tsx:36-65`** · `use-palette-commands.ts:105-111` + `palette-commands.test.tsx:123,189` · `observability/list-page-metrics.ts:93-102` · `calendar.schemas.ts` + `status-tone.ts` + 5 calendar consumers (exhaustive Record — atomic) · `prisma-local-store.ts` (sever) · `integrations.ts` (`runAutomationForPractice`, `listExecutionsForPractice`) · `webhook-processor.ts:309-355` · `providers/sharepoint/health.ts` policyLinks + its page tile + test · `onboarding-automation.ts:169` + `onboarding-automation.test.ts:184-196` (local mirror asserts 5 → 4) · `OnboardingWizard.tsx` FRAMEWORK_SELECTION + `onboarding.ts:287-296` · `celebrations.ts:50,76-79` + 3 rendered suites · `staging/seed/route.ts:79-80` · **A13** `NewTenantForm.tsx` · `route-permissions.ts:200-205` (**rewrite the note, keep the rule** — verified `/schemes` GET calls only `listSupportSchemes`) · `errors/route-exemptions.ts:268-274` · `api-permission-coverage.test.ts:126-135` (+ add a stale-entry test) · `no-direct-prisma.test.ts` allowlist · `usecase-test-coverage.test.ts` (**BASELINE = 3**) · `query-shape-guardrails.test.ts` (delete stale `KNOWN_N_PLUS_ONE`; **re-floor `UNBOUNDED_FINDMANY_BUDGET`** — measured live count is exactly 40, slack 5, this teardown removes ~23; measure after, do not guess) · `oi-3-observability.test.ts:146` · `contract-drift.test.ts` + `no-unsafe-any.test.ts` (**A15**) · `openapi-foundation.test.ts` · `repositories-tenant-scoping.test.ts` · `executive-dashboard.test.ts` · `entity-status-mapping.test.ts:19-23,116-125,129-146,160-162` · `json-column-validation.test.ts` · `retention-hardening.test.ts` · `form-schemas.test.ts` · `digest-enum-schema-alignment.test.ts` · `integration/filters.test.ts` · `integration/filter-contract.test.ts` · `integration/tenant-isolation-usecases.test.ts:53` (**throws**, not skips) · `integration/auth-gating.test.ts` · `tests/helpers/factories.ts:236-239`.

Verify: `npx tsc --noEmit && npx jest && npm run openapi:generate && npx jest tests/contracts`

---

### T5 — i18n + E2E + docs
*Position: last, because key-parity and spec re-pointing depend on the final surviving surface.*

- Purge the GRC namespaces from **both** `messages/en.json` and `messages/bg.json` (`policies` 41 keys — the "144" in the policy plan is wrong; `vendors`, `vendorAssessment`, `frameworkExplorer`, `mapping`, `inherited`, `auditShare`, the `backNav` GRC half, `navVendors`/`navFrameworks`/`navEvents`/`entPractices`/`entPolicies`/`entFrameworks`/`entRisks`/`entTests`, `commandPalette.placeholder*` prose). **A12** `list-page-descriptions.test.ts` in the same commit. Bulgarian must be real translation.
- **Edit, never delete** the shared specs: `a11y`, `responsive`, `core-flow`, `data-table-platform`, `entity-detail-layout`, `epic54-crud-smoke`, `search-affordances`, `filters`, `mobile/horizontal-drift`, `auth` (re-point `/clauses` → `/assets`), `tooltip-and-copy` (re-point the CopyButton assertion), `module-gate-exchange`, `fixtures.ts` docblock.
- Delete GRC-only specs: `practices*`(7), `policies`, `vendors`, `audit-readiness`, `reporting` (verified: 160 lines, ONE `test()`, the pack flow end-to-end — no surviving half).
- **Re-point, do not delete:** `tests/unit/practice-detail-shell-adoption.test.ts` → `assets/[id]/page.tsx` (the repo's **only** `EntityDetailLayout` adoption ratchet; CLAUDE.md names it by path) and update CLAUDE.md.
- Docs in the same PR (CLAUDE.md contract rule): CLAUDE.md billing section ("only `practice` creation is gated" → `location`/`user`/`exchange_listing`), `docs/billing.md`, `docs/domain-import-export.md` (delete — documents the removed closure), plan §3 (see below), `docs/implementation-notes/2026-08-13-grc-teardown-phase2.md`.
- `tests/guards/coverage-ratchet.test.ts`: re-floor `usecases/` **after** measuring; delete the Stage-3b paragraph citing `audit-readiness/packs`.

Verify: `node scripts/i18n-diff.mjs --check && npx jest && npm run lint && npx playwright test --shard=1/2`

---

## E. Phase-3 handoff (do NOT do in phase 2)

**Amend plan §3 before writing the migration.** Verified: there are **four** KEEP→KILL `@relation` FKs, not one — `AssetMaintenance.vendorId` (`assets.prisma:129,142,149`), `IntegrationExecution.practiceId` (`automation.prisma:155,167,172`), `Evidence.practiceId` (`files.prisma:55,101,123` **and `@@unique([tenantId, sourceLogEntryId, practiceId])` at :147**), `Task.practiceId` (`work.prisma:32,54,81,84`). Plus `ProcessEdgePractice.practiceId` (`automation.prisma:554,564`, bare), `Tenant.frameworkRequirementOrders` (`auth.prisma:125`), `Evidence.vendorAnswers`/`findingLinks` (`files.prisma:100,108`), `Asset.practices`, and ~60 back-relations on Tenant/User. Each `DROP COLUMN` needs a `.down.sql` (`tests/guards/destructive-migration-has-inverse.test.ts` derives the set by scanning SQL).

Also phase 3: `MODULE_LABELS`/`MODULE_MIN_PLAN` VENDORS rows · Prisma enum members (`TaskLinkEntityType.FRAMEWORK_REQUIREMENT/PRACTICE/POLICY/VENDOR/AUDIT_PACK`, `DigestCategory.VENDOR_RENEWAL_DIGEST`, `ModuleKey.VENDORS`, the `EmailNotificationType`/`NotificationType` GRC members) · `tests/e2e/global-teardown.ts` (11 names) · `schema-index-coverage.test.ts` FK/list exemptions · `prisma-schema-folder-coverage.test.ts:45` · `prisma/seed.ts` clause + audit-pack + framework blocks (**this is what breaks `db:reset`, the phase-3 acceptance criterion**) · re-run the §8g `count(*)`.