# Test coverage policy

This document is the coverage **policy** for a compliance SaaS — why
the bar is what it is, per layer, and how it ratchets up over time.
The enforced numbers live in `jest.thresholds.json`; this doc is the
reasoning behind them.

## Coverage is a risk control, not a vanity metric

Coverage percentage is only a proxy. What matters for a compliance
platform is whether the **decision logic** that enforces business
rules, permissions, and state transitions is actually exercised.

Two consequences shape this policy:

1. **Branch coverage outranks line coverage.** A usecase with eight
   `if`s can hit 100% *lines* from a single happy-path test that
   never takes a single `else`. The untested branch is the one that
   wrongly grants access, skips a validation, or mishandles an
   invalid state transition. For decision-heavy code, the branch
   number is the real signal — line coverage is the floor, not the
   goal.

2. **Layers carry different risk, so they carry different bars.**
   A bug in the business-logic layer is a compliance defect shipped
   to customers. A bug in a thin HTTP route handler is usually a
   400 vs 500. The policy is risk-tiered accordingly.

## Risk tiers

| Tier | Scope | Why | End-state target (branches / functions / lines) |
|------|-------|-----|--------------------------------------------------|
| **A — Highest assurance** | `src/app-layer/usecases/` | The business-logic layer **is the product** — business rules, approvals, workflow transitions, validations, enforcement. An untested branch here is a shipped compliance defect. | **70 / 70 / 80** |
| **A — Highest assurance** | `src/app-layer/policies/` | Authorization decisions (`assertCanRead/Write/Admin/Audit`). A wrong branch is a security hole. Branch-dense and small — a high bar is cheap to hold. | **75 / 75 / 80** |
| **B — High assurance** | `src/lib/` | Cross-cutting shared code — auth/session, crypto, rate-limit, parsing, config. A bug here ripples app-wide. | **65 / 65 / 75** |
| **B — High assurance** | `src/app-layer/events/` | The hash-chained audit trail — integrity-critical. | **65 / 65 / 75** |
| **C — Standard** | Global (everything else) | API route handlers are thin HTTP glue; React components are UI. Real, but a 500 not a compliance breach. | **65 / 65 / 78** |

`policies/` and `events/` got their dedicated threshold keys in
**quality-roadmap P3** — seeded a few points below measured coverage
so the existing assurance is locked while leaving margin for
single-test flake. Roadmap-3 P4 originally reserved this slot; it was
filled by quality-roadmap P3.

## Current floors vs. targets

`jest.thresholds.json` holds the **current floor** — the highest
value CI can enforce today without failing. It is a ratchet: never
lowered, raised whenever a PR earns it.

| Scope | Branches now → target | Functions now → target | Lines now → target |
|-------|----------------------|------------------------|--------------------|
| `usecases/` | **66** → **70** | **62** → **70** | **77** → **80** |
| `policies/` | **78** → 75† | **88** → 75 | **88** → 80 |
| `events/` | **72** → 65† | **60** → 65 | **78** → 75 |
| `lib/` | **66** → 65 | **61** → 65 | **71** → 75 |
| global | **56** → 65 | **54** → 65 | **70** → 78 |

†`policies/` and `events/` already SURPASS their tier targets on
branches — the tier target stays as written for parity with the
other dimensions; the ratchet enforces the higher measured floor.

After stage 3h, `usecases/` measured branch coverage is **67.78%**
with the floor at 66 holding it. From the original "sub-50% branches"
framing (Roadmap-3 P2 baseline) we have climbed ~18 percentage points
across stages 3a-3h. The remaining work is the climb from 66 to the
end-state 70 — accumulated drift across small file additions plus
one more focused wave should close it.

## The staged ratchet plan

One giant threshold jump is not adoptable — it would block every PR
until a massive test backlog clears. Coverage rises in deliberate
stages, each a PR that adds real tests and then lifts the floor in
the same diff so the gain is locked.

`usecases/` branch coverage — the priority metric:

| Stage | Branch floor | Status | How |
|-------|-------------|--------|-----|
| 0 | 37 | ✅ done | starting point |
| 1 | ≈50 | ✅ done — Roadmap-3 P2 (#623 floor 37→42) + accumulated drift | |
| 2 | **55** | ✅ done — quality-roadmap P1/P2 (lock the gain; measured ≈58) | |
| 3a | **56** | ✅ done — auth-followups quality wave: 3 previously-untested usecase files (`evidence-maintenance`, `control/templates`, `audit-readiness/sharing`) got 51 branch-focused tests across ~50 decision paths. Floor bumped +1 across all 4 metrics in the same diff. | |
| 3b | **58** | ✅ done — stage-3b wave: 41 branch-focused tests on `audit-readiness/packs.ts` (443 lines, previously untested) covering ~30 decision branches across 8 exported functions + 4 snapshot helpers + 2 default-pack pickers. File-level coverage **92/85/89/95**. Floor bumped +2 across all 4 metrics in the same diff. | |
| 3c | **60** | ✅ done — stage-3c wave: `framework/install.ts` already had a 15-test wave-4 unit test, but it covered only **35.48%** of branches (5 of 7 functions, with gaps). Extended to 39 tests covering `computeCoverage` + `listTemplates` (previously untested) + the missing branches across the prior 5 functions. File-level jumped **45/35/47/44 → 97/95/93/97** — a 60-point branches lift on 544 lines. Floor bumped +2 across all 4 metrics. | |
| 3d | **62** | ✅ done — stage-3d wave: 30 branch-focused tests on `org-invites.ts` (512 lines, **completely untested before this PR**). Compliance-critical: this is 1 of the 3 paths that can write an `OrgMembership` row. Branches covered: token issuance + role/email validation + already-member reject + revoke + listPending + 6 preview outcome branches + atomic-claim race / mismatch / expired / revoked / accepted + Step-3 email-mismatch (forbidden, token already burnt) + Step-4 invariant + ORG_ADMIN vs ORG_READER provisioning branch + safeOrgAudit best-effort swallow. File-level coverage **0/0/0/0 → 100/89/100/100**. Original +3 bump (target 63) overshot by 0.5 — full-suite measured branches at 62.5%; backed off to +2 (target 62) in a fixup. Lift to 64-65 carries into stage 3e. | |
| 3e | **62 / 57 / 73 / 70** | ✅ done — stage-3e wave: 22 branch-focused tests on `webhook-processor.ts` (485 lines, previously untested). Security-critical: replay-defense + cross-tenant resolution (tenant from `IntegrationConnection`, never from caller) + signature verification (github/gitlab/generic-hmac/no-secret-allow branches) + provider-impl fan-out + best-effort orchestrator dispatch + sanitizeHeaders PII redaction. File-level **0/0/0/0 → 98/86/86/99**. CI's full-suite measured branches at **62.98%** (only +0.5 over stage-3d's 62.5% — the new file adds ~25-35 of the ~4962 tree branches). +2 → 64 missed by ~1; backed off to **branches stays at 62**, others +1 (functions 57, lines 73, statements 70). The test file is durable; the floor reflects measured. | |
| 3f | **63 / 58 / 74 / 71** | ✅ done — stage-3f wave: 49 tests across TWO files in one PR. `framework/coverage.ts` (313 lines, **previously had duplicate exports tested under framework/install but not the unique `exportCoverageData` / `generateReadinessReport` / `exportReadinessReport`**): file-level **98/78/95/98**. `control/queries.ts` (337 lines, **completely untested**): file-level **100/95/100/100** — dashboard aggregator + consistency-check RBAC + 3 not-found paths + topOwners fold. Floor bumped +1 across all (conservative after stages 3d/3e showed broader-tree dilution). | |
| 3g | **64 / 59 / 75 / 72** | ✅ done — stage-3g wave: 40 tests across 3 files. `soft-delete-lifecycle.ts` (143 lines) at **100/100/100/100** — perfect file-level coverage on restore + purge + list with all model/delegate/not-found guards. `vendor-assessment-reminder.ts` (129 lines) at **100/96/100/100** — all 5 reject paths (not-found / status / no-email / expired token / missing relations) plus dedup behavior. `org-dashboard-widgets.ts` (225 lines) at **100/96/100/100** — cross-org-id leak defence locked across update + delete; partial-update branch coverage on title / position / size / enabled / chartType+config revalidation. Floor +1 across all (consistent with stage 3f's broader-tree-dilution pattern). | |
| 3h | **66 / 62 / 77 / 74** | ✅ done — stage-3h wave: 54 tests across 5 files in one PR. `control/page-data.ts` (originally on the candidate list) was dropped as already-covered (100/94/100/100); `soft-delete-operations.ts` replaced it. `test-readiness.ts` (105 lines) at **100/75/100/100**. `soft-delete-operations.ts` (117 lines) at **100/100/100/100** — generic restore + purge for every soft-deletable entity. `org-tenants.ts` (149 lines) at **100/100/100/100** — `createTenantUnderOrg` with tx + best-effort provisioning + P2002 → ConflictError translation. `framework/fixtures.ts` (196 lines) at **100/95/100/100** — `upsertRequirements` + `computeRequirementsDiff`. `org-dashboard-presets.ts` seeder (218 lines) at **100/80/100/100** — the existing preset-shape test covered only 25/0/0/25; extended with 8 tests for `seedDefaultOrgDashboard` idempotency + payload mapping. CI full-suite measured usecases/: branches **67.78%**, fn 65.55%, lines 77.99%, stmts 76.32%. Conservative bump matched measured headroom: branches +2, functions +3, lines +2, statements +2. Leaves ~1-2pp slack. | |
| 4 (target) | **70** | — | end state; held by the ratchet. Stage 3h landed branches at 66/measured 67.78% — one more focused wave or accumulated drift across small file additions should clear the 70 bar. |

`lib/` is already at its tier target (66/61/71). Global rises as a
*consequence* of A/B-tier gains plus standard-tier hygiene — it is
not chased directly.

Two rules keep the ratchet honest, both already CI-enforced via
`jest.config.js` + the `Coverage (≥60%)` job:

- **A PR may not lower a floor.** If a change drops observed
  coverage below a floor, CI fails — add the missing test or revert.
- **A PR that raises observed coverage raises the floor**, in the
  same diff, so the gain cannot silently erode later.

Roadmap-3 P4 makes the "never lower a floor" rule a structural
guardrail (a ratchet test), rather than relying on contributor
discipline.

## What NOT to do

- **Do not chase line coverage with assertion-free tests.** A test
  that calls a function and asserts nothing lifts the line number
  and protects nothing. Branch + behavioural assertions or it does
  not count.
- **Do not add a threshold key above measured coverage.** It fails
  CI immediately. Seed a new key at the measured value, then
  ratchet.
- **Do not lower a floor to make a red PR green.** That is the
  regression this policy exists to prevent — fix the test gap.

## Enforcement

- **Source of truth:** `jest.thresholds.json` (global + per-folder
  keys), passed to jest via `--coverageThreshold` on the CI
  `Coverage (≥60%)` job. The CLI flag is load-bearing — jest 29
  ignores config-level `coverageThreshold` when `projects:` is set
  (see `docs/implementation-notes/2026-04-27-gap-15-coverage-enforcement.md`).
- **Per-layer keys** in that file enforce a higher bar on the
  higher-risk folders independently of the global number.
- The CI job prints the observed-vs-floor table on every PR.

### What is actually in the denominator

Not what `jest.config.js` appears to say. Jest splits a resolved
config into a **GlobalConfig** and a per-project **ProjectConfig**,
and coverage options are split across the two. Put one on the wrong
side and it is silently inert — no warning, no error:

| option | read from | effect if written on the other side |
| --- | --- | --- |
| `collectCoverageFrom` | **global** only | inert inside a `projects:` entry |
| `coveragePathIgnorePatterns` | **project** only | inert at the top level — `readConfigs` normalises each project standalone, inheriting nothing |
| `coverageThreshold` | **project** (in multi-project mode) | inert at the top level |

This repo carried a project-level `collectCoverageFrom` for a long
time. All of it — the positive scope AND the `!` negations — did
nothing. The real denominator is therefore **every file some test
loads**, minus each project's `coveragePathIgnorePatterns`. That is
what every floor in `jest.thresholds.json` was calibrated against;
`src/components/**` and `src/app/**` are in it even though no
positive pattern ever listed them.

Consequences worth knowing before you change the config:

- **Do not "restore" `collectCoverageFrom` by hoisting it to the top
  level.** Activating it would drop `src/components/**` + `src/app/**`
  from the report and force-include never-loaded files at 0% — a
  wholesale redefinition of the population the floors describe, in
  which a real regression is indistinguishable from the re-scoping.
- **To remove something from the denominator, use
  `coveragePathIgnorePatterns` on every project.** The report is
  merged across projects; a file excluded in `node` but not `jsdom`
  is still counted.
- **Verify with a run that LOADS the file.** "Absent from
  `coverage-summary.json`" is vacuously true for anything the run
  never touched. `tests/guards/coverage-barrel-exclusion.test.ts`
  does this properly: it asserts a sibling of the excluded file IS
  present, so the absence cannot be vacuous.

The only standing exclusion is `PURE_REEXPORT_BARRELS` — files whose
compiled form is nothing but `Object.defineProperty(exports, …)`
getters that istanbul counts as uncovered functions. The same guard
fails CI if one of them grows executable code.

### The ratchet guard

`tests/guards/coverage-ratchet.test.ts` makes the **"never lower a
floor"** rule structural, not just a convention. It carries a
`RATCHET_FLOOR` — the hard minimum for every threshold — and fails
CI if any value in `jest.thresholds.json` drops below it.

- **Raising** a threshold always passes (a value above the floor is
  fine) — that is the ratchet moving up.
- **Lowering** one below the floor fails CI loudly. To genuinely
  retire a floor you must edit `RATCHET_FLOOR` downward too — a
  visible, reviewed act, never a drive-by "make CI green" change.
- `RATCHET_FLOOR` is seeded at the post-Roadmap-3 state and is only
  ever edited upward as the staged plan advances.

This is the structural backstop for the policy: the
`Coverage (≥60%)` job enforces the *current* numbers; the ratchet
guard enforces that those numbers can only travel one direction.

### Next ratchet steps

- ~~Add dedicated threshold keys for `policies/` and `events/`.~~
  ✅ done in quality-roadmap P3 — keys seeded at the measured values
  (`policies/` 78/88/88/85, `events/` 72/60/78/75) and added to
  `RATCHET_FLOOR`.
- Advance the `usecases/` branch floor through the remaining stages:
  **stage 3 (≈65)** next — branch tests for the lowest-covered
  files (`audit-readiness/packs`, `framework/*`, `control/*`,
  `evidence-maintenance`, …), each currently at 0% branch
  coverage despite carrying substantial business logic — then
  **stage 4 (70)** as the end state held by the ratchet.
