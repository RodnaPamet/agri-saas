# GRC teardown — phase 2 recon artifacts

Machine-generated inputs for the phase-2 deletion, preserved because
regenerating them costs a ten-agent sweep (~1.3M tokens) and because two of
the findings **corrected the teardown plan itself** (see §8 of
`../2026-08-12-grc-teardown-plan.md`).

| file | what it is |
|---|---|
| `severance-map.json` | 713 references INTO doomed GRC surfaces from code that SURVIVES the teardown. Each entry: `{file, line, kind, detail, surface}`. `kind` ∈ import / prisma-delegate / fetch-url / permission-key / route-permission / nav-entry / registry-entry / i18n-namespace / link-href / other. |
| `completeness-critique.md` | An adversarial pass over the sweep asking what it MISSED. This is the higher-value document of the two — it found four whole reference classes the sweep's four modalities structurally cannot see, plus five files that break on deletion and appear in no reference list. |
| `failing-guards-after-route-deletion.txt` | Raw jest output naming the 80 guard suites (225 assertions) that went red once the pages and routes were deleted. |
| `app-layer-work-order.md` | The APP-LAYER execution plan (2026-08-13). Seven clusters mapped in parallel, each then handed to an adversarial reviewer told to REFUTE it. Three came back **UNSAFE**; 28 findings would have broken a KEEP surface. Section A is the blocking list, B resolves cluster disagreements, D is the tranche order, E is the phase-3 handoff. ~3.1M tokens to produce. |
| `app-layer-cluster-verdicts.json` | Per-cluster verdict + blocker count from that pass. |

## How to use the severance map

It is a work-list, not a spec. Group by `file` (not by surface) — one file
often carries references to several doomed surfaces and should be edited once.
The heaviest are `prisma/schema/auth.prisma` (26), `src/lib/schemas/index.ts`
(19), `messages/en.json` (19), `src/lib/nav/page-segregation.ts` (17).

## What it does NOT cover

Read `completeness-critique.md` before trusting the map to be complete. In
particular it contains **no entry** for:

- relation traversal on a surviving delegate — `db.task.findFirst({ include: {
  practice: … } })` names `Practice` nowhere, and this pattern sits in
  `WorkItemRepository` (the farm-task repository), `AssetRepository`,
  `EvidenceRepository` and `ProcessMapRepository`, all of which KEEP;
- `tests/unit`, `tests/integration`, `tests/rendered`, `tests/e2e` — 45 files
  import a doomed module and 24 e2e specs navigate a doomed surface, several of
  them shared specs that must be EDITED, not deleted (`fixtures.ts`,
  `auth.spec.ts`, `a11y.spec.ts`, `responsive.spec.ts`, `core-flow.spec.ts`,
  `data-table-platform.spec.ts`);
- `prisma/migrations/**/*.sql` — 57 files name a KILL table, the phase-3 blast
  radius for RLS drops and `.down.sql` inverses;
- DB-resident strings: `ApiKey.scopes` (`vendors:*`), `TenantCustomRole
  .permissionsJson` (`policies.approve`), `AutomationRule.event`
  (`POLICY_REVIEW_DUE`), `TenantModule.moduleKey` (`VENDORS`). These are rows,
  not code. Deleting the enum members orphans them and every issued API key
  carrying a dead scope starts failing `assertScope` silently.

## Triaging the 80 failing guards

Do NOT do this mechanically. A keyword classifier was tried and immediately
mis-sorted `b7-layout-redesign` as delete-whole when it spans many surviving
pages. The standing rule from the brief is **narrow, don't blanket-delete**,
and lowering a ratchet baseline because code was deleted is correct while
raising one or disabling a guardrail never is.

The genuinely GRC-only suites (safe to delete whole, verified by reading them)
are the practice/policy/vendor-specific ones: `b4-practice-tasks-tab`,
`practice-task-create-modal`, `practice-detail-tab-lazy`,
`practices-detail-page-size`, `p2c-practice-reverse-lookup`,
`vr9-practice-ai-suggestions`, `practices-tasks-list-hydration`,
`b8-folders-frameworks`, `b9-policy-template-upgrade`,
`r23-prf-policies-vendors-capstone`, and the three `sharepoint-*` suites —
SharePoint integration in this repo is policy-centric (`sharepoint-policy-pull`,
`sharepoint-subscription-renew`, a Graph webhook resolving `db.policy`).
Everything else is a narrow.

---

## State as of the last phase-2 commit

`npx tsc --noEmit` is clean and the **guard tier is fully green** — 582
suites, 7614 passing, 1 skipped. The suites went 80 → 23 → **0 failing**
(225 → 94 → 0 assertions). What is DONE:

- 23 pages + 97 API routes deleted (six route trees sat outside the tenant
  tree and would have survived a `src/app/api/t/*` delete).
- Shared exports lifted out of the doomed page dirs into
  `src/components/EvidenceSubTable.tsx` and `src/components/processes/`.
- 177 stale guard-registry entries removed; 15 guard suites deleted whole
  (each read, not keyword-matched); 5 numeric ratchets lowered to reality.
- `route-permissions.ts` orphan rule, `route-exemptions.ts` stale entries, and
  the k6 load scripts severed.

### How the last 23 were narrowed

All 23 were adoption registries with a surviving half, so all 23 narrowed.
Three needed a NEW SUBJECT rather than a deletion — the invariant still
mattered and only its exemplar was GRC:

- **`table-unification`** named `PracticesClient` as THE canonical
  DataTable. Assets inherits: the only surviving table with a `code` first
  column, and it carries the other three traits. The `useCallback` row-id
  sub-assertion was **dropped, not weakened** — Assets passes an inline
  arrow, and asserting the stronger form against it would be a green lie.
- **`ux-foundation-ratchets`**' react-hook-form reference was
  `NewPracticeModal`; `ContractFormModal` is the richest survivor. Its id
  assertion now says what is true: no E2E targets those ids yet, the pin
  exists so a rename has to be deliberate.
- **`action-button-canonical-entity-label`**'s `INLINE_SITES` had been
  emptied by the earlier bulk pass. Repopulated with Assets + Evidence,
  which resolve their label as `{t.addAsset}` rather than `{t('key')}`;
  the matcher reads both forms now.

Two ratchets were **re-floored** rather than left at ceilings nothing can
reach — banking headroom a deletion did not earn is exactly what a
one-way-down ratchet exists to prevent: raw `<table>` 12 → 4, native
`confirm()` 21 → 13.

`icon-only-action-discipline` is the **exception to trap 2 below**: its
call-site registry is now empty (IconAction has no call site anywhere in
`src/`), yet the suite is kept — the primitive contract reads a real file
and the Admin exclusion is a NEGATIVE scan over a live tree, so it can
still fail. The reasoning is written into the file so the next reader does
not mistake it for oversight.

### A guard-on-a-guard, worth knowing about

`tests/guardrails/pr-asset-practice-codes.test.ts` reads
`tests/guards/table-unification.test.ts` and located its registry entry by
slicing 600 chars from the FIRST occurrence of the `AssetsClient` path.
Re-pointing the canonical assertion at Assets put that path ABOVE the
registry, so the slice landed in prose and the sibling went red. It now
anchors on `const FIRST_COLUMN_TABLES`. Only the full-tier run caught
this — a targeted run of the file being edited would not have.

### Two traps, both already paid for once

1. **Run `npx tsc --noEmit` after every mechanical pass over these files.** A
   bulk entry-removal deleted paths that were CALL ARGUMENTS (`read(\n)`) and
   emptied three registries to `[]` (implicit `any[]`). Jest reported those as
   6 suites failing to run; only tsc named the cause.
2. **An emptied registry is not a passing guard.** When every entry was a GRC
   page, the guard becomes vacuous — delete it rather than leave an `[]` that
   can never fail. `card-header-discipline` and `form-section-discipline` went
   that way; `dashboard-masthead-discipline` did not, because its
   MAIN_DASHBOARD subject survives.

### Not started

Everything below the guard tier. Two phase-2 PRECONDITIONS from §7 of the
plan are still open and both are load-bearing:

- **`compliance-calendar.ts` still needs splitting.** It reads six KILL
  delegates (`policy`, `vendor`, `vendorDocument`, `auditCycle`,
  `practice`, `finding`) alongside nine KEEP ones, and
  `getUpcomingDeadlineCount` feeds the sidebar badge on EVERY
  authenticated page.
- **`achievements.ts` still needs trimming** to its four agri milestones —
  it reads `db.policy`, `db.policyAcknowledgement` and `db.auditPack`.

Then: the KILL usecases/repositories/policies
(`AuditRepository`, `PolicyRepository`, `VendorRepository`, `PracticeRepository`,
`FrameworkRepository`, `MappingRepository`, the `vendor-assessment-*` and
`audit-readiness` families), the GRC components, the jobs and their four
registration points, `permissions.ts` / `search.ts` / command palette / nav /
`modules.ts`, ~2,460 i18n keys in both locales, the 45 unit/integration/rendered
files and 24 e2e specs, and all of phase 3.

Also still open, and reachable by no grep: the `soft-delete.ts` model-name
list (it becomes `DELETE FROM "${model}"` in one loop with no per-model
try/catch — see §8d.2) and the DB-resident references in `ApiKey.scopes` /
`TenantCustomRole.permissionsJson` / `AutomationRule.event` /
`TenantModule.moduleKey` (§8d.4). Both must land BEFORE the phase-3 drop.

`/mapping` (§8c) is half done: its API routes went with the route sweep,
including the one outside the tenant tree. The usecase, the two
repositories, the two services, the domain types, the panel component and
`data/libraries/mappings/` are all still present.
