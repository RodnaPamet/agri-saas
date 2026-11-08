# 2026-11-08 — a removal can be reversed (#2867)

**Commit:** `<pending>` feat(trust-safety): POST /api/admin/moderation/restore

## Design

#2865 made `CONTENT_REMOVED` stamp `removedByModerationAt`, nullable precisely
so an upheld appeal could clear it. **Nothing could clear it** — the only route
was a DBA running an UPDATE, which is the gap `liftSuspension` closed for the
account kinds (#1676): reversible in the data long before it was reversible
through an interface.

```
  POST /api/admin/moderation/restore { actionId, rationale }
        │
        ├─ action missing            → MODERATION_ACTION_NOT_FOUND
        ├─ actionKind ≠ CONTENT_REMOVED → MODERATION_ACTION_NOT_REVERSIBLE
        ├─ resolveContentRecipient(subject)   ← BEFORE the transaction (#1191)
        ▼
  prisma.$transaction
        ├─ readRemovalState
        │     gone     → MODERATION_SUBJECT_GONE   (writes nothing)
        │     visible  → return                    (writes nothing)
        │     hidden   ↓
        ├─ clearRemovalOnTx           removedByModerationAt = null
        └─ ModerationAction.create    CONTENT_RESTORED, same reportId, same subject
        ▼
  appendPlatformAuditEntry  MODERATION_CONTENT_RESTORED   (after commit, best-effort)
  queueStatementForAction   the Art 17 follow-up
```

## Files

| file | role |
|---|---|
| `prisma/migrations/20261108160000_moderation_content_restored/migration.sql` | two additive enum values and why each is additive |
| `prisma/schema/social.prisma` | `ModerationActionKind.CONTENT_RESTORED` |
| `prisma/schema/audit.prisma` | `PlatformAuditAction.MODERATION_CONTENT_RESTORED` |
| `src/app-layer/usecases/moderation.ts` | `restoreRemovedContent`, `readRemovalState`, `clearRemovalOnTx` |
| `src/lib/schemas/index.ts` | `RestoreContentSchema` |
| `src/app/api/admin/moderation/restore/route.ts` | NEW |
| `messages/{en,bg}/app.json` | the Art 17 action line plus two refusal codes |
| `tests/guards/moderation-action-kinds-mirror.test.ts` | NEW — the subset relationship |
| `tests/integration/moderation-content-restore.test.ts` | NEW |

## Decisions

- **Keyed on the ACTION, not the subject.** `removedByModerationAt` carries no
  record of WHICH decision set it, so a restore addressed by subject could
  un-hide a listing no appeal ever concerned. Reading the subject off the
  action row is the same refusal P5.4a makes for `actOnNotice` — *"a
  caller-supplied subject would let an action be recorded against content it
  was not about"*.

- **A SECOND action row, never a mutation of the first.** #1619 appends a chain
  entry per action, so rewriting the original's kind would leave
  `PlatformAuditLog` asserting a decision the table no longer holds — and
  `platform_audit_log_immutable` would refuse the correction anyway. Art 17
  owes a statement per decision, and an appeal history is what an appeal
  process is for.

- **Its own `PlatformAuditAction` value**, by the enum's own pairing argument:
  `ACCOUNT_SUSPENDED` / `ACCOUNT_SUSPENSION_LIFTED` are paired because *"a
  suspension history that recorded only the suspensions would show every
  account as still suspended"*. A moderation history that recorded only
  removals would show every removed listing as still removed, with the
  reversal visible only by parsing a deliberately thin `detailsJson`.

- **`CONTENT_RESTORED` is NOT in `MODERATION_ACTION_KINDS`.** A restore
  reverses a decision rather than being one, so the notices route must refuse
  it — otherwise a caller could record a restore against a notice that asked
  for a removal, and skip the thing that makes it a restore. Same shape as
  `ReportSubjectKind.ACCOUNT`, and `moderation-action-kinds-mirror` now holds
  the list as a strict subset with the difference named. **Nothing compared
  those two before**, which is the other half of what this PR adds.

- **Idempotence writes nothing, and that is the opposite of #2865's rule.**
  Restoring twice succeeds and reports `restored: false` with no second action
  and no second statement: one removal keyed on one action is ONE appeal.
  #2865 made the opposite call for removals, because two notices about one
  listing are two genuine decisions and both need their row. The distinction is
  what is being counted — decisions there, appeals here — and a row per call
  would put an unbounded number of identical "we have restored it" letters in
  front of one person.

- **The notice stays ACTIONED.** It WAS acted on, and the action was later
  reversed, which is what the second row records. Moving it back to RECEIVED
  would put a decided notice into the triage queue and ask a moderator to
  decide it again.

- **`resolveContentRecipient` runs BEFORE the transaction.** It reads through
  the global client, so calling it inside an open transaction would want a
  second pool connection while the first is held — #1191's P0.8 deadlock at
  `PG_POOL_MAX` 12. It needs only the subject, which the action row already
  gave us.

- **`readRemovalState` is recorded as a read that MAY see hidden listings**,
  and the entry says the sharper half: it deliberately does not consult
  `suppressedForDeletionAt` either, because a seller mid-account-deletion has a
  listing hidden for a cause this verb has no business touching. A restore
  clears its own column and leaves that one alone.

- **The Edge needed no change**, which is worth stating rather than assuming:
  `/api/admin/moderation/` is already a `PUBLIC_PATH_PREFIXES` entry from
  P5.4a, so an `x-platform-admin-key` request reaches the handler. A route
  added under an unopened prefix is the seventh instance of that class in this
  repo.

## Verification

Six mutations, all caught: the column never cleared, the reversibility check
removed, the idempotent early return removed, a gone subject tolerated, the
follow-up statement skipped, and the restore writing `CONTENT_REMOVED` instead.

Every refusal case asserts the ABSENCE of a second action row — not merely that
the call threw. A transaction that threw after writing would satisfy "it
refused" and leave an extra "we have restored it" letter queued to somebody.
And the refusals are paired with a control that still restores something,
because a verb that refused everything would satisfy all of them and an appeal
process that can never succeed is worse than the gap this was filed for.

**The new guard file needed a module-level selector.** Written with its
selecting inline inside `it()`, it made the file `NOT AUDITED` — a population
with a ceiling of 200 — so the count went 200 → 201 and
`selector-teeth-reports-its-denominator` failed, exactly as P8.3 recorded.
`unclassifiedKinds` is extracted and carries a control on synthetic inputs,
because the live populations are correctly classified and nothing real
exercises the finding branch.
