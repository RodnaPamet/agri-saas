# 2026-11-13 — a channel mention and a reply tell somebody

**Issue:** #2987. **Owner ruling:** "Wire the push: mentions + replies, honour
mute" (the unread badge is #2990). This is the SSE half; the background push
needs a person-scoped transport that does not exist — see the limit below.

## Design

A FOURTH address on the notification bus, `channel-activity:<userId>`, and a
fourth `StreamEventKind`, `channel`.

```
postToChannel  ─┐                                    ┌─ Notification bell  (farm)
replyToPost    ─┴─ afterCommit ─ reachableTargets ─┐ │
                                 (mute, ban, self) │ │
                                                   └─┴─ channel-activity:<userId>
                                                            → SSE kind: 'channel'
                                                            → id = the CHANNEL id
```

## What was wrong, and why nothing failed

`recordMentions` was the only writer of `ChannelPostMention`; the GDPR export
was the only reader. So a mention's sole observable effect was that it appeared
in the mentioned person's Art 15 download, possibly months later — and three
docblocks described a push that did not exist:

| | claim | state |
|---|---|---|
| `channel_post_mention_insert` | no `app_user` arm "because a mention is a PUSH TRIGGER" | a SECURITY argument for a harm that was unreachable |
| `ChannelMembership.mutedAt` | "Muted: still a member, no push" | no writer, and nothing to suppress |
| `replyToPost` | "Recording them on both rows would push twice for one act" | correct reasoning, unreachable consequence |

Every check stayed green: a missing notification is not a route, no copy was
absent because none is composed, and the behavioural suites asserted that the
ROW was written, which was true. #2961's rule verbatim — when you add a write,
name the read path that makes its effect observable.

## Files

| File | Role |
|---|---|
| `src/lib/notifications/notification-bus.ts` | `CHANNEL_ACTIVITY_PREFIX`, `subscribeToChannelActivity`, `publishChannelActivityEvent` — all through the existing `subscribeToChannel` bookkeeping |
| `src/lib/realtime/stream-frame.ts` | `'channel'` joins `StreamEventKind`; the `id` and `tenantId` docblocks gain its row |
| `src/app/api/me/stream/route.ts` | the fourth subscription, released with the other three |
| `src/app-layer/usecases/channels.ts` | `reachableTargets` + `queueChannelActivityNotify`, called from both writers |
| `prisma/schema/channels.prisma` | the two docblocks corrected, with what is still not delivered |
| `CLAUDE.md` | the P9.1 mention paragraph, same correction |
| `tests/guards/notification-publish-after-commit.test.ts` | `PUBLISHERS` is a list now; the new publisher is covered, floor 4 → 5 |

## Decisions

- **A fourth ADDRESS, not a discriminator on the person event.** The instinct
  is to reuse `person:<userId>` and add a `scope` field. The person channel's
  wire payload is `{ id }` and the subscriber REFUSES anything else, so adding
  a field changes the format on both sides at once — and mid-rolling-deploy the
  two sides are different versions: a new publisher's discriminator reaches an
  old subscriber that drops it, and the event arrives labelled as a DIRECT
  MESSAGE. A client would then try to open a conversation whose id is a
  channel's. A separate address is simply not subscribed by an old process, so
  the event is undelivered rather than mislabelled, and the REST refetch is the
  designed fallback for that.

- **Spelled `channel-activity:` and not `channel:`.** "Channel" means three
  things here — a Redis pub/sub channel, an SSE delivery channel, and the
  product's «Канал» — and this file is where all three meet.

- **A fourth `StreamEventKind` was safe by design, not by luck.** #2085 made
  `kind` a FIELD rather than a named SSE `event:` line precisely so a later
  kind could not be silently dropped by a client that registered no listener.
  `dm` was the first use; this is the second, and it ships while agrent-ios
  builds P9.8 against POLLING (because #2986 told them no channel notification
  existed). A phone that decodes `channel` as `unknown` keeps working exactly
  as today.

- **The mute is applied at DELIVERY, never at the mention.**
  `resolveMentionable` deliberately leaves a muted person in the recordable
  set: the mention ROW is a record and is what the Art 15 export returns, while
  a mute is a statement about being INTERRUPTED. Filtering earlier would make a
  muted person's mention vanish from their own data download.

- **Banned and LEFT are both read as "do not tell me".** `bannedAt: null` is
  required, so a banned member is not notified although they may still READ the
  channel. A parent author who has left has no row at all: leaving discards
  `lastReadAt` and `mutedAt` (P9.5 — rejoining writes a FRESH row), so there is
  no preference left to honour and treating the absence as disinterest is the
  only reading that does not invent one.

- **An ordinary post notifies NOBODY.** Mentions and replies only. Telling
  every member would make a 2,000-member crop channel reachable by anybody who
  joined it.

- **`afterCommit`, with the publish INSIDE the callback.** `runInUserContext`
  owns an after-commit scope, so queuing from inside its callback defers
  correctly and a rollback drops the queue unrun — unlike `sendDirectMessage`,
  whose bare `prisma.$transaction` opens no scope and where `afterCommit` fires
  un-awaited (#1619). The publish is written in the callback rather than in a
  function the callback calls because `notification-publish-after-commit` is
  LEXICAL, and it reported the first draft as unwrapped — correctly, since the
  next person to call that helper from elsewhere would not be warned.

- **`publishPersonEvent` was deliberately NOT added to that guard.** Its two
  call sites publish after a bare `$transaction`, so the correct shape for them
  is a directly-awaited call AFTER the closure and the guard would fail two
  files that are already right. Expressing "inside `afterCommit` OR outside
  every transaction span" would cover all three uniformly and is the better
  guard; it is not done here because it would LOOSEN the rule for
  `publishNotificationEvent`, whose uniform wrapping is what that file argues
  for. Recorded in its docblock so the absence reads as a decision.

## The limit, stated because #2987 stays open

**This is the SSE half.** A person with the app OPEN is told at once; a person
with it closed learns nothing until they open it.

Every push transport in this repo is tenant-scoped end to end:
`PushSubscription.tenantId` is NOT NULL and one row is created per (tenant,
user, endpoint); `sendApnsToUser` and `sendWebPushToUser` bind RLS through
`runInTenantContext`; `resolveDelivery` reads `UserNotificationPreference`,
which is per (user, farm); and `push-send` / `push-summary` are keyed on a
tenant. A channel has no farm, so a background push would need a tenant
resolved from the recipient — which is the mistake P5.4a names for
`NotificationOutbox`, and here it would also pick wrong: a person in three
farms may hold a `PushSubscription` row under only the one they happened to be
in when the device registered.

A DIRECT MESSAGE is in exactly the same position and equally silent today, so
the remaining work is strictly bigger than channels: a person-scoped device
read (privileged, by `userId`, deduped by endpoint and device token), a
person-scoped delivery decision (most-restrictive preference across the
person's farms, quiet hours unchanged), and person variants of the two push
jobs.

## Mutation proofs

| | mutation | caught by |
|---|---|---|
| N1 | drop `mutedAt: null` | *does NOT reach a MUTED member* |
| N2 | drop `bannedAt: null` | *tells a BANNED parent author nothing* |
| N3 | drop the author exclusion | *tells nobody when the author replies to their OWN post* |
| N4 | drop the `new Set` dedupe | **SURVIVED** — see below |
| N5 | publish per CANDIDATE instead of per membership row | 3 cases |
| N6 | drop the fourth subscription's release | *releases it on disconnect* |
| N7 | label the channel frame `dm` | **SURVIVED at first** — see below |
| N8 | send the sentinel as the frame's `id` | *emits a frame of kind `channel`* |
| N9 | publish inline (`void (async () => …)()`) instead of `afterCommit` | **12 of 14 cases** |

**N4 changed a claim.** The docblock said the `Set` is what makes two causes
produce one event. It is not: the publish iterates the ROWS of a `findMany`,
and there is one `ChannelMembership` row per person per channel, so `in: [x,
x]` returns one row. The `Set` stays for two smaller reasons — a shorter `in`
list, and an honest `candidates` figure in the log beside `suppressed` — and
both the docblock and the test comment now say which mechanism does the work.
The assertion is left on the OUTCOME, so it still fails if a later change
publishes per candidate (which N5 confirms).

**N7 was a real gap.** Labelling the channel frame `dm` left all 52 cases
green: the route test mocked the subscription without inspecting the frame, and
the integration test observes the BUS rather than the SSE wire. Two cases were
added on the frame itself — kind, id, sentinel tenant, and the absence of an
`id:` line — and N7 and N8 then both fail.

**N9 measured a property worth relying on.** It was aimed at the rollback case
and reddened almost everything instead — because the scope owner AWAITS the
drain, so by the time `postToChannel` resolves the event has been published.
Un-awaited, the publish had not happened yet when the caller looked. So this is
not fire-and-forget with respect to the REQUEST: it is one indexed membership
query on the response path, which is the price of the event being observable at
all.

## A note on the local verify run

`tests/integration/p5-4-handling-metrics.test.ts` fails on this branch and is
NOT this change: it is #3011's median case, which asserts an exact figure over
a 30-day window ending now and therefore passes only on a database holding no
other moderation rows in that window. CI is such a database, so it is green
there; the repair rides #3015, which scopes that case to a one-day window 311
days back. Named here so the next reader of this branch's log does not go
looking for a cause in this diff.

## The three fixture states that have no writer

`mutedAt` and `bannedAt` are set with a direct `update` in the integration
test, and that is deliberate rather than a shortcut: neither has an endpoint.
#2990 owns the mute control and the read cursor; a ban is P9.3's moderation
path. Setting the COLUMN is what makes the column the subject, which is the
point — its docblock claimed a behaviour nobody could trigger.
