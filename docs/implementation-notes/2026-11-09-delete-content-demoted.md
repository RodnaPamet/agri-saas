# 2026-11-09 — deleting `CONTENT_DEMOTED`

**Issue:** #2868. **Owner decision:** delete the enum value (2026-11-09),
chosen over leaving the refusal in place or building a ranking.

## Design

`CONTENT_DEMOTED` was a published moderation outcome that could never be
performed. There is no ranking in this product to demote within — the exchange
feed takes `status` plus the hiding columns as base predicates and orders by
`createdAt`, and the trends surface is computed from price aggregates rather
than a per-listing score — so a recorded demotion announced a sanction that
does not exist. #2865 made `actOnNotice` throw
`MODERATION_ACTION_NOT_PERFORMABLE` for it, which stopped the false Art 17
statement and left a value no caller could usefully send.

This deletes it across all four layers it lived at:

```
prisma enum ModerationActionKind   ─ value removed, type RECREATED
MODERATION_ACTION_KINDS (zod)      ─ value removed  → a sender now gets 400
ModerationActionKind (TS union)    ─ value removed  → old call sites not compilable
assertPerformable                  ─ the arm deleted; subject-pair arm remains
```

**The refusal did not disappear, it moved outward.** A caller sending
`CONTENT_DEMOTED` used to reach the usecase and get a 403
`MODERATION_ACTION_NOT_PERFORMABLE`; it now fails zod at the route and gets a
400 `invalid_request`. That is a worse error for a better contract, and it was
weighed: the only senders are the web console and the iOS mirror, neither of
which offers the outcome.

## Confirmation, before anything was written

#2868's own exit condition was *"someone has to confirm nothing sends it"*.
Measured on production 2026-11-09:

```
enum:              ACCOUNT_SUSPENDED,ACCOUNT_TERMINATED,CONTENT_DEMOTED,
                   CONTENT_REMOVED,CONTENT_RESTORED,NONE
actions_total:     0
by_kind:           (none)
statements_total:  0
```

Zero `ModerationAction` rows and zero `StatementOfReasons`, so no stored value
needed rewriting and no Art 17 statement referenced the outcome.

## Files

| File | Role |
|---|---|
| `prisma/schema/social.prisma` | value removed; the enum's docblock records WHY it went and why it must not come back without a ranking |
| `prisma/migrations/20261109100000_drop_content_demoted/migration.sql` | recreates the type; the `USING` cast goes via `text` |
| `deploy/rollback/20261109100000_drop_content_demoted.down.sql` | the inverse — restores the value in its ORIGINAL ordinal position |
| `src/lib/schemas/index.ts` | `MODERATION_ACTION_KINDS` narrowed, with the 400-vs-403 consequence stated |
| `src/app-layer/usecases/moderation.ts` | union member, the refusal arm, and three comments |
| `src/lib/openapi/paths/moderation.paths.ts` | both descriptions — the published contract is what a client reads |
| `tests/guards/moderation-action-kinds-mirror.test.ts` | its worked example became history; `CONTENT_RESTORED` is now the only live divergence |
| `tests/integration/moderation-content-removal.test.ts` | the refusal case REPLACED, not deleted |

## Decisions

- **Postgres cannot drop an enum value, so the type is recreated** — rename,
  create, `ALTER COLUMN ... USING (col::text::newtype)`, drop the old. One
  column uses the type (`ModerationAction.actionKind`). Routing the cast
  through `text` is what makes it safe rather than merely working: a row still
  holding the dropped value fails the cast and aborts the transaction, instead
  of being silently remapped to whatever sits at the same ordinal. With zero
  rows it rewrites nothing, and the safety matters for the rollback path and
  for any environment whose data nobody measured.

- **`CONTENT_RESTORED` is KEPT, and it is not the same case.** It is a real
  stored value written by the restore route (#2867) and is deliberately absent
  from `MODERATION_ACTION_KINDS` because a restore is addressed by the ACTION
  id of the removal it reverses, not recorded as a fresh decision on a notice.
  So the enum legitimately holds a value the input schema refuses — which is
  exactly the divergence `moderation-action-kinds-mirror` exists to police, and
  it is the only one left.

- **An inverse script was required, and not because the previous image
  breaks loudly.** `destructive-migration-has-inverse` derives its population
  by scanning for `DROP TYPE` / `RENAME TO`, so this migration is in it by
  construction. The honest account of the risk is in the script: the previous
  image's `assertPerformable` still refuses the value before any write, so the
  write path degrades gracefully; what does not is the enum round-trip, since
  that client deserialises `actionKind` into a list containing a value the
  database no longer declares. Restoring the type removes the question.

- **The value is restored in its ORIGINAL ORDINAL POSITION** by the rollback —
  third, between `CONTENT_REMOVED` and `ACCOUNT_SUSPENDED`. Prisma diffs an
  enum as an ordered list, so appending it would leave `prisma migrate diff`
  reporting a permanent difference, which is the kind of standing noise that
  teaches people to ignore a drift check.

- **The behavioural test was REPLACED rather than deleted.** The property it
  protects is unchanged — a demotion must never be recorded — so the case now
  asserts the value is absent from both the zod list and the generated client
  enum, with a positive control on `CONTENT_REMOVED` so an empty or broken
  import cannot satisfy it. Deleting the case would have removed the only
  statement in the suite about why this outcome does not exist.

- **The TS union alone is not the protection.** Removing the member makes the
  old call un-writable in the suite, which is real and is why the test asserts
  at the other two layers as well: `tsc` says nothing about a value arriving
  over HTTP.

- **The dated note for #2865 was annotated, not corrected.**
  `2026-11-08-moderation-content-removal.md` argued for refusing rather than
  deleting, and that is still the right account of what shipped that day. It
  carries a SUPERSEDED pointer here rather than a rewrite — and its
  reversibility argument held exactly as made: the refusal bought the time in
  which somebody measured the row count.

- **Not built: the ranking.** It remains the proportionate answer to content
  that is unpleasant rather than unlawful, which is most of what a notice queue
  holds. It needs a per-listing score the feed orders by, which is a
  marketplace product decision. The enum's docblock says so at the point where
  somebody would be tempted to re-add the value.
