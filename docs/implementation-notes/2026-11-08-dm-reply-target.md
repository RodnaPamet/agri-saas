# 2026-11-08 — a reply target for a direct message (#2829, schema stage)

**Commit:** `<pending>` feat(social): DirectMessage.replyToMessageId

## Design

`DirectMessage.replyToMessageId String?`, self-referential, `ON DELETE SET
NULL`, with a partial index — plus a TRIGGER refusing a target in a different
conversation.

```
  INSERT / UPDATE OF replyToMessageId, conversationId
        │
        ▼
  direct_message_reply_same_conversation()   BEFORE, FOR EACH ROW
        │
        ├─ NEW.replyToMessageId IS NULL          → RETURN NEW   (the common case)
        ├─ target in the SAME conversationId     → RETURN NEW
        └─ otherwise                             → RAISE 23514
```

Schema only. P8's rule — schema one release ahead of its writer — applies
cleanly here, unlike P8.6's link-card columns: those were the recorded
exception because declaring a field in `ENCRYPTED_FIELDS` creates an obligation
to sanitise it by name at a write path a schema-only stage does not have.
`replyToMessageId` is an id. Nothing to encrypt, nothing to sanitise.

## Files

| file | role |
|---|---|
| `prisma/migrations/20261108140000_dm_reply_target/migration.sql` | the column, the FK, the partial index, the trigger |
| `prisma/schema/social.prisma` | the field and the reasoning |
| `src/app-layer/usecases/personal-data-export.ts` | the pointer reaches the Art 15 export |
| `tests/integration/dm-reply-target.test.ts` | NEW — six cases at the database |
| `tests/guards/conversation-columns-are-counterparty-safe.test.ts` | the note the new column needs |
| `tests/guards/no-self-referencing-models.test.ts` | the exemption, with the reason |

## Decisions

- **A TRIGGER, because a CHECK cannot do it.** The harm is a crafted request
  quoting a message from a conversation the sender is not in, so the reply
  preview decrypts it for somebody with no right to it. The FK alone only
  requires the target to EXIST. Postgres forbids a subquery in a CHECK and the
  comparison is between two rows, so a trigger is the only database mechanism
  available. #2829 offered "a WITH CHECK or a usecase assertion"; the write
  path is PRIVILEGED (P8.2), so a database guarantee is worth more than an
  assertion in one caller.

- **NOT `SECURITY DEFINER`.** P8.2 recorded why one is a trap here: the `role`
  GUC does not change inside a definer function, so `superuser_bypass` never
  applies and what actually carries the write is the definer's `rolsuper` — a
  role attribute nobody declared, which breaks silently the day the app role
  is hardened. This trigger needs no privilege crossing: it reads the table the
  inserting transaction is already writing.

  That also makes it STRICTER under a user context than under the privileged
  one. Privileged, it sees every row and the check is conversation equality.
  Under `app_user`, `direct_message_select` filters the lookup, so a target in
  a conversation they are not in is invisible, the EXISTS fails, and the insert
  is refused — the same refusal by a different route, and the stricter
  direction is the right one for a control to lean.

- **SQLSTATE 23514.** It IS the check a CHECK would have been, and a caller
  should not have to learn a second code for it.

- **The test reads the SQLSTATE through RAW SQL, not a Prisma error shape.**
  Prisma reports a trigger as a FOREIGN KEY violation through its model API —
  measured in this repo before — so an assertion on the Prisma error would
  describe a constraint that does not exist.

- **`ON DELETE SET NULL`, not CASCADE.** A deleted message keeps its row, so
  this path is rare rather than absent; what it decides is the case where a
  target really does go, and CASCADE would delete somebody else's message
  because the thing it quoted was deleted. SET NULL loses the pointer and keeps
  the reply.

- **`BEFORE INSERT OR UPDATE OF …`, and the UPDATE arm is not padding.** An
  INSERT-only trigger is walked straight past by an edit that sets the pointer
  afterwards — a one-line omission with the same consequence as having no
  trigger. There is a case for it.

- **The FK fires second, which the test asserts rather than assumes.** A reply
  to an id nothing has answers 23514 (the trigger) rather than 23503 (the FK),
  because the trigger is BEFORE. Both refuse; the code says which did, and
  which constraint speaks first is exactly what a reader would guess wrong.

- **`replyToMessageId` IS exported.** #2863's ruling excludes ids, and this is
  one — but that line is about an identifier for an entity OTHER PEOPLE belong
  to (a farm) or for a farm record. This names another message in the same
  conversation, one the trigger guarantees is in it and one they could already
  read, and `id` + `conversationId` are exported for these rows anyway.
  Without it an exported reply is a bare sentence with nothing to answer.

- **The self-reference guard gets an exemption, not a widening.** Its concern
  is a bulk writer having to topologically sort its own rows, and this edge
  cannot produce that: a reply is written one message at a time by a person who
  read the target in order to reply to it, there is no importer for this table,
  and the edge is one hop with no transitive walk anywhere — so no depth to
  recurse and no cycle to detect.

## What the code stage still owes (#2829 steps 2-4)

The gesture, its focusable sibling, and the rendered test under a coarse
`matchMedia`. Step 2's caveat is already discharged: `<SwipeRow>` asked a
viewport question while its docblock argued for a pointer one, and #2828 fixed
that.

The quoted preview must render «Съобщението е изтрито» for a reply to a deleted
message rather than the original body — the soft-deleted row still contains it
until a retraction overwrites it.
