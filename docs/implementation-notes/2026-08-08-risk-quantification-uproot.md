# 2026-08-08 — Removing the inherited GRC risk stack

**Migration:** `prisma/migrations/20260808140000_remove_grc_risk_and_control_exoskeleton/`

Companion to `2026-08-07-compliance-uproot.md`, which removed the control
exoskeleton. This note covers the risk register, the risk-quantification
layer built on top of it, and the long tail of places that referenced
"risk" as a category rather than as a table.

## Design

The removal ran in four widening rings. Each ring was only started once
the previous one typechecked and its tests were reconciled, because each
ring is what makes the next one's dead code *visible*.

```
  ring 1   the models          Risk, RiskControl, AssetRiskLink, RiskTemplate,
                               RiskMatrixConfig, RiskAppetite{Config,Breach},
                               RiskSimulationRun, RiskScenario, RiskHierarchy{Node,Link},
                               KeyRiskIndicator, KriReading, RiskCorrelation,
                               RiskSnapshot, RiskScoreEvent, RiskSuggestion{Session,Item},
                               RiskTreatmentPlan, LossEvent, RiskKeySequence,
                               FindingRisk, PortfolioSnapshot
           ↓ (deleting these makes the next ring fail to compile)
  ring 2   the computation     FAIR calculator + calibration, Monte-Carlo,
                               loss-exceedance + ALE histogram charts,
                               risk-coherence, risk-collisions, risk-staleness,
                               tail-language, the risk-appetite admin page
           ↓ (deleting these makes the next ring's callers dead)
  ring 3   the category        `RISK` as a member of ModuleKey /
                               TaskLinkEntityType / VendorLinkEntityType /
                               SearchHitType / ProcessNodeKind /
                               AUTOMATION_EVENTS / STATUS_ALLOWLIST /
                               SOFT_DELETE_MODELS
           ↓ (deleting these makes the org tier's zeros visible)
  ring 4   the org portfolio   ComplianceSnapshot.risks* columns, the RAG
                               criticalRisks axis, the sidebar entry, the KPI
                               widget, two tenants-table columns, a CTA tile,
                               a CSV section, the 90-day open-risks trend
```

Ring 3 is the one worth remembering. A deleted *table* announces itself —
the compiler finds every `prisma.risk.*`. A deleted *category* does not:
`'RISK'` is a string literal in a union, and a union member with no
remaining producer still typechecks perfectly. Those had to be found by
asking, per enum, "who can still emit this?" rather than by following
compiler errors.

## Two live defects this surfaced

Both were hidden behind a *red* suite — the inverse of the "green is not
executed" failure mode CLAUDE.md documents. A suite failing for reason A
is not read as evidence about reason B.

**Farmers stopped getting disease-pressure notifications.**
`evaluateLocationSignals` claims two AgroSignal rows. The disease branch
then, in a follow-up transaction, raised a Risk **and** marked the signal
`notified`, sent `DISEASE_RISK_RAISED`, and incremented the result
counters. An earlier pass deleted the whole block because it *opened*
with `createRisk(...)`. The signal kept firing silently; the row was
never marked notified; the caller saw `created: 1` when two signals were
claimed. `agro-signals.test.ts` would have caught it, but it was failing
with a Jest *configuration* error (`could not locate module
@/app-layer/usecases/risk`) — so it never ran.

**The automation rail offered two rules that could never fire.**
`getAutomationSuggestions` was left with `const activeRiskCount = 0`
threaded into the ranker, weighting two candidates whose trigger events
(`RISK_CREATED`, `RISK_STATUS_CHANGED`) no longer existed in the
catalogue.

The generalisable lesson: when removing a feature, a block that *starts*
with a call into it is not necessarily *about* it. Read to the end of the
block before deleting it.

## A dropped COLUMN is quieter than a dropped table — and it 500s

Deleting `Risk` made the compiler find every `prisma.risk.*`. Dropping four
scalars off a surviving `Control` made it find nothing, because Prisma
argument objects are not excess-property checked here. `ControlRepository.list`
kept

```ts
orderBy: [{ code: 'asc' }, { annexId: 'asc' }],
```

against a column that no longer exists. `tsc` was clean, every Jest suite was
green (the repository test *asserted the broken shape*, and the retention
usecase's test mocks Prisma), and both `/controls` and `/evidence` threw in
the Server Components render — a 500 on two of the product's main pages.
Nothing but a browser against a real database could see it. CI's E2E job
found it the first time it ran after the seed was repaired.

The same class ran wider than the one line: `annexId` was still in the list
`select`, in `EvidenceRepository` / `PolicyRepository` nested selects, in
`inherited-control-data`, in `evidence-retention` (three selects), in the
DTO and the OpenAPI request schemas, and in ten UI files. `code` is the
surviving column, so everything collapsed onto it — and the collapse fixed
real display bugs on the way, e.g. `CreateFindingModal` had been falling
through `c.annexId ? … : c.name` and silently dropping the code prefix from
every option label.

Two dead UI surfaces came out with it: the control edit/create forms still
offered `automationType` and `annualCost` fields that were written into a
`ControlRepository.update` call (a throw) or accepted and silently discarded
(a lie), and `TraceabilityPanel` still rendered a **Risks section with a
working-looking `Link Risk` button** on both the control and asset detail
pages, wired to deleted routes.

The rule that generalises: **when you drop a column rather than a table,
grep for the column name across `src/` and `tests/` before trusting the
compiler.** The compiler's silence is not evidence.

## The migration is the only thing that proves the schema

`tsc` cannot see Prisma `where` / `create` argument objects (they are not
excess-property checked in this repo — verified by inserting a nonsense
key and getting no diagnostic), and it cannot see raw SQL at all. So the
migration was written, then *applied*: a database dropped and rebuilt
from all 224 migrations, `migrate diff` re-run against the result to
confirm zero residual drops, the seed run to completion, and the RLS
suites run with `RLS_GUARDRAIL_REQUIRE_DB=1` so they could not skip.

That process caught two things nothing else would have:

1. **A near-miss security regression.** The generated diff swept in ~30
   statements of pre-existing schema↔DB drift (31 when written, 30 after
   merging main at `2a6ffe55` — the count moves as main evolves), one of
   which was
   `ALTER TABLE "User" ALTER COLUMN "emailHash" DROP NOT NULL` — silently
   reverting the GAP-21 hardening. Also present: the hand-written
   `KnowledgeChunk_embedding_ivfflat` and `Parcel_geometry_gist` indexes
   and the `YieldRecord.netTonnesStd` generated column, none of which
   Prisma models. The migration is filtered to the risk/control
   statements only and its header says so.
2. **The E2E seed had been dead.** `prisma/seed.ts` failed at
   `control.findFirst({ where: { annexId } })`, which killed the "Seed
   test database" step and with it the build, the Playwright install, the
   axe accessibility gate and every spec — on both shards. The E2E signal
   was absent, not weak.

> **Pre-existing drift is still there.** Those ~30 statements describe a
> real gap between `prisma/schema/` and a migration-built database. It
> predates this work and deserves its own investigation; excluding it
> here was scope discipline, not a claim that it is fine.

## Files

| Area | What changed |
| --- | --- |
| `prisma/schema/{compliance,auth,enums}.prisma` | 36 models, 15 columns, 7 enums, 3 enum members |
| `prisma/migrations/20260808140000_…` | the single migration, filtered + hand-headed |
| `prisma/seed.ts` | `annexId`→`code`; risk + control-template blocks dropped; packs seeded without the template graph |
| `src/app-layer/automation/` | the four `RISK_*` events, payloads, union variants, labels |
| `src/lib/search/`, `src/lib/palette/` | `risk` + `test` dropped from `SearchHitType` and every `Record<SearchHitType, …>` |
| `src/app-layer/usecases/portfolio.ts`, `schemas/portfolio.ts` | the `risks` summary block; `computeRag` loses its `criticalRisks` axis |
| `src/app/org/[orgSlug]/**` | sidebar entry, KPI widget, tenants columns, CTA tile, CSV section, trend |
| `src/app-layer/jobs/{schedules,types,snapshot,compliance-digest}.ts` | 3 executor-less cron jobs; the nine zero-valued snapshot columns |
| `src/lib/format-currency.ts` | **new** — `formatCompactCurrency` rescued from `risk-coherence.ts` |
| `src/app-layer/repositories/{Control,Evidence,Policy}Repository.ts` | dropped `annexId` from the list `select` + the `orderBy` tiebreak + two nested control selects |
| `src/app-layer/usecases/{evidence,evidence-retention,inherited-control-data,control/mutations}.ts` | `annexId` → `code`; `automationType` / `annualCost` removed from the update path |
| `src/lib/dto/control.dto.ts`, `src/lib/schemas/index.ts` | dropped the four dead Control fields, the dead `_count` keys, and seven schemas this PR orphaned |
| `src/components/TraceabilityPanel.tsx` | the whole Risks arm — section, columns, link/unlink branches, `entityType` union member |
| `tests/e2e/{frameworks,control-tests}.spec.ts` | **deleted** — both drove pages this PR removed |
| `tests/e2e/{core-flow,entity-detail-layout,reporting,mobile/horizontal-drift}.spec.ts` | repointed off the risk register onto Asset / Control |
| `src/lib/reports/csv-escape.ts` | (from the 08-07 pass) the shared formula-injection guard |

## Decisions

- **Rescue, don't re-derive.** `formatCompactCurrency` happened to live
  in `risk-coherence.ts` but is the app's only money renderer (grain
  contracts, yield valuations, lease rents). Moved to a neutral module
  and the `polish-06-single-currency` ratchet repointed in the same diff,
  so "declared exactly once" still has a subject.
- **Repoint fixtures, delete subjects.** A suite whose *subject* died was
  deleted; a suite that merely used a Risk row as a *fixture* for a live
  assertion was repointed. The Epic B envelope-dispatch tests, the DEK
  rotation lifecycle, the auditor fan-out drift check and the RLS
  tripwire all fall in the second group and all still run.
- **Never empty a ratchet.** Where a registry would have been left with
  zero entries — `form-section-discipline`'s ADOPTERS, the R23 consumer
  halves, `right-rail-discipline`'s adopter — it was repointed to a live
  subject or narrowed to an assertion that still has one. An empty
  ratchet is green forever.
- **`rendered-coverage-floor` is upward-only, and it moved down.** That
  is the documented exception ("if a test was legitimately merged or
  renamed, account for it"), so the comment enumerates all 21 deleted
  suites by name and category and states the invariant that actually
  matters: no *surviving* component lost its rendered coverage.
- **`computeRag` is a behaviour change, not a refactor.** A tenant's RAG
  badge is now coverage + overdue-evidence only. The two surviving
  thresholds are unchanged, so no badge moves except where a
  critical-risk count was the sole cause — and that count was already
  always zero.
