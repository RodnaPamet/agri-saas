# 2026-11-06 — P8.1: direct-message schema, person-scoped RLS, global-KEK body

**Issue:** #2795 (part of #1199, P8)

Schema only. P8's standing rule is that tables ship one release before the code
that writes them, so this lands four models, their policies and their
encryption classification, and no route, usecase, UI or flag. P5.1 (#1553) is
the worked precedent.

## Design

Four tenantless models in `prisma/schema/social.prisma`:

```
Conversation ──┬── ConversationParticipant   (one per person, + read cursor)
               └── DirectMessage ──── MessageReaction
```

Access is by **participation**, keyed on `app.user_id` — the variable
`runInUserContext` sets. Two people in a direct conversation may share no farm,
so there is no `tenantId` on any of these tables and no tenant to key on even
in principle. That is why P8.2's routes belong under `/api/social/`.

Writes to `Conversation` and `ConversationParticipant` are **privileged**:
opening a conversation writes the other person's participant row, which no
caller may forge. `DirectMessage` is the exception, and it carries the request
rule.

## Decisions

- **A policy on a table may not query that table.** The one-message request
  rule was first written as `NOT EXISTS (SELECT 1 FROM "DirectMessage" ...)`
  inside `direct_message_insert`'s WITH CHECK, with a comment arguing that a
  WITH CHECK resolves its own table through the SELECT policy and so does not
  recurse. Postgres answered `ERROR: infinite recursion detected in policy for
  relation "DirectMessage"` and refused **every** insert.

  What caught it was the **positive control** — "admits the FIRST message into
  a fresh request". All three `REFUSES ...` tests passed while the rule
  enforced nothing, because nothing could insert at all. A suite of
  only-negatives would have shipped this green, which is the standing reason
  this repo pairs every refusal with the same operation by somebody entitled
  to it.

  The rule now reads `Conversation.lastMessageAt IS NULL`. That makes the
  column load-bearing for a security property rather than a cache, and its
  docblock says so: a change that stopped stamping it would silently let a
  stranger send without limit.

- **`ConversationParticipant` admits the caller's own row only**, for the same
  recursion reason: a policy admitting "every participant of a conversation I
  am in" must ask this table whether I am in it. Nothing needs it wider — the
  counterparty is read off a message, exactly as P5.2b reads it off an exchange
  thread, and that is asserted rather than left as an argument.

- **A block is NOT enforced in SQL, and the reason is a consequence of the
  above.** With the participant policy narrowed to the caller's own row, SQL
  cannot name the counterparty, so a WITH CHECK clause asking "has the
  counterparty blocked me" would be **vacuous** — the subquery returns only the
  caller. A vacuously-true clause that reads as a control is worse than no
  clause, so there is none. Blocks are enforced in the usecase (P8.2) through
  the existing bidirectional `personBlockExists`, and the silence is preserved
  by the 404.

- **`DirectMessage.body` is under the GLOBAL KEK**, with `ExchangeMessage` as
  the precedent in this same domain: a two-party row under either party's DEK
  is unreadable by the other — measured on production, where the recipient of
  the only live exchange thread saw `v2:…` where the text should be.

- **The privacy registry's "second owner" property had to widen, and that is
  the interesting part.** `personal-data-registry-complete` proved "somebody
  else owns this row too" by looking for a `*TenantId` column — sufficient
  while every shared row in this product was commercial. A direct
  conversation's second owner is a **person**, named in
  `ConversationParticipant`.

  Under the narrow property the only available classification was
  `DELETE_ROW`, which the sibling assertion calls out by name as destroying "a
  counterparty's conversation" — so the narrow property would have forced
  exactly the mistake its neighbour forbids. The widening is derived (a model
  qualifies by hanging off `Conversation`), not an allowlist, and is
  mutation-proved: flipping `MessageReaction` to `PSEUDONYMISE_COLUMN` reddens
  it.

  Erasure and export are both driven by the registry — `account-erasure.ts`
  iterates it and resolves a delegate by camelCasing the model name — so the
  four entries wire both consumers with no code change.

- **`MessageReaction` is `DELETE_ROW`**, unlike its three siblings: a reaction
  is a statement BY the person and IS the whole row, so deleting it destroys no
  second owner's record. Pseudonymising would be worse than useless —
  `@@unique([messageId, userId, emoji])` forces a per-user random id, leaving
  an anonymous reaction nobody can remove.

- **`emoji` is deliberately not free text.** A reaction is delivered by push,
  and `push-payload-carries-no-free-text` (#1999) exists because a task
  assignment put a farmer's own prose into `aps.alert.body`, which Apple reads.

## Files

| file | role |
|---|---|
| `prisma/schema/social.prisma` | the four models |
| `prisma/schema/enums.prisma` | `ConversationState` |
| `prisma/migrations/20261106200000_p8_1_direct_messages/migration.sql` | tables, indexes, FKs, 13 policies |
| `src/lib/security/encrypted-fields.ts` | `DirectMessage.body` |
| `src/lib/db/encryption-middleware.ts` | `DirectMessage` in `GLOBAL_KEK_MODELS` |
| `src/lib/privacy/personal-data-registry.ts` | four entries, export + erasure |
| `tests/guardrails/rls-coverage.test.ts` | four `PARTY_SCOPED_MODELS` entries |
| `tests/guards/personal-data-registry-complete.test.ts` | the widened second-owner property |
| `tests/integration/p8-1-direct-message-rls.test.ts` | 19 cases, both refusal shapes, controls in both directions |

## The mutation proof

Policies mutated in the base test database, which the per-worker clone is
templated from; each reddened a distinct set and the restore returned 19/19.

| mutation | reddens |
|---|---|
| drop the `lastMessageAt IS NULL` clause | *REFUSES a second message while the conversation is still a request* |
| drop the `senderUserId = app.user_id` conjunct | *REFUSES a message that names somebody else as its sender* |
| widen `direct_message_select` to `TRUE` | *a participant sees its messages and an outsider sees none* |
| widen `message_reaction_delete` to `TRUE` | *cannot be removed by somebody who did not write them* (and its control, which the widened policy lets the earlier case consume) |

One trap worth recording for anyone repeating this: **editing an already-applied
migration does nothing locally.** `globalSetup` runs `prisma migrate deploy`
against a per-checkout base database, so a corrected migration whose name is
already in `_prisma_migrations` is skipped, and the per-worker clone is
templated from that stale base. Dropping the objects and the migration row, then
letting globalSetup re-apply, is both the fix and a check that the file applies
from scratch the way CI will apply it.
