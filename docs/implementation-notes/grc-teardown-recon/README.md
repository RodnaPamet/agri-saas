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
