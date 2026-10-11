# 2026-10-12 — the deletion freeze (#1655)

**Commit:** pending

## Design

The privacy notice shipped in #1648 promised something the code did not do.
`privacy.deleteRequest`, both locales:

> "When you do, we sign you out everywhere and **your account stops being
> visible to other farms straight away**."

The first clause was true. The second was not: `requestAccountDeletion` wrote
`deletionRequestedAt`, bumped `sessionVersion` and revoked sessions, and
`deletionRequestedAt` was read by **nothing** outside the erasure path.

Two halves, two mechanisms, one claim:

| half | mechanism | where |
|---|---|---|
| no new content | `isDeletionPending` → `ACCOUNT_DELETION_PENDING` | the `withApiErrorHandling` mutation choke point |
| not visible to other farms | `ExchangeListing.suppressedForDeletionAt` | set at request, cleared at cancel; filtered in four reads |

## Files

| file | role |
|---|---|
| `prisma/schema/exchange.prisma` + migration | the nullable suppression column and a partial index on the suppressed rows |
| `src/lib/auth/deletion-pending.ts` | the cached verdict, and the fail directions |
| `src/lib/errors/api.ts` | the freeze at the choke point, and the exempt prefixes |
| `src/app-layer/usecases/account-erasure.ts` | suppress / restore; `requestAccountDeletion` collapsed to a delegation |
| `src/app-layer/repositories/exchange.ts` | the browse filter |
| `src/app-layer/usecases/exchange.ts` | the deep link and the inquiry path |
| `src/app-layer/usecases/exchange-messaging.ts` | `openExchangeThread` |
| `tests/integration/p5-6b-deletion-freeze.test.ts` | suppression and restore, through the real browse query |
| `tests/unit/deletion-freeze-blocks-mutations.test.ts` | the freeze, and that the way out is never frozen |
| `tests/unit/deletion-pending-cache.test.ts` | the verdict and both fail directions |
| `tests/guards/privacy-notice-freeze-is-enforced.test.ts` | the claim and the enforcement, as a biconditional |

## Decisions

- **A prefix exemption, not nine per-route opt-outs.** `/api/auth/` and
  `/api/account/` are categorically not content. The alternative needed a flag
  on `account/deletion` (both methods), `auth/logout`, `auth/token`,
  `auth/token/refresh` and the four native sign-in POSTs — and a forgotten flag
  does not fail a test, it strands a person inside the freeze. This file's own
  rate-limit comment records the same lesson from the other side: the mechanism
  was opt-in and 343 of 346 routes keyed `anon`.
- **`ACCOUNT_DELETION_PENDING`, never `ACCOUNT_SUSPENDED`.** P5.6b already ruled
  the two states apart; collapsing the codes would tell somebody who asked to
  leave that a moderator stopped them, and point them at an appeal instead of
  the cancel.
- **Not in `getSessionOrThrow`**, where P5.9's suspension check lives: that
  choke point governs reads, and both escape hatches resolve through it, so a
  check there would block the route out of the freeze —
  `slow-mode-escape-is-not-throttled`'s failure.
- **A separate column, not a fifth `ExchangeListingStatus`.** `WITHDRAWN` is the
  seller's own decision; overwriting it destroys what the restore needs and
  conflates a platform action with a human one.
- **`status: 'ACTIVE'` in the suppression's `where`.** The restore clears every
  row the column marks, so the suppression must mark only what it is
  responsible for hiding. Without it, cancelling resurrects listings the seller
  had taken down themselves — worse than the bug being fixed.
- **Fails OPEN on an unreadable database**, opposite to `isAccountSuspended`.
  P5.9's "failing closed is free" holds because that check guards a request that
  could not do its work anyway; this one runs before a handler that may be
  healthy, so failing closed would refuse every mutation on the platform during
  a blip. A missed block costs ~nothing for 30 days; a false one costs a field
  record.
- **Query-derivation was measured and rejected.** `ExchangeListing.sellerUserId`
  is a bare FK with no Prisma relation, no index covers it, and the `notIn`
  alternative is what P5.5b's raw anti-join exists to avoid. I had stated a
  preference for deriving and reported back when the shapes refused it. Related:
  #1325's no-sweep argument does **not** transfer — the past-due check runs on
  routes already holding the tenant, whereas this read is another farm's listing
  query, which never touches this person's row.
- **`requestAccountDeletion` delegates now.** It was a near-verbatim copy of the
  `OnTx` variant, so the suppression would have landed on one path only.
- **Both invalidations are directly awaited after the commit**, not
  `afterCommit`: these are bare `prisma.$transaction` calls, which open no
  scope. #1619 shipped that exact mistake and wrote zero rows.

## The test that was green and proved nothing

Worth recording because it is the sharpest instance of the pattern in this
repo's notes, and I wrote it.

`visibleToOthers` started as raw SQL that re-stated the filter:

```sql
WHERE "id" = $1 AND "status" = 'ACTIVE' AND "suppressedForDeletionAt" IS NULL
```

Seven cases passed. Then I deleted the production filter from the browse query
and **all seven still passed** — the helper was asserting that the column had
been written, which is the one thing the suppression obviously does, and nothing
about whether any reader honours it. A control that cannot express the failure is
green for ever.

Rewired through `ExchangeRepository.listActiveListings` — the method the
marketplace feed actually runs — the same mutation reddens 4 of 7, and dropping
the `status: 'ACTIVE'` guard reddens the restore-asymmetry case specifically.

The lesson generalises past this file: when the thing under test is *whether a
reader honours a column*, the assertion has to go through the reader. Re-stating
its predicate in the test is how you end up testing your own copy of the logic.

## Why the exit criteria missed it

#1597 asked whether the grace period is visible or frozen, the owner chose
frozen, and the option text named three behaviours: sessions revoked, no new
content, recovery by signing in. Only the first was built. The issue's **Exit**
list named none of them — it named export completeness, chain verification and
notice accuracy, all three of which were genuinely met.

So the gap was not an unnoticed failure; it was a decision recorded in a
comment thread and never promoted into a checkable criterion. When a ruling
picks a behaviour, the behaviour belongs in the exit criteria, or the only thing
holding it is whoever happens to remember the conversation.
