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

`npx tsc --noEmit` is clean. The guard suites went **80 → 23 failing**
(225 → 94 assertions). What is DONE:

- 23 pages + 97 API routes deleted (six route trees sat outside the tenant
  tree and would have survived a `src/app/api/t/*` delete).
- Shared exports lifted out of the doomed page dirs into
  `src/components/EvidenceSubTable.tsx` and `src/components/processes/`.
- 177 stale guard-registry entries removed; 15 guard suites deleted whole
  (each read, not keyword-matched); 5 numeric ratchets lowered to reality.
- `route-permissions.ts` orphan rule, `route-exemptions.ts` stale entries, and
  the k6 load scripts severed.

### The 23 that remain

```
design-system-drift          form-primitive-adoption      form-telemetry-adoption
loading-states               table-platform-drift         token-migration
action-button-canonical-…    columns-dropdown-coverage    epic55-native-select-ratchet
epic63-timestamp-rollout     icon-only-action-discipline  list-page-shell-coverage
metadatabar-detail-coverage  pageheader-adoption          r23-prd-assets-practices-rollout
r32-modal-form-completeness  right-rail-discipline        roadmap-11-completion
sharepoint-sp5               state-coverage               table-unification
tab-primitive-adoption       ux-foundation-ratchets
```

Most are adoption registries with a surviving half — `r23-prd-assets-practices`
(assets live, practices gone), `sharepoint-sp5` (the admin sync-health
dashboard lives, the audit-pack export does not). They narrow; they do not
delete.

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

Everything below the guard tier: the KILL usecases/repositories/policies
(`AuditRepository`, `PolicyRepository`, `VendorRepository`, `PracticeRepository`,
`FrameworkRepository`, `MappingRepository`, the `vendor-assessment-*` and
`audit-readiness` families), the GRC components, the jobs and their four
registration points, `permissions.ts` / `search.ts` / command palette / nav /
`modules.ts`, ~2,460 i18n keys in both locales, the 45 unit/integration/rendered
files and 24 e2e specs, and all of phase 3.

`compliance-calendar.ts` still needs splitting — `getUpcomingDeadlineCount`
feeds the sidebar badge on EVERY authenticated page.
