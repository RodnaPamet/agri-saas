# 2026-11-07 — the person-scoped realtime channel

**Commit:** `<pending> feat(realtime): a person channel, and live DM delivery`

## Design

The bus could address a **(tenant, person)** and the **whole deployment**. It
could not address a **person**, and a direct message has no tenant — P8.1's
four DM tables carry none, because two people in a conversation may share no
farm. So there was no channel to publish a DM event on (#2809).

```
notif:<tenantId>:<userId>   one per farm the person belongs to   (unchanged)
listings                    the coalesced market tick            (unchanged)
person:<userId>             NEW — a direct message               (#2809)
```

`/api/me/stream` adds one subscription beside the per-farm ones, and
`sendDirectMessage` publishes to the other participants after its transaction
resolves.

## Decisions

- **A third address, not a nullable tenant.** `channelFor(tenantId, userId)`
  has no tenant to be given, and a null through it produces
  `notif:null:<userId>` — a real channel silently shared by every tenantless
  publisher, with nothing in the type saying so. Two distinct functions for
  #1664's reason: `app.user_id` and `app.actor_user_id` are two session
  variables that look alike and are keyed differently, and reading the wrong
  one cost a silently unenforced block. `subscribeToPersonEvents` and
  `subscribeToNotifications` cannot be confused at a call site, where
  `subscribe({ tenantId: null, … })` could.

- **The namespaces are DISJOINT BY PREFIX.** The first draft used
  `notif:person:<userId>`, which a tenant whose id was literally `person`
  collides with. Unlikely — tenant ids are cuids — but the only assertion
  available was "zero or one", which is vacuously true and therefore no test at
  all. `person:<userId>` carries no `notif:` prefix, so no value of `tenantId`
  can reach it, and the test asserts the impostor receives **nothing**.

- **One implementation, two addresses.** Both public pairs go through
  `subscribeToChannel` / `publishToChannel`. A second copy of the per-channel
  bookkeeping is how a leak gets fixed on one path and not the other — and
  P7.10's "10k connect/abort cycles leave 0 subscribers" criterion is what that
  bookkeeping exists for.

- **The frame carries a sentinel `tenantId`, and that is the contract rather
  than an exception.** `stream-frame.ts` requires the field on every kind and
  not optional, because a phone belonging to several farms filters on it before
  refetching and a field present on one kind and absent on another makes that
  filter conditional on the kind. `listing` already carries its own sentinel.
  `dm` carries `'person'` — not a farm, not displayable, **not a filter**: a
  phone that filtered `dm` frames against its memberships would drop every one.

- **Adding a third `StreamEventKind` was safe by design, not luck.** That
  module's header explains why `kind` is a FIELD rather than a named SSE
  `event:` line: a named event is silently dropped by a client with no listener
  for it, so a third kind would break older clients invisibly. A `kind` field
  reaches the single `onmessage` handler where an unknown value is visibly
  ignored, and the iOS client decodes it into an enum with an `unknown` case.
  That choice was made in #2085 for exactly this moment; `dm` is its first use.

- **The frame's `id` is the CONVERSATION id**, not the message id. A client
  receiving a message id would still have to work out which conversation to put
  it in, and `readConversation` is keyed by conversation. It stays a handle and
  never content: `DirectMessage.body` is encrypted at rest, and a channel
  carrying prose would put it through Redis and, via push, through APNs.

- **Published after the transaction, directly — not `afterCommit`.**
  `sendDirectMessage` uses a bare `prisma.$transaction`, which opens no
  `db-context` scope, so `afterCommit` there fires `void runEffect(...)`
  un-awaited rather than deferring. That is #1619 verbatim.

- **`otherParticipantIds` is privileged, and narrowly.**
  `conversation_participant_select` admits the caller's OWN row only — forced
  by P8.1's recursion rule — so a user-context read returns one row and the
  counterparty would never be told. It returns ids only, and takes a bound,
  because D2's unbounded-`findMany` budget scans repositories and this is a
  usecase (the gap #2820 was filed for).

## Three things the first draft got wrong

- **A premature `flush()`.** The person handler called it, which would drain
  the replay buffer EARLY — sending replayed notification ids before the replay
  finished, which is the exact `Last-Event-ID`-goes-backwards problem the
  buffer was built to prevent. A `dm` frame carries no `id:` line, so like
  `listing` it bypasses the buffer and has nothing to order against.

- **A dead `!sent.deduplicated` guard**, found by a surviving mutation: forcing
  it true changed nothing, because the only `deduplicated: true` is an EARLY
  RETURN before the transaction, so the branch is unreachable. A condition that
  cannot be false reads as a safeguard and is one more thing to keep true. The
  test stayed — and was re-proved against the ordering regression it actually
  guards: moving the publish above the early return reddens it.

- **A positional replace hit the twin.** Renaming the send path's transaction
  result with a whole-file `count=1` replacement landed on the FIRST
  `$transaction` in the file, which belongs to `openConversationFromHandle`.
  Caught by `tsc` ("a function whose declared type is neither undefined, void
  nor any must return a value") rather than by reading. Anchored inside the
  function afterwards.

## And one trap in the tests

`me-stream-route.test.ts` mocks the bus PARTIALLY, so the new export was
`undefined` and every case in the file failed with "is not a function" —
arriving as a TypeError in unrelated cases rather than as a missing assertion.
That is the barrel-mock trap; the mock now lists it, with a comment saying why.
