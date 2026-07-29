# 2026-07-29 — Coverage wave 22: nine repositories

**Commit:** _(this PR)_

Nine files in `src/app-layer/repositories/` had never been meaningfully
executed. Together they carried **97 uncovered functions and 202
uncovered branches** on the `main@65b58e8b` CI artifact. This wave takes
all nine to **100% functions / 100% lines / 100% statements**, and to
100% branches on eight of the nine.

| File | Before (fn) | Before (br) | Before (lines) |
|---|---|---|---|
| `ControlRepository.ts` | 3/27 | 32/96 | 20.25% |
| `FileRepository.ts` | 3/15 | 5/38 | 19.23% |
| `TraceabilityRepository.ts` | 2/13 | 8/12 | 35.29% |
| `AssessmentRepository.ts` | 0/10 | 0/10 | 13.04% |
| `FrameworkRepository.ts` | 0/10 | 0/10 | 4.76% |
| `exchange.ts` | 1/10 | 8/17 | 47.61% |
| `SsoConfigRepository.ts` | 2/10 | 0/22 | 52.17% |
| `OnboardingRepository.ts` | 0/7 | 0/14 | 7.14% |
| `TestPlanRepository.ts` | 0/6 | 0/36 | 5.55% |

Projected effect on the `global` threshold group (the one that fails
CI): functions **62.58% → 64.06%**, clearing the floor of 64 on its own;
branches **63.10% → 64.04%**.

## Why these files

`jest.thresholds.json` declares PATH thresholds for `./src/lib/` and
`./src/app-layer/{usecases,policies,events}/`. Jest removes any file
matching a path threshold from the `global` group, so the failing number
is scored over everything *else*. `src/app-layer/repositories/` sits in
that remainder, and it is the layer CLAUDE.md gives a single
non-negotiable rule: **every query filters by `tenantId`**. Asserting the
emitted `where` there is a security contract, not a coverage exercise.

Nine files rather than one because the remaining repositories are small:
seven of the nine are under 200 lines. The mutation check stays honest by
mutating each *family* independently (table below).

## Files

| File | Role |
|---|---|
| `tests/unit/repositories/control-repository.test.ts` | new — 60 tests over `ControlRepository` |
| `tests/unit/repositories/file-repository.test.ts` | new — 24 tests over `FileRepository` |
| `tests/unit/repositories/traceability-repository.test.ts` | new — 15 tests over the three cross-entity link repositories |
| `tests/unit/repositories/assessment-repository.test.ts` | new — 19 tests over `QuestionnaireRepository` / `VendorAssessmentRepository` / `VendorAnswerRepository` |
| `tests/unit/repositories/framework-repository.test.ts` | new — 14 tests over `FrameworkRepository` |
| `tests/unit/repositories/exchange-repository.test.ts` | new — 24 tests over `ExchangeRepository` |
| `tests/unit/repositories/sso-config-repository.test.ts` | new — 19 tests over `SsoConfigRepository` |
| `tests/unit/repositories/onboarding-repository.test.ts` | new — 13 tests over `OnboardingRepository` |
| `tests/unit/repositories/test-plan-repository.test.ts` | new — 19 tests over `TestPlanRepository` |

## What is asserted

The **query the repository emits**, not Prisma's behaviour — the
boundary contract this code owns. `db` is a recording double; the
pagination helpers (`clampLimit`, `buildCursorWhere`, `computePageInfo`)
run for real, because their interaction with the repository is part of
what is under test. `SsoConfigRepository` is the exception: it talks to
the global `prisma` singleton, which is mocked at the module boundary.

The isolation shape is **not uniform across these files**, and pinning
each variant was the main point of the wave:

- **Tenant-or-shared reads.** `Control` is the one entity with a shared
  tier (`tenantId: null` = the platform catalogue). Reads admit
  `mine OR null`; writes require `mine` strictly; and the nested
  `evidence` relation on a control read is scoped to `mine` alone —
  reusing the outer predicate there would hand one tenant another
  tenant's evidence on a shared control.
- **Tenant-leading composite keys.** Every `TraceabilityRepository`
  unlink addresses its row by `tenantId_*_*`, which makes the tenant part
  of the row's *address* rather than a filter over it. Dropping
  `tenantId` from one of those keys is a silent cross-tenant delete, and
  it reads as tidy-up in review.
- **Deliberately global reads, pinned as such.** `exchange.ts` has no
  tenant column at all (the marketplace only works if tenants see each
  other's offers); `FrameworkRepository`'s catalogue is global;
  `SsoConfigRepository.findByDomain` runs pre-authentication off an
  e-mail address that carries no tenant. Each of those carries a test
  saying so, because "add the missing tenant filter" would break the
  feature rather than secure it.
- **Guard-then-mutate-by-bare-id.** `TestPlanRepository.update` /
  `updateNextDueAt` and `SsoConfigRepository.upsert`'s update branch
  address the row by primary key alone. Both are reached only after the
  usecase has resolved the row through a tenant-scoped read, and the
  test-plan path additionally runs inside `runInTenantContext` so RLS
  binds at the DB. Those tests are labelled as characterizations of what
  is being relied upon, so a new caller that skips the upstream read has
  a written record of what it just broke.

Beyond isolation, the substantive contracts covered are: the
`where.AND` merge that keeps a search filter alive on page 2 of a
cursor-paginated list; the AV-scan lifecycle (`markStored` must arm
`scanStatus: PENDING`; `findPendingScan` must select only `STORED` rows;
SHA-256 dedup must match only a `STORED` twin); the DRAFT → IN_REVIEW →
decided vendor-assessment state machine and its two refusal paths; the
SoA coverage arithmetic including the divide-by-zero guard and
requirement de-duplication; onboarding's two read-modify-write
accumulators (`stepData` merge, `completedSteps` de-dup); the exchange
decline sweep reading ids *before* the `updateMany` because a count
cannot be notified; and the SSO create defaults —
`isEnabled: false, isEnforced: false` — where a truthy default would lock
a tenant out of their own account the instant they saved a draft config.

## Decisions

- **Mutation check.** Seven mutations, one per file family, all caught
  on the first pass by the intended test:

  | Mutation | Caught by |
  |---|---|
  | `ControlRepository.create` spreads `...data` *after* `tenantId`, so a request body can pick its own tenant | `create › overrides a caller-supplied tenantId rather than honouring it` |
  | `ControlRepository.update`'s ownership pre-check loses its `tenantId` arm | `update › checks ownership with a STRICT tenant match before writing` |
  | `ControlRiskRepository.unlink` drops `tenantId` from its composite key | `ControlRiskRepository › addresses the unlink by the tenant-leading composite key` |
  | `FrameworkRepository.getCoverage` counts `mappings.length` instead of distinct requirements | `getCoverage › counts a requirement once even when several controls map to it` |
  | `SsoConfigRepository.findByDomain` stops lower-casing the e-mail domain | `findByDomain › lower-cases the domain before matching the stored list` |
  | `FileRepository.markStored` stops setting `scanStatus: 'PENDING'` | `status transitions › arms the AV scan when a file becomes STORED` |
  | `ExchangeRepository.declinePendingInquiries` returns `[]` instead of the pending rows | `declinePendingInquiries › returns who was declined, not just how many` |

  The second is the one wave 16 learned the hard way: mocking `findFirst`
  to `null` and asserting `update` was not called holds for *any*
  where-clause, so it proves "a missing row is refused" and not "the
  lookup is tenant-scoped". Every guard test in this wave therefore also
  asserts the exact `findFirst` argument.

- **`EvidenceBundleRepository` was skipped on purpose.** It is 6
  uncovered functions and would have been the cheapest file here — but
  it is a deprecated stub whose four write methods throw
  `deprecatedResource` and whose two reads return a constant. A test over
  it executes lines and asserts nothing about the product. That is the
  exact failure mode this campaign exists to avoid, so the functions were
  left uncovered rather than bought cheaply.

- **Two live inconsistencies were recorded, not fixed.** A coverage wave
  is the wrong PR to change behaviour in, so both are pinned with a
  comment naming what is being relied upon:

  1. `TestPlanRepository.update` / `updateNextDueAt` carry no tenant
     predicate; `control-test.ts` gates them with a tenant-scoped
     `getById` and a `runInTenantContext` transaction.
  2. `SsoConfigRepository.upsert`'s update branch carries no tenant
     predicate; `sso.ts::upsertTenantSsoConfig` gates it with
     `findById(ctx.tenantId, input.id)`.

  Neither is exploitable through today's callers. Both are one careless
  new caller away from being a cross-tenant write, which is why they are
  now written down where the next reader will find them.

- **One branch deliberately left uncovered.** `ControlRepository.ts:75`
  normalises a non-array truthy `where.AND` before appending the cursor
  predicate. `_buildWhere` only ever sets `AND` to an array, so that arm
  is unreachable through the public surface; it is defensive code, and
  faking a path to it would mean testing a shape the repository cannot
  produce.
