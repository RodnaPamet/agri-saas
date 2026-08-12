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
