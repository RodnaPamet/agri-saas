# 2026-11-08 — CONTENT_REMOVED removes the content (#2865)

**Commit:** `<pending>` fix(trust-safety): CONTENT_REMOVED performs a removal

## Design

`ModerationActionKind` has five values. Before this, only the two account ones
did anything: `actOnNotice` branched on `actionKind` exactly once, to suspend.
`CONTENT_REMOVED` wrote a `ModerationAction`, moved the notice to ACTIONED and
performed nothing — and `statement-dispatch` then composed an Art 17 statement
of reasons from that very row and delivered «Премахнахме съдържанието.» while
the content stayed live and visible to everybody.

```
   POST /api/admin/moderation/notices { reportId, actionKind, rationale }
        │
        ├─ assertPerformable(actionKind, notice.subjectKind)   ← BEFORE any write
        │     CONTENT_DEMOTED                → refuse (nothing can demote)
        │     CONTENT_REMOVED on PROFILE/THREAD → refuse
        ▼
   prisma.$transaction
        ├─ ModerationAction.create
        ├─ ContentReport.update { status }
        ├─ CONTENT_REMOVED → removeSubjectOnTx
        │     LISTING  → ExchangeListing.removedByModerationAt = now
        │     MESSAGE  → ExchangeMessage.removedByModerationAt = now
        │     0 rows   → throw MODERATION_SUBJECT_GONE  ← rolls everything back
        └─ ACCOUNT_*  → suspendAccountOnTx (unchanged)
        ▼
   reads: the feed, the detail read, openExchangeThread, getExchangeThread
```

The property: **the outcome cannot be recorded without being performed.** That
is #1635's rule, which P5.9 applied to the account kinds and nobody applied to
the content kinds.

## Files

| file | role |
|---|---|
| `prisma/migrations/20261108120000_moderation_content_removal/migration.sql` | two nullable columns, and why neither reuses an existing one |
| `prisma/schema/exchange.prisma` | the columns and their docblocks |
| `src/app-layer/usecases/moderation.ts` | `assertPerformable`, `removeSubjectOnTx`, the call inside the transaction |
| `src/app-layer/repositories/exchange.ts` | the browse feed's base predicate |
| `src/app-layer/usecases/exchange.ts` | the detail read and the inquiry gate |
| `src/app-layer/usecases/exchange-messaging.ts` | `openExchangeThread`, and a removed message's body |
| `messages/{en,bg}/app.json` | both refusal codes, both locales |
| `tests/guards/listing-hiding-columns-are-filtered.test.ts` | NEW — every hiding column at every listing read |
| `tests/integration/moderation-content-removal.test.ts` | NEW — it performs, it refuses, and a refusal writes nothing |
| `tests/integration/exchange-private-conversations.test.ts` | a removed message serves no body |

## Decisions

- **A new column per table, not `status = WITHDRAWN` and not
  `suppressedForDeletionAt`.** That second one already hides a listing, and its
  own docblock refuses this use in advance: *"the restore clears exactly the
  rows this column marks, so a second, unrelated reason to hide a listing must
  NOT share it"*. Sharing it would let a seller cancelling an account deletion
  un-hide a listing a moderator removed. `WITHDRAWN` is the seller's own
  decision and overwriting it destroys what a restore needs (#1655 argues both).

- **NULLABLE, so a removal is reversible.** An Art 17 statement carries
  redress; a hard delete is the wrong primitive for a decision somebody may
  appeal. There is no restore ROUTE yet — #2867 — and a nullable timestamp is
  what keeps that a route to write rather than data to recover.

- **A refusal writes NOTHING, and the tests assert that rather than the
  throw.** A transaction that threw after writing the action row would satisfy
  "it refused" and leave exactly the state this issue is about, so every
  refusal case asserts an action count of zero and a notice still RECEIVED.

- **A removal that changes no rows REFUSES.** A notice can name an id nothing
  has — `captureSnapshot` records `SUBJECT_NOT_FOUND` for exactly that, and the
  reporter cannot tell it from success — so recording a removal against it
  would deliver a statement about content we never had. `NONE` stays available
  and is the honest answer there; the suite carries that as the control,
  because a gate that refuses every outcome is indistinguishable from one that
  works, and would be a worse compliance position than the defect.

- **Removing twice is idempotent.** Two notices about one listing is the
  ordinary case and the second moderator has to be able to close theirs.

- **`CONTENT_DEMOTED` is refused rather than deleted.** Nothing in this product
  can perform it: the exchange feed orders by recency and trends is computed,
  so there is no score to turn down. Deleting the value NARROWS a published
  enum — the OpenAPI contract and the iOS mirror both move — so it is #2868,
  and a refusal is reversible in a way a deleted enum value is not.

  > **SUPERSEDED 2026-11-09.** The owner chose deletion, and #2868 carried it
  > out — see `docs/implementation-notes/2026-11-09-delete-content-demoted.md`.
  > The reasoning above is why *this* change refused rather than deleted, which
  > is still the right account of what shipped on 2026-11-08; it is no longer a
  > description of the enum. The reversibility argument held exactly as stated:
  > the refusal bought the time in which somebody confirmed that production
  > held zero `ModerationAction` rows.

- **A removed message renders exactly like a deleted one.** Telling the
  counterparty WHICH it was would disclose a moderation action to a third party
  that nothing requires it to know, and the notifier is already answered by
  their own report status. The author is told by the Art 17 statement. The
  columns stay separate in the row, because a platform removal must survive a
  later self-delete and the statement is about ours rather than theirs.

- **The seller's own management view is NOT filtered**, the same asymmetry
  #1655 settled: hiding it from them would read as "already gone" at the moment
  they are deciding whether to appeal. Marking it as removed in that view is
  worth doing and is not here.

- **The GUARD is the durable part.** #1655's sweep found four read paths,
  including one — `openExchangeThread` — that filtered on `id` alone, so a
  saved link could start a conversation against a listing the feed had already
  stopped showing. Nothing held that sweep, so a third cause to hide a listing
  would have been a third manual sweep of a population nobody printed.
  `listing-hiding-columns-are-filtered` derives all ten listing reads from the
  filesystem, keyed by file and enclosing symbol, and requires each to honour
  every hiding column or carry a written reason not to. Five do; five may see
  hidden listings for reasons each entry states — a plan-limit count, the
  expiry sweep, the Art 15 export, the moderation snapshot, and the seller's
  own view.

- **Two fixtures were green on a false premise.** `moderation-audit-chain` and
  `p5-4a-moderation-console` both filed notices against `listing-${randomUUID()}`
  — an id nothing had — and every test passed because nothing looked. They
  create real listings now. The console suite kept its `SUBJECT_NOT_FOUND`
  assertion by splitting out a `fileOneAgainstNothing` helper, and gained the
  control it was missing: a notice whose subject IS there must capture
  successfully, or "captureError is SUBJECT_NOT_FOUND" is satisfied by a
  capture path that never works for anybody.

- **Two mutations survived the first green run**, both on the message READ:
  dropping `|| m.removedByModerationAt` from the body and from the `deleted`
  flag reddened nothing, because the guard only checks the column is named in
  the file and no test read a removed message back. The case in
  `exchange-private-conversations` exists because of that, and found its own
  bug in the writing — `messages.at(-1)` picked up a message the control test
  above had sent into the same (idempotently reopened) thread.
