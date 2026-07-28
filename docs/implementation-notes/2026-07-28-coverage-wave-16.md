# 2026-07-28 — Coverage wave 16: the vendor repositories

**Commit:** _(this PR)_

`VendorRepository` was the densest uncovered file in
`src/app-layer/repositories` — **129 uncovered branches at 7.2%**. This wave
takes it to **71.94% branches / 98.27% statements / 100% functions**.

Repositories are where the multi-tenant isolation invariant physically lives
("every repository query must filter by `tenantId`"), so an untested
repository is an untested security boundary. That framing drove which tests
got written.

## Files

| File | Role |
|---|---|
| `tests/unit/repositories/vendor-repository.test.ts` | new — 33 tests over `VendorRepository`, `VendorDocumentRepository`, `VendorLinkRepository` |

## What is asserted

The **query the repository emits**, not Prisma's behaviour — the boundary
contract this code actually owns. `db` is a recording double; the pagination
helpers (`clampLimit`, `buildCursorWhere`, `computePageInfo`) run for real,
because their interaction with the repository is part of what is under test.

- **Tenant isolation.** Every read is scoped, asserted against *two* different
  tenants so a hard-coded or cached id cannot pass. `update`, `setStatus` and
  both `deleteById`s guard with a tenant-scoped `findFirst` and then mutate by
  **bare id** — that lookup is the only thing standing between a leaked id and
  a cross-tenant write, so each is covered on both the refusal and the success
  path.
- **Filter translation.** Status and criticality pass through; `riskRating`
  becomes an `assessments.some` sub-query; `q` fans out to a
  case-insensitive OR over name / legalName / domain; `reviewDue` maps to a
  strictly-past `lt` or a both-ends-bounded 30-day window.
- **Cursor pagination.** Over-fetch by one and trim, clamp an oversized limit
  to `MAX_LIMIT`, default a missing one, merge the cursor predicate *alongside*
  the tenant filter, and ignore an unparseable cursor rather than 500-ing a
  bookmarked URL.
- **Write payloads.** Create defaults (`ONBOARDING`, `MEDIUM`, `JsonNull`),
  blank-string-to-null and date-string-to-`Date` coercion, partial-update
  semantics, and the document `folder` trim/null rule (the group-by code keys
  on `null`, so `'   '` must not become a phantom folder).

## Decisions

- **The mutation check found two holes in the tests, not the code.** Four
  mutations were applied; on the first pass only two were caught:

  | Mutation | First pass | After |
  |---|---|---|
  | tenant filter dropped from `_buildWhere` | caught (4 tests) | caught |
  | update existence check unscoped | **missed** | caught |
  | `name` spread unconditionally on update | **missed** | caught |
  | folder null-coercion dropped | caught (2 tests) | caught |

  Both misses were the same class of mistake. The isolation tests mocked
  `findFirst` to return `null` and asserted `update` was not called — which
  holds for *any* where-clause, so they proved "a missing row is refused"
  rather than "the lookup is tenant-scoped". They now assert the where-clause
  itself. The partial-update test supplied `name`, so a conditional spread and
  an unconditional `name: data.name` produce identical payloads; the mutation
  only bites for a field the caller **omits**, so a second test now changes a
  different field and asserts `name` is absent entirely.

  This is the argument for running the mutation check rather than trusting
  coverage: both weak tests executed the right lines and asserted a true
  thing, and coverage counted them.

- **Line 70 left uncovered deliberately.** `listPaginated` has an
  `if (where.AND) push(...) else where.AND = [...]` merge, but `_buildWhere`
  never sets `AND`, so the push arm is unreachable from any caller. Writing a
  test for it would mean constructing a state the code cannot produce.

## Remaining gap

Ranking for wave 17 by absolute uncovered branches in the `global` group:

| Area | Uncovered branches | Files | Branch % |
|---|---|---|---|
| `src/components/ui` | ~2,400 | 546 | 61.2% |
| `src/app` | 1,719 | 111 | 51.7% |
| `src/app-layer/repositories` | ~760 remaining | 47 | — |
| `src/app-layer/jobs` | 626 | 51 | 68.2% |

Within repositories the next densest are `JournalRepository` (107 uncovered,
29.1%) and `ProcessMapRepository` (94, 30.9%). Both are larger files than
`VendorRepository` but the same shape — static methods over an injectable
`db` — so the harness in this file transfers directly.
