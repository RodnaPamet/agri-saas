# 2026-09-01 — outbox photo attribution (#786)

**Commit:** `<pending>` fix(offline): bind a queued photo to the operator who queued it

## Design

`OutboxItemBase` carries `queuedByUserId`. Two functions build items over it —
`enqueue` (mutations) and `enqueuePhoto` (photos) — and only `enqueue` ever
stamped the field. Both read sites gate on the field being **present**:

```ts
sync.ts          if (ownerUserId && item.queuedByUserId && item.queuedByUserId !== ownerUserId)
outbox-state.ts  Boolean(owner && i.queuedByUserId && i.queuedByUserId !== owner)
```

An absent stamp is therefore not a weaker binding, it is **no binding at all**:
the item is never skipped by `flushOutbox` and never counted in
`snapshot.foreign`. On a shared device, A's queued photo uploads under B's
session into a hash-chained audit trail, and nothing surfaces it as held.

The fix hoists the stamp into one module-private helper, `attribution()`, used
by both literals. That shape is chosen over adding a field to
`EnqueuePhotoInput` deliberately — see Decisions.

## Files

| file | role |
|---|---|
| `src/lib/offline/outbox.ts` | `attribution()` helper; both item literals spread it |
| `tests/unit/offline/outbox-user-binding.test.ts` | enqueue cases driven from one `ENQUEUE_PATHS` table; two photo-consequence cases |
| `CLAUDE.md` | the section documented the defect as current behaviour |

## Decisions

- **`enqueuePhoto` resolves the id itself rather than taking it on
  `EnqueuePhotoInput`.** `enqueue` already does this internally and
  `EnqueueInput` has no user field, so an input field would have been a second
  pattern for one concept. It would also have to be *optional* — and an
  optional field that callers must remember to pass is the same defect class
  again. The sole caller (`use-offline-sync.ts` → `JournalPhotosTab`) has no
  attribution in hand and would have imported `getCurrentUserId` only to
  forward it.

- **One helper, not two correct call sites.** Two correct literals is the state
  this bug started from. The helper is the thing a third enqueue path cannot
  silently omit, because omitting it now looks like an omission rather than
  like nothing.

- **The helper returns a spreadable object, not a value.** The field must be
  ABSENT rather than `undefined` when nobody is signed in: `public/sw.js` reads
  these records raw out of IndexedDB, the localStorage store JSON-round-trips
  them, and both read sites test presence.

- **The enqueue tests are table-driven.** The defect was two paths over one
  base type drifting apart, so a suite that asserts on one path cannot catch
  it however thorough it is. `ENQUEUE_PATHS` makes a new path's absence from
  the table the visible thing.

- **Mutation-proved.** With the photo stamp reverted, exactly two tests fail:
  the table row for `enqueuePhoto` (`Expected: "usr_a", Received: undefined`)
  while the `enqueue` row still passes, and the consequence test showing
  `send` called once — i.e. the upload that would have been misattributed. A
  test that only asserted the field would have proved the stamp exists; the
  consequence test is what proves it *changes the flush*.

- **Scope: the page drain only.** The service worker's Background Sync drain
  calls `flushOutbox` with no owner, so it still replays everything. That is
  pre-existing and by design — the SW has no session to compare against — and
  the CLAUDE.md wording is kept honest about it rather than overclaiming.

- **A doc that was wrong became right.**
  `docs/implementation-notes/2026-08-19-outbox-user-binding.md` already claimed
  both paths stamped `queuedByUserId`. That was never true when written; it is
  true now. Left as-is rather than edited, since the claim it makes is the
  claim that now holds.
