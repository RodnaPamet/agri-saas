# 2026-08-12 — GRC teardown, phase 1: the seam

**Phase 1 of 3. This phase DELETES NOTHING.** It carves a seam so the agri
product no longer depends on compliance-owned files, and produces the KILL /
KEEP lists that phases 2 and 3 execute against. Those lists are authoritative:
phase 2 deletes the product surface, phase 3 drops the tables.

---

## 0. The brief's numbers were stale. Measure before you act.

A prior teardown already happened — `c1877358` "delete the control exoskeleton"
removed 1,132 lines from `compliance.prisma`, and `5c1238e8` renamed
`Control → Practice` and `/controls → /practices`.

| | brief | first correction | **measured** |
|---|---|---|---|
| models, total | 190 | 159 | **157** |
| `compliance.prisma` | 71 | 37 | **36** |
| `vendor` / `audit` / `processes` | 14 / 11 / 5 | — | **14 / 11 / 5** ✓ |
| GRC subtotal | 101 | 67 | **66** |
| enums | 123 | — | **121** |

Both wrong intermediate counts came from `grep -cE '^\s*model\s'`, which also
matches two indented **fields** named `model` (`compliance.prisma:212` on
`Asset`, `ai.prisma:37`). **Use `grep -c '^model '`.**

Consequences for the later phases: phase 2's delete list names `/controls`,
which no longer exists under that name, and `/events`, which does not exist at
all. Phase 3's "190 → ?" baseline is 157.

---

## 1. Contradictions in the brief — resolved by decision

### 1a. Load-bearing piece #2 was false. Framework is now KILL.

The brief keeps `Framework` because "`/schemes` models ag certification schemes
as Framework rows with `kind='AG_SCHEME'`". That is no longer true.
`schemes/page.tsx` calls `listSupportSchemes`, which queries `db.supportScheme`,
and its own docblock says the certification catalog "was removed with the
compliance uproot and `/schemes` now belongs to support measures".

`Framework`'s only non-GRC consumer was `auto-evidence.ts`
(`LogEntry → FrameworkRequirement → PracticeRequirementLink → Practice →
Evidence`), imported by `journal.ts:17` and `field-operation.ts:11`. That chain
is **inert**: all three writers of `PracticeRequirementLink` are broken (§4), so
it mints nothing for any tenant without legacy rows.

**DECIDED: drop the cluster** — `Framework`, `FrameworkRequirement`,
`FrameworkRequirementOrder`, `FrameworkPack`, `FrameworkMapping`,
`RequirementMappingSet`, `RequirementMapping`, `Practice` and its links, plus
`usecases/framework/catalog.ts`. Phase 2 severs `attachAutoEvidenceFromLogEntry`
from `journal.ts` and `field-operation.ts`; `Task.practiceId` becomes a dropped
column in phase 3.

### 1b. There is a FIFTH load-bearing piece, and the brief omits it.

**`compliance-calendar.ts`.** It has 8 agri loaders against 7 GRC ones and owns
`/calendar`, the calendar API, **and the global sidebar badge**:
`SidebarNav.tsx:95 → use-calendar-badge.ts:55 → GET /calendar/upcoming-count →
getUpcomingDeadlineCount`, which counts `task`, `practice`, `evidence`, `policy`
and `vendor`. That badge renders on **every authenticated page**. Phase 2 must
split this file into an agri calendar and rename it — never delete it.

### 1c. Two farm-dashboard milestones read GRC models through Prisma delegates.

`achievements.ts` (imported only by `ag-dashboard.ts:7`) computes
`inspection-passed` from `db.auditPack.findFirst({status:'FROZEN'})` and
`sop-100-ack` from `db.policy` + `db.policyAcknowledgement`. **No import-graph
scan can see this** — `achievements.ts` imports no GRC module.

**DECIDED: drop those two milestones.** Four genuinely agri ones remain:
`first-field-mapped`, `spray-job-complete`, `first-harvest`, `season-closed`.

### 1d. `processes.prisma` is the automation rule builder, not a GRC surface.

`ProcessMap` / `ProcessMapSnapshot` / `ProcessNode` / `ProcessEdge` /
`ProcessEdgePractice` are storage for the Epic 60 automation rule builder
(`services/canvas-rule-sync.ts` and five `src/components/processes/*` files).

**DECIDED: keep the models, relocate them, delete only the `/processes` page
chrome.** Done in this phase — they now live in `automation.prisma`.

### 1e. Task #1.6's premise is already resolved.

`ag-dashboard.ts` does **not** import `./framework/coverage`. It imports
`journal`, `inventory`, `farm-task`, `achievements`, `modules`, and hardcodes
`certification: null` with the comment "Certification readiness is NOT computed
here." Nothing to decide.

### 1f. `/trends` is the market-price surface. Never delete it.

`trends/page.tsx` renders `TrendsPageClient` fed by `/trends/prices` — the
surface six merged PRs built this month. `ComplianceSnapshot` is served by a
*different* route, `/dashboard/trends`. `/events` does not exist.

---

## 2. Model-level KILL / KEEP

### KEEP — moved out of the GRC files in this phase (16 models)

| model | new home | agri consumer |
|---|---|---|
| `Task` | `work.prisma` | `farm-task.ts`, `field-operation.ts`, `crop-planning.ts`, `farm-record-diary.ts` — a `FARM_TASK` row IS a farm task |
| `TaskKeySequence` | `work.prisma` | `WorkItemRepository` — race-free `TSK-N` minting |
| `TaskLink` | `work.prisma` | farm task ↔ Location/Parcel/Equipment; the ДНЕВНИК PDF resolves its parcel through it |
| `TaskComment` | `work.prisma` | `FarmTaskDetailClient.tsx:441` posts to `/tasks/{id}/comments` |
| `TaskWatcher` | `work.prisma` | `WorkItemRepository` watcher fan-out |
| `Asset` | `assets.prisma` | `/assets` machine register; `Equipment` was merged into it; journal equipment picker, `machinery-depreciation.ts` |
| `AssetMaintenance` | `assets.prisma` | asset service history (`MaintenanceTab.tsx`) |
| `AssetKeySequence` | `assets.prisma` | asset key minting |
| `FileRecord` | `files.prisma` | БАБХ ДНЕВНИК register — `farm-record-register.ts`, `jobs/farm-record-pdf.ts` |
| `Evidence` | `files.prisma` | the "Docs" nav surface at `/evidence` |
| `EvidenceReview` | `files.prisma` | evidence review trail |
| `ProcessMap`, `ProcessMapSnapshot`, `ProcessNode`, `ProcessEdge`, `ProcessEdgePractice` | `automation.prisma` | automation rule builder (Epic 60) — `canvas-rule-sync.ts` |

### KEEP — staying where they are (2 models)

`AuditLog` and `OrgAuditLog` live in `audit.prisma` but are **platform
infrastructure, not GRC**: the hash-chained tenant audit trail and its org-scoped
twin. `audit-writer.ts` / `org-audit-writer.ts` reach them with
`$executeRawUnsafe` against literal table names, and `org-audit-writer.ts` casts
`$5::"OrgAuditAction"` — so the **Postgres enum type** must survive too, not just
the Prisma enum. A file-level `rm audit.prisma` destroys the audit trail.

### KILL (48 models)

**`compliance.prisma`, 25 remaining:** `Clause`, `ClauseProgress`,
`PracticeKeySequence`, `Practice`, `PracticeAsset`, `PracticeTask`,
`PracticeEvidenceLink`, `PracticeRequirementLink`, `Policy`, `PolicyVersion`,
`PolicyApproval`, `PolicyAcknowledgement`, `PolicyPracticeLink`,
`PolicyTemplate`, `Finding`, `FindingEvidence`, `Framework`,
`FrameworkRequirement`, `FrameworkRequirementOrder`, `FrameworkPack`,
`FrameworkMapping`, `RequirementMappingSet`, `RequirementMapping`,
`ComplianceSnapshot`, `TreatmentMilestone`.

**`vendor.prisma`, all 14:** `Vendor`, `VendorContact`, `VendorDocument`,
`QuestionnaireTemplate`, `QuestionnaireQuestion`, `VendorAssessmentTemplate`,
`VendorAssessmentTemplateSection`, `VendorAssessmentTemplateQuestion`,
`VendorAssessment`, `VendorAssessmentAnswer`, `VendorLink`,
`VendorEvidenceBundle`, `VendorEvidenceBundleItem`, `VendorRelationship`.
The file empties out and is deleted in phase 3.

**`audit.prisma`, 9 of 11:** `Audit`, `AuditChecklistItem`, `AuditCycle`,
`AuditPack`, `AuditPackItem`, `AuditPackShare`, `AuditorAccount`,
`AuditorPackAccess`, `ReadinessSnapshot`. The file SURVIVES for the two platform
models above.

---

## 3. FK edges from KEEP models into KILL models

All 344 `@relation` edges across all 157 models were extracted and their scalar
nullability resolved. The result is smaller than the brief anticipated:

> **Exactly ONE** foreign key crosses the KEEP→KILL boundary, and it is nullable:
> `AssetMaintenance.vendor → Vendor` via `vendorId` (`assets.prisma`, nullable).
>
> **Zero** NOT-NULL FKs cross the boundary — so the brief's rule ("a nullable FK
> to a dropped model becomes a dropped column") covers every case, and no
> surviving model needs a schema change beyond dropping columns.
>
> **Zero** models outside the four GRC files hold any FK to a KILL model.
> `auth`, `automation`, `agriculture`, `grain`, `planning` need no FK surgery.

Plus two bare-string references with no `@relation`, which are column drops:
`Task.practiceId` and `ProcessEdgePractice.practiceId`.

`AssetMaintenance.vendorId` is written and read end-to-end but has **no UI** —
`MaintenanceTab.tsx` renders no vendor column and its create form has no vendor
picker. Phase 3 drops the column; re-adding it as free-text `vendorName String?`
is optional and out of scope.

### RLS, triggers and constraints

No RLS policy, trigger or CHECK constraint on a KEEP table references a KILL
table. All seven chained (subquery) RLS policies are KILL-on-KILL except
`EvidenceReview → Evidence`, which is KEEP-on-KEEP. The two behavioural triggers
(`audit_log_immutable`, `tenant_membership_last_owner_guard`) touch no GRC table.

*Correction to an earlier finding:* `ProcessEdgePractice` was flagged as having
no RLS. **False alarm** — it has 5 policy statements, created under its
pre-rename `ProcessEdgeControl` name in
`20260519120000_r26_pra_process_maps` and carried through the rename migration.

---

## 4. Four seeders are already broken, independently of this work

All four are invisible to `tsc` (`tsconfig.json` excludes `scripts/` and
`prisma/seed.ts`), which is why they rotted unnoticed:

| file | fault | symptom |
|---|---|---|
| `prisma/seed.ts:606` | reads `ctrl.annexId` on a `Practice` row; `Practice` has no `annexId` (renamed to `code`) | silent no-op — every row `continue`s, zero links seeded |
| `scripts/seed-demo.ts:379` | `include: { templateLinks }` on `FrameworkPack`, which has no such relation; the whole `PracticeTemplate*` subsystem is gone | hard `PrismaClientValidationError` |
| `scripts/seed-staging.ts:124` | omits the required `tenantId` | hard `PrismaClientValidationError` |
| `prisma/seed-catalog.ts` | references the deleted practice-template subsystem | broken |

**DECIDED: repair in this phase**, before anything is deleted, so that any
phase-3 seeding breakage is attributable to the teardown rather than to
pre-existing rot. `npm run db:reset` is a phase-3 acceptance criterion and cannot
be trusted until these are sound.

What that meant in practice, since only two of the four are actually repairable:

| file | in the `db:reset` path? | action taken |
|---|---|---|
| `prisma/seed.ts` | **YES** — `db:reset` runs `prisma migrate reset && tsx prisma/seed.ts` and nothing else | **FIXED**: `ctrl.annexId` → `ctrl.code`. The links now seed. |
| `scripts/seed-staging.ts` | no | **FIXED**: added the required `tenantId`. |
| `scripts/seed-demo.ts` | no | **NOT repairable.** `installSchemePackForDemo` reads `FrameworkPack.templateLinks` and the whole `PracticeTemplate` / `PracticeTemplateTask` / `PracticeTemplateRequirementLink` subsystem — **none of those models exist in any schema file**; a prior uproot deleted them. There is no version of this function that works. It is removed in phase 2 along with the rest of the Framework/Practice cluster. Its caller is already inside a `try/catch` that warns and continues, so it degrades rather than crashing the demo seed. |
| `prisma/seed-catalog.ts` | no | **NOT repairable**, same cause — it seeds the practice-template catalog wholesale. Removed in phase 2. |

Phase 1 deletes nothing, so the two unrepairable files are documented here and
left in place rather than removed early.

---

## 5. Edges to sever in phase 2

Import edges are **not** what blocks this teardown — most agri→GRC imports are
severable. The dangerous couplings are the ones no import scan sees:

1. **`achievements.ts`** — three KILL models via Prisma delegates, on the farm
   dashboard. §1c.
2. **`compliance-calendar.ts`** — the global sidebar badge. §1b.
3. **`search.ts:91`** — `db.policy.findMany`, reached by the ⌘K palette.
4. **The agri farm-task page is served by GRC API routes.** 11 verified fetches
   in `FarmTaskDetailClient.tsx`: `/tasks/{id}`, `/status`, `/assign`, `/links`,
   `/links/{linkId}`, `/comments`, `/evidence`, `/evidence/{id}`,
   `/evidence/uploads`, `/field-operations/{id}/review`.
   **Phase 2 must exempt all of `/api/t/:slug/tasks/**` and `/evidence/uploads`
   from the route deletion.**
5. **Six cross-imports out of page directories — each a build break.** Values,
   not just types:

```
farm-tasks/[taskId]/FarmTaskDetailClient.tsx:41  → practices/[practiceId]/_tabs/EvidenceSubTable
components/AttachedEvidencePanel.tsx:29          → practices/[practiceId]/_tabs/EvidenceSubTable
components/processes/ManualTriggerPanel.tsx:18   → processes/RulesTab
components/processes/RuleDetailSheet.tsx:26,27   → processes/RulesTab, processes/automation-filter-defs
components/processes/RuleBuilderModal.tsx:37     → processes/RulesTab
components/processes/PersistedProcessCanvas.tsx:136 → processes/ProcessesClient
components/processes/CanvasDocumentBar.tsx:40       → processes/ProcessesClient
```

`EvidenceSubTable` and `RULE_ACTION_LABELS` / `RulesTab` types must be relocated
out of the page directories **before** those pages are deleted.

6. `AuditsClient.tsx:152` links to `/t/{slug}/frameworks`, **a page that does not
   exist** — a dead link today, and it goes with the audits surface.

---

## 6. What this phase changed

```
prisma/schema/work.prisma      NEW  Task, TaskKeySequence, TaskLink, TaskComment, TaskWatcher
prisma/schema/files.prisma     NEW  FileRecord, Evidence, EvidenceReview
prisma/schema/assets.prisma    NEW  Asset, AssetMaintenance, AssetKeySequence
prisma/schema/automation.prisma  +5 ProcessMap, ProcessMapSnapshot, ProcessNode,
                                    ProcessEdge, ProcessEdgePractice
prisma/schema/compliance.prisma  36 → 25 models
prisma/schema/processes.prisma    5 → 0 models (file left in place; phase 3 removes it)
```

Generator and datasource remain in `base.prisma` alone.

### Proof that this is a pure move

Every `model` and `enum` block in the schema folder was extracted before and
after, normalised (whitespace collapsed, doc comments stripped) and compared as a
multiset:

```
old blocks: 278   new blocks: 278
only in OLD: none
only in NEW: none
CHANGED:     none
```

278 = 157 models + 121 enums. **No field, index, attribute or relation changed**,
so the generated client is equivalent and **no migration is needed**.
`npx prisma validate` passes and `npm run db:generate` succeeds (v7.9.0).

*Method note:* `prisma migrate diff` was attempted as an independent check and
rejected folder datamodels in this CLI version, so it is not part of the
evidence. The block comparison above is what was actually run.

`tenantId` indexes and RLS policies are untouched — RLS lives in migrations
keyed on table names, and no table was renamed.

---

## 7. Phase 2 and 3 preconditions

Before phase 2 deletes anything:

- [ ] Relocate `EvidenceSubTable` and the `processes/RulesTab` exports out of the
      page directories (§5.5).
- [ ] Split `compliance-calendar.ts`, keeping `getUpcomingDeadlineCount` (§1b).
- [ ] Trim `achievements.ts` to its four agri milestones (§1c).
- [ ] Exempt `/api/t/:slug/tasks/**` and `/evidence/uploads` (§5.4).
- [ ] Never touch `/trends`, `/news`, `/assets`, `/calendar`, `/evidence`,
      `/schemes` (§1f).

Before phase 3 drops anything:

- [ ] Confirm the FK inventory in §3 still holds (one nullable edge).
- [ ] `AuditLog`, `OrgAuditLog` and the `OrgAuditAction` Postgres enum survive.
- [ ] The migration is destructive and irreversible against production data; it
      carries a pre-flight row-count query and is not applied to the production
      VM without an operator's explicit go-ahead.

---

## 8. AMENDMENT (phase 2 recon) — this plan was wrong about two surfaces

Before deleting anything, a ten-surface reference sweep ran across four
modalities (imports, Prisma delegates, fetch/URL strings, registries) plus a
completeness critic. It found **713 references from code that survives the
teardown** — not the five couplings §5 lists — and two outright errors in the
KILL list above. The corrections are load-bearing, so they live here rather
than in a phase-2 note nobody reads first.

### 8a. `/issues` is NOT a GRC surface. It stays.

**There is no `Issue` model.** `usecases/issue.ts` opens with
`@deprecated — Legacy Issue usecase; delegates to Task repositories`, and the
only three delegates it touches are `db.task`, `db.taskLink` and `db.auditLog`
— all three explicit KEEP. `/issues` is a compatibility view over
`TaskType.ISSUE`, i.e. over the farm task system.

Deleting it would remove a working feature built on agri models and delete
nothing GRC. Retiring a deprecated shim may be worth doing; it is **not** part
of this teardown, and it does not belong in a PR whose stated job is removing
inherited schema surface.

### 8b. `/access-reviews` is a platform security feature. It stays.

`AccessReview` (`auth.prisma:539`) and `AccessReviewDecision` (`:597`) live in
**auth.prisma**, which is not a GRC file and is named nowhere in §2's KILL
list. This is periodic user-access review — the same family as sessions, SSO
and SCIM.

Both errors have the same root cause: **§2's surface list was assembled from
directory names, not from the KILL model list.** A directory called
`access-reviews` reads like GRC; the models under it do not.

### 8c. `/mapping` is KILL and was missed entirely.

`RequirementMappingSet`, `RequirementMapping` and `FrameworkMapping` are all on
the §2 KILL list, but no surface covered them. It is not small:
`usecases/mapping.ts`, `RequirementMappingRepository` (13 delegates),
`MappingRepository`, `services/mapping-resolution.ts`,
`services/mapping-set-importer.ts`, `domain/requirement-mapping.types.ts`,
`components/InheritedMappingsPanel.tsx`, `data/libraries/mappings/`.

**`src/app/api/mapping/route.ts` sits OUTSIDE the tenant tree**, so deleting
`src/app/api/t/[tenantSlug]/mapping/` leaves a live route behind.

### 8d. Four reference classes the four modalities structurally cannot see

1. **Relation traversal on a KEEP delegate.** `db.task.findFirst({ include: {
   practice: … } })` spells `Practice` nowhere. Hits sit in
   `WorkItemRepository.ts:340` (the FARM TASK repository), `AssetRepository`
   (`/assets` is never-touch), `EvidenceRepository` (the surviving Docs
   surface) and `ProcessMapRepository` (the rule builder that KEEPS).
2. **Model names that become SQL.** `lib/soft-delete.ts`'s entries are not
   registry keys — `retention-purge.ts:41-49` interpolates them into
   `DELETE FROM "${model}"` in **one loop with no per-model try/catch**. A
   single stale entry after phase 3 throws `relation "Policy" does not exist`
   and takes the nightly purge down for `Asset`, `Evidence`, `FileRecord`,
   `Task` and `Contract` too. Same shape in `soft-delete-operations.ts`,
   `soft-delete-lifecycle.ts`, `jobs/data-lifecycle.ts`.
3. **The test tiers below guards.** Every test hit in the 713 is from
   `tests/guards` / `tests/guardrails`. **45 files** under `tests/unit`,
   `tests/integration`, `tests/rendered` import a doomed module, and **24 e2e
   specs** navigate a doomed surface — including shared ones that must be
   EDITED, not deleted: `fixtures.ts`, `auth.spec.ts`, `a11y.spec.ts`,
   `responsive.spec.ts`, `core-flow.spec.ts`, `data-table-platform.spec.ts`.
4. **DB-resident references no code scan reaches.** `ApiKey.scopes` rows hold
   `vendors:*` / `audits:*` strings that `api-key-auth.ts:82` only ever builds
   at runtime (`` `${resource}:${action}` ``); `TenantCustomRole.permissionsJson`
   holds `policies.approve` reconstructed at `permissions.ts:431`;
   `AutomationRule.event` holds `POLICY_REVIEW_DUE`; `TenantModule.moduleKey`
   holds `VENDORS`. **Deleting the enum members orphans live rows**, and every
   issued API key carrying a dead scope starts failing `assertScope` silently.
   These need a pre-flight row count and a data migration, not a grep.

### 8e. Files that break and appear in no reference list

`usecases/journal.ts` + `usecases/field-operation.ts` (both import
`auto-evidence.ts`, which reads three KILL models);
`WorkItemRepository.ts:509` (`db.practice.findMany`, plus `Task.practiceId` at
seven more sites); `usecases/portfolio.ts:479/812`, reached by two surviving
org routes; `usecases/farm-record-traceability.ts` — **the trap**: the filename
says *farm-record*, so a name-driven sweep keeps it, and every model it touches
is KILL; and all of `src/lib/framework-tree/`, whose consumers are platform
primitives under `src/components/ui/` carrying no GRC noun in their path.

### 8f. AMENDMENT (phase 2 execution) — `ComplianceSnapshot` comes OFF the KILL list

§2 lists `ComplianceSnapshot` under `compliance.prisma`'s KILL set. That is
wrong, and the way it is wrong is the same shape as §8a/§8b: the model was
classified by the FILE it lives in and the noun in its name, not by what reads
it.

It is a daily metrics rollup, and its columns are split down the middle:

| section | verdict |
|---|---|
| `practices*`, `policies*`, `vendors*`, `findingsOpen` | GRC — go |
| `evidence*`, `tasks*`, `assets*` | agri — stay |

Two SURVIVING surfaces read it, and one of them is explicitly never-touch:

1. **The `/assets` KPI sparklines.** `AssetsClient` fetches
   `/api/t/:slug/dashboard/trends` → `compliance-trends.ts` →
   `db.complianceSnapshot`, and renders a 30-day history strip across four
   asset KPI cards. `/assets` is on the never-touch list in §1f.
2. **The org portfolio roll-up.** `PortfolioRepository` reads it for the
   cross-tenant 14-day view behind the surviving `/org/:slug` pages.

There is also a data argument that has nothing to do with code: the table has
been accumulating one row per tenant per day in production. A phase-3 `DROP
TABLE` destroys that history irreversibly, and no snapshot restore brings it
back selectively.

**DECIDED (operator, 2026-08-13): keep a trimmed snapshot.**

- **Phase 2** — move the model OUT of `compliance.prisma` into a surviving
  schema file. This is a pure file move: `prismaSchemaFolder` concatenates the
  folder, so relocating a model between files produces NO migration. Then trim
  `jobs/snapshot.ts` to compute only the surviving columns, trim
  `compliance-trends.ts` and `PortfolioRepository` to the surviving aggregates,
  and keep `/dashboard/trends` + the sparklines working.
  `jobs/compliance-digest.ts` is a GRC digest and goes.
- **Phase 3** — drop the GRC COLUMNS in the main destructive migration, with a
  `.down.sql` inverse (`tests/guards/destructive-migration-has-inverse.test.ts`
  DERIVES the destructive set by scanning for `DROP COLUMN`, so the inverse is
  not optional). Deferring the drop to phase 3 avoids standing up a second
  destructive migration — and its rollback script — in the middle of the
  teardown.

The model KEEPS its name for now. Renaming it off the `Compliance` prefix means
a `RENAME TO` migration plus its own inverse; if that is wanted it should ride
the phase-3 migration rather than land on its own.

**The general lesson, third time it has bitten:** a model's file and a model's
name are both evidence about its owner, and both are weaker than the list of
things that read it.

### 8g. PRE-FLIGHT (2026-08-13) — every KILL table on production is EMPTY

Run against the `agrent` VM's database (read-only; `inflect_production` is the
agri product's DB under its pre-rebrand name, confirmed by the presence of
`Parcel` / `LogEntry` / `Season` / `SupportScheme` / `AgroSignal`):

```
TOTAL GRC ROWS: 0        -- exact count(*), all 36 KILL tables
tenants: 1   users: 5
```

`ComplianceSnapshot` is the ONLY table in the GRC schema files carrying real
data (45 rows) — and it is precisely the one §8f took off the KILL list. That
is a nice independent confirmation of that decision rather than a coincidence.

**The §8d.4 DB-resident-reference risk is empirically zero here too.** Every
table that could hold an orphaned enum value has no rows at all:

| table | rows | rows holding a GRC value |
|---|---|---|
| `TenantApiKey` (`scopes`) | 0 | 0 |
| `TenantCustomRole` (`permissionsJson`) | 0 | 0 |
| `AutomationRule` (`triggerEvent`) | 0 | 0 |
| `TenantModuleSettings` (`enabledModules`) | 0 | 0 |
| `OrgDashboardWidget` (`chartType`) | 0 | 0 |

Note the real column names differ from §8d.4's prose: it is `TenantApiKey`
not `ApiKey`, `TenantModuleSettings.enabledModules` not
`TenantModule.moduleKey`, and `AutomationRule.triggerEvent` not `.event`. A
data migration written from that prose would have failed on three of five
table names.

**What this changes:**

- The phase-3 destructive migration destroys NO production data. The
  "irreversible against production data" warning in §7 still stands as a
  procedure, but the blast radius on this stack is currently nil.
- No data migration is needed for the orphaned-enum class on `agrent`.
- The `.down.sql` inverses are still REQUIRED — the guard derives them from
  the migration SQL, and other environments (dev, staging, a future
  customer stack) are not covered by this count.

**What this does NOT license:** re-running the count is part of the phase-3
procedure, not a one-off. These numbers are true as of 2026-08-13 with one
tenant on the stack; a tenant onboarded between now and the migration changes
them. Count again immediately before applying.

### 8h. OPERATOR DECISIONS (2026-08-13) — the two the work order escalated

**A6 — `AUDIT_FINDING`, `PRACTICE_GAP` and `INCIDENT` are REMOVED from the
task-type picker.** All three depended on `validateTypeRelevance`, which
required a task to carry `practiceId` or a `PRACTICE` / `FRAMEWORK_REQUIREMENT`
link. Phase 2 removes both link options and phase 3 drops the column, so the
three types become uncreatable rather than merely unused. Removing them from
`TaskType`'s UI is the honest reading; leaving them in the picker would offer a
farmer three options that throw. The Prisma enum members themselves go in
phase 3 with the rest.

**A20 — the evidence download gate is RE-BASED, not widened.** Today
`downloadEvidenceFile` lets READER / AUDITOR download only when
`evidence.practiceId` is non-null. Deleting that condition would widen
privilege to every file in the tenant; keeping it throws at phase 3. The gate
is re-based on the surviving provenance columns — `assetId ?? taskId ??
sourceLogEntryId` non-null — which preserves the existing posture: a
read-only role can fetch evidence that is attached to a known farm record,
and cannot fetch a free-floating upload. This is a security-relevant change
and ships in its own commit with an executing test, which the gate has never
had.

### 8i. THE DELETION CRITERION WAS WRONG (learned in T3, 2026-08-13)

T3 deleted the KILL closure using this rule: **delete a source file, then fix
whatever `npx tsc --noEmit` flags.** The tree went typecheck-clean and the
five structural tiers (`guards`, `guardrails`, `regression`, `contracts`,
`pdf`) reported 578/578 green.

CI then failed **47 test files**.

The rule is wrong because TypeScript only sees `import`-shaped references.
This repo's structural tests — hundreds of them — reference source by STRING
PATH:

```ts
readFileSync('src/app/t/[tenantSlug]/(app)/practices/PracticesClient.tsx')
```

That compiles perfectly against a deleted file and fails at runtime. 43 of the
47 were exactly this shape. The CLAUDE.md warning that "guards assert on
source TEXT and contribute no runtime coverage" has a corollary nobody had
written down: **the same property makes them invisible to the compiler**, so
`tsc` clean is not evidence that a deletion is complete.

**The corrected criterion, for T4 / T5 / phase 3:**

1. Delete the source file.
2. `npx tsc --noEmit` — catches the import-graph half.
3. **`grep -rn '<deleted-path>' tests/`** — catches the string-path half.
   Do this for EVERY deleted path, including directories, before committing.
4. Run the FULL `npx jest`, not a tier subset.

A second lesson rides along: the verification tier itself was the problem.
`tests/guards` + `tests/guardrails` + `regression` + `contracts` + `pdf` is
**93 of 1,180 suites — under 8%**. It was chosen because it is fast (~9
minutes) and it is where teardown breakage was expected to land. It is a fine
smoke test and a terrible completion check. The full suite is ~30 minutes;
run it in the background and read it before claiming a tranche is done.

### 8j. A20 PRE-FLIGHT (2026-08-13) — and a correction to the reasoning behind it

§8h decided the evidence download gate is RE-BASED, not widened: READER /
AUDITOR may download when `assetId ?? taskId ?? sourceLogEntryId` is non-null,
instead of when `practiceId` is non-null.

The T4 map justified that as costless with this claim:

> "The only rows whose READER access CHANGES are practice-linked-but-otherwise-
> unattached rows, which cannot exist after phase 2 anyway."

**That reasoning is wrong, and it is worth keeping the correction visible.**
Phase 2 deleted the code that CREATES such rows; it did not delete the rows.
`Evidence.practiceId` is not dropped until phase 3, so any file a tenant had
filed through the old evidence practice picker is still sitting there with
`practiceId` set and no other provenance. Today a READER can download it;
after the re-base they get a 403. Code deletion is not data deletion — the
same conflation §8g had to correct once already.

Measured rather than argued (`agrent`, read-only):

```
evidence_total          0
with_practiceId         0
AT_RISK_practice_only   0     -- practiceId set, no asset/task/logEntry
reachable_after_rebase  0
readers_or_auditors     0
```

So the at-risk set is empty — but note WHY. It is empty because this tenant
holds no Evidence rows at all and has no READER/AUDITOR members, NOT because
the row shape is impossible. On a stack with real evidence history the
re-base would revoke access, and the count is the only thing that can tell
you. **Re-run this predicate before applying A20 to any other environment**,
and record the result in the PR body rather than asserting the set is empty.

Auto-evidence rows were never at risk either way: `auto-evidence.ts:168-170`
writes `sourceLogEntryId` alongside `practiceId`, so they satisfy the
re-based gate. That is probably what produced the original false confidence.

### §8k — an entire event family was already orphaned, and nothing said so

T4 turned up nine automation events — `TEST_PLAN_CREATED/UPDATED/PAUSED/
RESUMED`, `TEST_RUN_CREATED/COMPLETED/FAILED`, `TEST_EVIDENCE_LINKED/
UNLINKED` — whose subject models, `PracticeTestPlan` and `PracticeTestRun`,
**do not exist in `prisma/schema/`**. They were dropped earlier (the risk +
control-exoskeleton uproot) and the event catalog was never touched.

Nothing anywhere was red. The events are string literals in a `const`
object, so `tsc` has nothing to check them against; the schema no longer
mentions them, so no schema guardrail sees them; and their consumers — the
label registry that feeds the rule-builder trigger picker, two entries in
`AUTOMATION_TEMPLATES`, one candidate in `rankRuleSuggestions` — are all
internally consistent with each other. The catalog agrees with the labels
which agree with the templates. The only thing they disagree with is the
database, and no test compares those two.

The user-visible consequence is worse than dead code: the rule builder
still OFFERS these as triggers, and the suggestions rail still RECOMMENDS
"Notify the team when a practice test fails" with a 0.82 confidence score.
A tenant can build that rule, save it, and it can never fire. That is the
same failure shape as the RAG badge and the practices drill-down tile
recorded earlier in this document — a value derived from something nothing
computes, rendered as fact — and it is the third instance, which makes it a
pattern rather than an accident.

**Rule for the rest of the teardown:** an event / trigger / filter-field
catalog is a claim about the schema. When a model dies, grep the catalogs
for it BY MODEL NAME, not just by import. The three that exist today are
`src/app-layer/automation/events.ts`, `src/lib/automation/event-labels.ts`
and `src/data/automation-templates/index.ts`, plus the candidate list in
`usecases/automation-suggestions.ts`.

### §8l — a green local suite, a red CI shard, and a test that killed the process

The A20 commit (f55c96ef) turned PR #557 red on `Test (shard 3/4)` while
shards 1, 2 and 4 passed, and the full local suite passed too. The shard log
carried no jest summary at all — it ended with:

```
Error: ENOENT: no such file or directory,
       open '/tmp/ci-uploads/tenants/tenant-1/evidence/file-1.pdf'
Emitted 'error' event on ReadStream instance at: …
##[error]Process completed with exit code 1.
```

That path is the fixture in the new `evidence-download-gate.test.ts`. The
cause is a module-resolution trap worth writing down, because nothing about
it is visible at a call site:

**`src/lib/storage.ts` and `src/lib/storage/index.ts` both exist.** A bare
`@/lib/storage` resolves to the FILE (a file beats a sibling directory), so
the two specifiers are two different modules that read as one.
`storage.ts` re-exports the abstraction, so production behaviour is
identical — the difference only bites under `jest.mock`, which is keyed on
the resolved path.

`downloadEvidenceFile` statically imported `@/lib/storage` and then
dynamically imported `@/lib/storage/index` twenty lines later. The test
mocked the former, so the latter handed back the REAL LocalStorageProvider
and `createReadStream` opened a path that does not exist.

Four things made this much worse than a failing assertion:

1. The stream's `error` fires ASYNCHRONOUSLY with no listener, so it
   terminates the worker PROCESS instead of failing a test.
2. Jest prints no summary when that happens, so the log names the file it
   could not open and nothing else — no suite, no test, no `Tests:` line.
3. Whether the process was still alive when the error landed depended on
   timing, so it read as a FLAKY shard: two runs of the SAME sha, one red
   and one green. It would have been very easy to re-run it into green and
   ship the landmine.
4. **The tests passed.** `resolves.toBeDefined()` is satisfied by a stream
   that is about to blow up, so all eleven assertions were green about a
   code path that was reading the real filesystem.

Fixed at three levels: the source now uses ONE specifier; the test asserts
`mockReadStream` was called with the pathKey, so a mock that stops
intercepting fails loudly instead of silently opening a file; and
`tests/guards/storage-module-specifier.test.ts` bans
`@/lib/storage/index` outside `src/lib/storage/`. The fix was
mutation-proved by reverting the specifier — the new assertion fails and
the ENOENT crash reproduces locally.

**The general lesson, and it is not about storage.** "The mock did not
apply" is normally a loud failure. It is silent whenever the un-mocked real
thing returns a lazily-failing handle — a stream, a socket, a deferred
promise — because the test finishes before the failure exists. When you mock
a module, assert that the mock was CALLED, not merely that the result is
defined.
