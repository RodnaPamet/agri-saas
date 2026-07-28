# 2026-07-28 — Coverage wave 17: the journal repository

**Commit:** _(this PR)_

`JournalRepository` at **107 uncovered branches / 29.1%**, taken to **85.43%
branches / 89.58% statements / 93.54% functions**. Same harness as wave 16 —
assert the query the repository emits, `db` as a recording double, pagination
helpers left real.

## Files

| File | Role |
|---|---|
| `tests/unit/repositories/journal-repository.test.ts` | new — 46 tests |

## The two contracts that carry the weight

**Soft delete is a quiet failure mode.** Every live read path filters
`deletedAt: null`. Drop it and nothing throws — deleted journal entries simply
reappear in the list. It looks like working software, which is precisely why it
needs an *executing* test rather than a structural guard. Covered on all four
surfaces: `list`, `getById`, the paginated branch, and the deliberate inverse —
`getByIdWithDeleted` must NOT filter, or the trash can becomes permanently
un-restorable.

**The nested-create tenantId asymmetry.** In `createLogEntry`, the `locations`
and `equipment` join rows pass `tenantId` explicitly, while `quantities` and
`plantings` must **not** — Prisma populates those from the parent's composite
`[logEntryId, tenantId]` relation FK and rejects the argument outright
("Unknown argument tenantId"). This is documented in comments but was
unenforced: a tidy-up making all four nested creates look alike breaks journal
creation at **runtime**, not compile time. Now pinned on both the create and
the update path.

Also covered: the cross-tenant `valid*Ids` validators (what stops a caller
attaching another tenant's location / equipment / parcel to their own entry),
the crop multi-select's trim-and-drop-empties handling, half-open vs closed
date ranges, full-replace child-collection semantics, file-link tenant scoping,
and the `clientMutationId` lookup the offline outbox relies on for
exactly-once replay.

## Decisions

- **Repository-level tenant guards are absent by design here.** `softDelete`,
  `restore` and `purge` mutate by bare `id` with no tenant filter and no
  existence check — unlike `VendorRepository`, which guards inline. Verified
  before writing: all three callers in `usecases/journal.ts` first run the
  tenant-scoped `getById` / `getByIdWithDeleted` and throw `notFound`, with RLS
  as the database backstop. The tests pin the repository's actual contract and
  carry a comment naming that dependency, so a future refactor that removes the
  usecase check cannot do so believing the repository is self-defending.
- **Line 165 left uncovered deliberately** — the same unreachable
  `if (where.AND) push(...)` merge arm as `VendorRepository`, since
  `_buildWhere` never sets `AND`.
- **Four mutations, each caught by the intended test**: dropping the
  soft-delete filter, removing `deleteMany: {}` (turning replace into append),
  removing the crop `.trim()`, and dropping `deletedAt: null` from
  `validEquipmentIds`.

## A note on the local guardrail sweep

`tests/guards` + `tests/guardrails` reports **619/619 suites passing** — but
that is *not* evidence the RLS guardrail is healthy. `rls-coverage.test.ts:78`
reads `const describeFn = DB_AVAILABLE ? describe : describe.skip`, so the
whole suite silently sits out when the database is unreachable. Earlier in the
same session it *failed* six tests against a reachable-but-stale dev DB; it now
skips because host port 5434 is held by a different checkout's test database.

Worth flagging as its own hazard: a check that silently does not run is
indistinguishable from a check that passed — the same shape as the coverage
gate never running on pull requests (#398).
