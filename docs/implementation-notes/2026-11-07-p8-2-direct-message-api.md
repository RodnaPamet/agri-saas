# 2026-11-07 — P8.2: the direct-message API

**Issue:** #2796 (part of #1199, P8). Schema is P8.1 (#2795).

Seven routes under `/api/social/`, one usecase, six request schemas, one
OpenAPI module. No UI — P8.3 and P8.4 own that.

## Design

```
POST   /api/social/conversations                      open from a farm handle
GET    /api/social/conversations/{id}                 read one, with messages
POST   /api/social/conversations/{id}/messages        send
POST   /api/social/conversations/{id}/respond         accept / decline
POST   /api/social/conversations/{id}/read            move the read cursor
PATCH  /api/social/messages/{id}                      edit
DELETE /api/social/messages/{id}                      delete (soft)
POST   /api/social/messages/{id}/reactions            react
DELETE /api/social/messages/{id}/reactions            un-react
```

All gated on `social.direct-messages`, a string LITERAL at each call site
because `social-routes-flag-gated` extracts literals only — a `const` is
findable by a human and not by the guard.

## Decisions

- **The recipient of a message to a farm is that farm's ACTIVE OWNER** (owner
  ruling 2026-11-06). A handle names a FARM; a DM targets a PERSON. Measured
  on production the same day: 4 farms have an active owner and none has more
  than one, so the tie-break — oldest membership, then id — is for a shape the
  schema permits rather than one the data shows.

- **The resolution's safety is the ORDER of its reads**, recorded as a new
  `runWithoutRls` reason (`dm-recipient-resolution`). The published projection
  is asked FIRST, so an unpublished farm never resolves to a tenant at all;
  reversing the first two reads would make this a handle→tenant oracle for
  farms that never chose to be public, which is the coupling P6 kept
  `tenantId` off the projection to avoid. Only a bare `userId` crosses back.
  Neither existing adjacent reason covers it: `farm-handle-availability`
  selects handles only, and `exchange-farm-attribution` goes the other
  direction with tenant ids the caller already holds and never touches
  `TenantMembership`.

- **Sending is PRIVILEGED, and the two better-looking designs were measured
  rather than argued about.**

  `direct_message_insert`'s WITH CHECK already encodes the whole request rule,
  so inserting under user context is the obvious design. It cannot stamp
  `Conversation.lastMessageAt` — the column the rule reads — because that table
  has no `app_user` UPDATE arm, and a privileged write inside an open
  user-context transaction takes a second pool connection while holding one:
  #1191's P0.8 deadlock.

  A `SECURITY DEFINER` trigger was next, and it WORKS. It works for a reason
  that should not be relied on: the `role` GUC does **not** change inside such
  a function (measured — `current_user=test`, role GUC still `app_user`), so
  `superuser_bypass`'s `current_setting('role') != 'app_user'` does not apply,
  and the write crosses RLS purely on the definer's `rolsuper` /
  `rolbypassrls`. In the test database `test` is `super=true bypassrls=true`;
  production's app role is a superuser too. So the mechanism depends on the
  application running as a superuser and would break **silently** the day
  somebody hardens that — leaving a stranger able to send without limit. An
  explicit privileged client is the same power named out loud.

  The consequence, stated rather than glossed: the WITH CHECK is a BACKSTOP
  here, not the live control. P8's phase note asks for the rule "in the usecase
  AND in WITH CHECK", so the usecase half is first-class rather than a
  duplicate, and the database half protects any future caller that is not this
  file.

- **Blocks are enforced in the usecase because SQL cannot.**
  `conversation_participant_select` admits the caller's own row only — forced,
  because a policy admitting "every participant of a conversation I am in" must
  ask that table whether I am in it, which Postgres refuses as infinite
  recursion. So SQL cannot name the counterparty, and a WITH CHECK asking
  whether they blocked the sender would be **vacuously true**.

- **The block predicates MOVED rather than being copied.**
  `personBlockExists`, `amIBlockedByAnyOf` and `whoHasBlockedMe` were
  module-local in `exchange-messaging.ts`; they now live in `person-blocks.ts`,
  which owns `UserBlock`. Copying would have been the cheaper edit and the
  wrong one — #1664 is a block that did nothing for every pair because one half
  of the system read a different session variable than the other.

  They are portable across both session contexts only because `UserBlock`
  carries an arm for each (`user_block_select` and #1664's
  `user_block_select_actor`). A change removing the second as "redundant" now
  breaks TWO features, silently.

- **`DM_OPEN_LIMIT` is 5 per HOUR**, and the window is the lever rather than
  the rate. The abusable act is opening threads with people who never asked —
  P8's hardening criterion says "one sender messaging 100 strangers stops at
  the limits" — and `API_MUTATION_LIMIT`'s 60/min is under two minutes for all
  100. Slow mode's 15/min is better and still about seven. A per-minute cap of
  any size is defeated by patience. It bounds the CALLER rather than being a
  `getBucket`, because the harm is spread across 100 unrelated people and there
  is no shared resource to key on.

- **Typing is NOT in this PR**, and the reason is #2809: the realtime bus can
  address a (tenant, person) and the whole deployment, and a DM has no tenant.
  A typing indicator is pure transport — nothing is stored — so if it cannot be
  delivered it cannot be built. Filed before merging rather than left in a PR
  body nobody greps.

- **`DirectMessage` moved from `KNOWN_UNCOVERED` into `RICH_TEXT_COVERAGE`**,
  which is the mechanism reporting its own success: P8.1 predicted the
  live-writer assertion would trip the moment a send usecase existed, and it
  did, on `prisma.directMessage.create`, the same run this landed. The
  KNOWN_UNCOVERED cap went back from 2 to 1 in the same diff.

- **A reaction's `emoji` is capped at 16 characters** rather than validated
  against an emoji set. A reaction is delivered by push, and a field long
  enough for prose would reintroduce the exposure
  `push-payload-carries-no-free-text` exists to prevent. The cap is the
  control; deciding which codepoints count as emoji is not a problem worth
  having.

## Files

| file | role |
|---|---|
| `src/app-layer/usecases/direct-messages.ts` | the nine operations |
| `src/app-layer/usecases/person-blocks.ts` | the three predicates, moved here |
| `src/app-layer/usecases/exchange-messaging.ts` | imports them back |
| `src/app/api/social/**` | seven route files |
| `src/lib/schemas/index.ts` | six request bodies |
| `src/lib/openapi/paths/direct-messages.paths.ts` | nine operations, with the 4xx codes named |
| `src/lib/db/rls-middleware.ts` | `dm-recipient-resolution` |
| `src/lib/security/rate-limit.ts` | `DM_OPEN_LIMIT` |
| `tests/integration/p8-2-direct-messages.test.ts` | 27 cases against a real database |

## The mutation proof

| mutation | reddens |
|---|---|
| drop the block check when opening | *a BLOCKED caller is indistinguishable from a stranger with no handle* |
| drop the request-rule check when sending | *REFUSES a second message while the request is unanswered* |
| let the initiator answer their own request | *lets the OTHER party answer, and only them* |
| ignore the UPDATE count when editing | *somebody ELSE editing it is a not-found* and *a deleted message cannot be edited back into existence* |

Two fixture traps worth inheriting. `Tenant.updatedAt` and `User.updatedAt`
are `@updatedAt`, which Prisma fills and a raw INSERT does not; and
`User.emailHash` is derived by `pii-middleware` on an ORM write, so a raw
fixture violates its NOT NULL — and a hand-supplied hash would store a user
whose lookup derivation does not match their address, which is a different
database from the one production has. The suite therefore builds fixtures
through the EXTENDED client and keeps `$queryRawUnsafe` only for the
ciphertext-at-rest assertions, where it still returns stored bytes because the
encryption extension intercepts model operations and not raw queries.
