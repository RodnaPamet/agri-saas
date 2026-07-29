# 2026-07-29 — Coverage wave 21: `WorkItemRepository`

**Commit:** _(this PR)_

`WorkItemRepository` was the densest untested file left in the `global`
coverage group: **24 uncovered functions and 75 uncovered branches**
(9/33 functions, 74/149 branches, 52.05% lines on the
`main@e8b5e698` artifact). This wave takes it to **100% functions /
100% branches / 100% lines / 100% statements**.

It is also the busiest repository in the product. Tasks, Issues and
Field Operations are all the same `Task` row — `IssueRepository` and
`TaskRepository` are re-export shims onto this class — so every one of
those three surfaces reads and writes through it.

## Why this file, and why not the obvious ones

`jest.thresholds.json` declares PATH thresholds for `./src/lib/` and
`./src/app-layer/{usecases,policies,events}/`. Jest removes any file
matching a path threshold from the `global` group, so the number that
actually fails CI is scored over everything *else* — chiefly
`src/components/**`, `src/app/**`, and the rest of `src/app-layer/**`.
`src/app-layer/repositories/` sits in that remainder, and it is the
layer CLAUDE.md gives a single non-negotiable rule: **every query
filters by `tenantId`**.

## Files

| File | Role |
|---|---|
| `tests/unit/repositories/work-item-repository.test.ts` | new — 75 tests over `WorkItemRepository`, `TaskLinkRepository`, `TaskCommentRepository`, `TaskWatcherRepository` |

## What is asserted

The **query the repository emits**, not Prisma's behaviour — the
boundary contract this code owns. `db` is a recording double; the
pagination helpers (`clampLimit`, `buildCursorWhere`,
`computePageInfo`) and the status domain (`isTerminalStatus`) run for
real, because their interaction with the repository is part of what is
under test.

- **Tenant isolation.** Every read is scoped, asserted against *two*
  different tenants so a hard-coded or cached id cannot pass.
  `update`, `setStatus`, `assign`, `TaskLinkRepository.unlink` and
  `TaskWatcherRepository.remove` all guard with a tenant-scoped
  `findFirst` and then mutate by **bare id** — that lookup is the only
  thing between a leaked id and a cross-tenant write, so each is
  covered on the refusal path *and* on the exact shape of the lookup
  (see the mutation table below for why the refusal alone is not
  enough). The three `updateMany` bulk paths have no per-row guard at
  all, so their `where` is asserted directly.
- **Filter translation.** The six scalar filters map 1:1; `overdue`
  and `next7d` each add an implicit not-terminal status guard *unless*
  the caller supplied their own status; `q` fans out to a
  case-insensitive OR over `title` and `key`; a linked-entity pair
  needs BOTH halves; and `CONTROL` — uniquely — matches through either
  the generic `TaskLink` **or** the direct `Task.controlId` FK, which
  is what makes pack-installed tasks visible on a control's Tasks tab.
- **Cursor pagination.** Over-fetch by exactly one and trim, clamp an
  absent/oversized limit, ignore an unparseable cursor rather than
  500-ing a bookmarked URL, and — the one that matters — **append**
  the cursor predicate to an existing `where.AND` instead of replacing
  it. Replacing it makes page 2 of a *filtered* list silently return
  the unfiltered tenant.
- **Linked-task counting.** Both batched counters short-circuit an
  empty id set (no `in: []` query), dedupe by task id so a task linked
  via both paths counts once, and tally `done` as RESOLVED|CLOSED
  only — never CANCELED, which would report abandoned work as
  completed on a control's readiness badge.
- **Write payloads.** Atomic key minting from `taskKeySequence` (not
  the racy `count()` derivation it replaced), the create defaults
  (`TASK` / `MEDIUM` / `P2` / `MANUAL`), blank-string-to-null and
  date-string-to-`Date` coercion, `Prisma.JsonNull` vs JS `null` on
  both the create and update paths, and partial-update semantics —
  including that an explicitly-null `description` IS applied while an
  absent key is not.
- **Metrics.** The six parallel counts are discriminated by the shape
  of their `where` and asserted to distinct values, so a shared window
  or a missing open-filter cannot pass; the top-controls join is one
  batched lookup with a `|| ''` fallback for a control deleted between
  the two queries; the top-linked-entity aggregation stays pushed down
  to a `groupBy` with `take: 5`.

## Decisions

- **Frozen clock.** `jest.useFakeTimers({ now })` rather than
  tolerance assertions. The `next7d` window width is then asserted
  *exactly* — a `7 * 60 * 60 * 1000` typo in place of
  `7 * 24 * 60 * 60 * 1000` fails here, where a "within 5 seconds of
  now" assertion would wave it through. Same for the 30-day trend
  look-back and every `completedAt` stamp.

- **Two characterization tests, deliberately labelled.** Two live
  inconsistencies are pinned rather than fixed, because a coverage
  wave is the wrong PR to change behaviour in:

  1. **CANCELED counts as completed work.** `isTerminalStatus`
     includes CANCELED, so `setStatus(…, 'CANCELED')` stamps
     `completedAt`. But `farmTaskTrendRows` documents the opposite in
     its own docblock ("`completedAt` is only set on RESOLVED /
     CLOSED (never CANCELED), so a non-null `completedAt` is exactly
     completed work") and `metrics().trend.resolved30d` counts on
     exactly that assumption — so a cancelled task currently lands in
     the dashboard's "resolved" series. Note that the two *linked-task
     counters* in the same file get this right (they test the status
     explicitly), which is what makes the divergence easy to miss.
  2. **`bulkSetStatus` never clears `completedAt`.** `setStatus`
     clears it on a re-open; the bulk path cannot, because it has no
     per-row read. The asymmetry is defensible — adding
     `completedAt: null` to the bulk non-terminal branch would wipe
     the real timestamps of rows already terminal in the selection —
     but it was undocumented and untested.

  Both tests carry a comment saying which side must change if the
  behaviour is fixed, so the divergence cannot drift on unnoticed.

- **Mutation check.** Six mutations, all caught on the first pass:

  | Mutation | Caught by |
  |---|---|
  | `_buildWhere` drops the `tenantId` filter | 7 tests, incl. both single-tenant isolation tests |
  | `listPaginated` **replaces** `where.AND` with the cursor | `listPaginated › APPENDS the cursor to an existing AND` (1) |
  | `_buildWhere` drops the direct-`controlId` arm for CONTROL | the CONTROL-link test + `countLinkedToControl` (2) |
  | `setStatus` stops clearing `completedAt` on a re-open | `setStatus › CLEARS completedAt when a terminal task is re-opened` (1) |
  | `update`'s existence pre-check loses its tenant scope | `tenant isolation › refuses to update a task belonging to another tenant` (1) |
  | `countLinkedToControls` counts CANCELED as done | the per-control done-tally test (1) |

  The fifth is the one wave 16 learned the hard way: mocking
  `findFirst` to `null` and asserting `update` was not called holds
  for *any* where-clause, so it proves "a missing row is refused" and
  not "the lookup is tenant-scoped". Every guard test here therefore
  also asserts the exact `findFirst` argument.

- **What was deliberately NOT covered.** Nothing in this file — it
  reaches 100% on all four axes. Nothing outside it either: the
  neighbouring `ControlRepository` (24 uncovered functions) and
  `executor-registry.ts` (113, already owned by PR #446) are separate
  waves. One file per wave keeps the mutation check honest.
