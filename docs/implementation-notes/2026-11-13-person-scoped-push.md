# 2026-11-13 — the person-scoped push: channel mentions, replies and DMs

**Issue:** #2987 PR B. **Owner ruling 2026-11-13:** both channels *and* direct
messages ride the new transport. PR A (#3016) shipped the SSE half.

## Design

```
postToChannel / replyToPost ─┐
                             ├─ afterCommit ─ reachableTargets ─ enqueue('person-push-send')
sendDirectMessage ───────────┘        (mute, ban, self, reason)        │
                                                                      ▼
                                              resolvePersonDelivery ──┴─ resolveDelivery (PURE)
                                               (strictest preference,      │
                                                deduped devices)           ▼
                                                              sendApnsToPerson / sendWebPushToPerson
                                                               (privileged read, dedupe, prune)
```

Every step of the existing push path was unavailable to a tenantless event:

| | tenant coupling |
|---|---|
| `Notification.tenantId` | NOT NULL, FK to Tenant |
| `PushSubscription.tenantId` | NOT NULL, one row per (tenant, user, endpoint) |
| `UserNotificationPreference` | `@@unique([userId, tenantId])` |
| `sendApnsToUser` / `…WebPush…` | bind RLS through `runInTenantContext` |
| `push-send` / `push-summary` | keyed on a tenant, including the summary's `jobId` |

Deriving a tenant from the recipient is the mistake P5.4a names for
`NotificationOutbox` — and here it would also pick WRONG: the registration
route is tenant-scoped, so a person in three farms may hold a
`PushSubscription` row under only the one they happened to be in.

## Files

| File | Role |
|---|---|
| `src/lib/notifications/apns.ts` | `sendApnsToPerson` + `deliverToDevices` (shared send loop) + `pruneDeadTokensForPerson` |
| `src/lib/notifications/web-push.ts` | `sendWebPushToPerson` + `deliverToSubscriptions` (shared gate-and-send) |
| `src/app-layer/notifications/person-delivery.ts` | NEW — `strictestPreference`, `resolvePersonDelivery`, the reading |
| `src/app-layer/jobs/person-push-send.ts` | NEW — the job |
| `src/app-layer/jobs/types.ts` | `PersonPushSendPayload`, `JOB_DEFAULTS`, `PUSH_QUEUE_JOBS` |
| `src/app-layer/jobs/executor-registry.ts` | the executor |
| `src/lib/db/rls-middleware.ts` | the `person-push-devices` reason |
| `src/app-layer/usecases/channels.ts` | the channel caller + `reachableTargets` carries a REASON |
| `src/app-layer/usecases/direct-messages.ts` | the DM caller |
| `messages/{en,bg}/app.json` | `notifications.social.{channelMention,channelReply,directMessage}` |
| three guards | population extended — see below |

## Decisions

- **The MOST RESTRICTIVE preference wins** (`DISABLED` > `DAILY_DIGEST` >
  `IMMEDIATE`). A tenantless event belongs to none of a person's farms, so
  there is no "right" row and the choice is a policy. Being wrong quietly
  costs a notification they can still find by opening the app; being wrong the
  other way wakes somebody who told this product not to push them. NO rows
  resolves to `null`, which `resolveDelivery` reads as IMMEDIATE — the state
  nearly every person is in, since the table has zero rows in production.

- **`person-delivery.ts` is a sibling module, not two more lines in
  `resolve-delivery.ts`.** That file is pure on purpose and says so ("no
  database, no clock, no Redis — so the test enumerates the grid instead of
  driving a queue and hoping"). The decision stays there; this module only
  answers the two questions a tenantless caller cannot.

- **QUIET HOURS SUPPRESS RATHER THAN DEFER, and that is a tracked gap.**
  `push-send` defers by enqueuing one `push-summary`, which reads unread
  `Notification` rows — of which a tenantless event has none, so a summary
  would wake somebody to tell them about zero things. **#3020** carries it,
  with the log line (`person-push.suppressed reason=quiet-hours`) as the
  evidence to measure before deciding anything.

- **The DEDUPE is a correctness property for the SEND and a reading-only one
  for the COUNT.** One iPhone registered in two farms is two rows with the
  same `deviceToken`; without the dedupe one mention buzzes it twice and the
  returned count says two deliveries. APNs dedupes on `deviceToken`, Web Push
  on `endpoint` — keyed on `id` either would collapse nothing, since `id` is
  exactly what differs.

- **The web-push extraction had to include the SSRF gate.**
  `web-push@3.6.7` validates nothing (its only check is "non-empty string",
  the scheme is discarded, the port is attacker-chosen), so a second entry
  point that read endpoints and skipped that gate would be a working SSRF
  against the one seam built to stop it. The shared core therefore starts AT
  the gate rather than after the read.

- **The PRUNE needs the bypass more than the read does.** A token the push
  service reported gone may sit under a farm the person has since LEFT, and a
  tenant-scoped `deleteMany` removes zero rows and returns normally — so the
  dead device would be pushed to for ever while every send kept reporting
  `gone`. That is why each transport has two bypass sites rather than one.

- **A channel push names the CHANNEL; a DM push names NOBODY.** The
  2026-11-01 ruling is "keep the KEY, drop the free text".
  `Channel.nameBg`/`nameEn` is platform-seeded reference data in both
  locales — the entity analogue of a task key. The DM analogue would be the
  SENDER's display name, which is personal data about a third party, and an
  APNs alert body is read by Apple. `DirectMessage.body` is encrypted at rest
  for that kind of reason; putting either in a push would undo it at the last
  hop. It matters more for channels than for tasks, because
  `ChannelPost.body` is PLAINTEXT at rest (P9.1, for P9.7's search) — the
  encryption boundary that makes a task description obviously unsendable does
  not exist there.

- **`reachableTargets` carries a REASON per person**, mention beating reply,
  because the copy differs and a reply that also mentions its parent's author
  is one act. A `Map` built mention-first puts the union and the precedence in
  one place.

- **`collapseKey` is per channel AND reason** (so a busy channel supersedes
  its own banner without a mention silently replacing a reply) and **per
  conversation** for a DM (so a short exchange is one notification, not six).

- **The DM enqueue is wrapped in try/catch; the channel one is not.**
  `sendDirectMessage` uses a bare `prisma.$transaction`, so its enqueue runs
  on the response path after the commit — a failed enqueue must not fail a
  message that is already stored and already published. The channel path runs
  inside `afterCommit`, where `runEffect` already contains its own errors.

## Three guards had the population one name short

Each would have graded the producers that already existed and said nothing
about the new ones — `count-the-routes-a-gate-covers` with a list of function
names instead of a property:

| guard | named | was silent about |
|---|---|---|
| `notification-publish-after-commit` | `publishNotificationEvent` | `publishChannelActivityEvent` (PR A) |
| `one-resolve-delivery` | `sendApnsToUser`, `sendWebPushToUser` | both `…ToPerson` variants |
| `push-payload-carries-no-free-text` | `enqueue('push-send')` | `enqueue('person-push-send')` |

All three extended, each with its own needle: `one-resolve-delivery` gets a
SEPARATE `MUST_RESOLVE_PERSON` list, because a single list would let
`person-push-send` satisfy the rule by naming the bare `resolveDelivery` and
skipping the preference union — #1994's defect in the one shape this feature
can produce.

The RLS-bypass ratchet also fired twice: files **6 → 9**, sites **13 → 18**. I
raised it to 8 first and missed that `person-delivery.ts` is a third caller of
the same change; the ratchet caught it.

## Mutation proofs

| | mutation | caught by |
|---|---|---|
| Q1 | `strictestPreference` returns the FIRST row | 3 cases |
| Q2 | the deferral branch falls through to sending | *QUIET HOURS suppress* |
| Q3 | count device ROWS instead of distinct identities | **SURVIVED at first** — see below |
| Q4 | `delivered++` regardless of outcome | 2 cases (#2171's shape) |
| R1 | REPLY wins over MENTION in the precedence | *pushes ONCE, as a MENTION* |
| R5 | always use `nameEn`, ignoring the recipient's locale | *in the recipient's language* |
| S1 | put the MESSAGE BODY in the DM push | *names NOBODY and carries no prose* |
| S2 | enqueue for the SENDER too | *none for the sender* |

**Q3 changed the design.** The dedupe had NO observable consequence: each
transport is attempted once however many devices it has, so the decision only
ever reads zero-ness, and a row-counting mutation left the whole suite green.
Either the dedupe was untestable or it was pointless. So
`resolvePersonDelivery` now logs its reading — `devicesWeb`, `devicesIos`,
`rowsRead`, `farmPreferences`, `preference` — which is useful on its own (the
operator-side counterpart of `reachableTargets`'s denominator, and #3020's
evidence) and makes the dedupe assertable. The test checks BOTH numbers:
`devicesIos: 1` alone is also what one row produces, so `rowsRead: 2` is what
makes it a dedupe rather than a fixture with a single device. The log carries
**no userId**, asserted — a person-scoped log naming the person is a log of
who was messaged.

**S1 is load-bearing where its channel twin is not.** `sendDirectMessage` has
`input.body` in scope at the enqueue site, so substituting it is a real
one-line mistake. `queueChannelActivityNotify` receives
`ChannelActivityTargets`, which carries no body — so the channel path is
protected by its TYPE and the equivalent assertion there is defensive only.
Worth knowing which is which.

## Process note, recorded because it cost real work

Mutation-proving the guard, I backed up one file with `cp` and restored the
other with `git checkout -- src/app-layer/usecases/channels.ts` — which wiped
the channel push wiring and the reason-carrying `reachableTargets` change,
neither committed. `[[mutation-restore-eats-uncommitted-work]]` verbatim. The
inconsistency between two restore methods in one command is what did it; the
fix is `cp` for every file in a sweep, and committing before sweeping.

## The deep link, added after the first green run

The branch was fully verified — 1,954 suites, typecheck clean, eight mutations
— before anybody asked what the push actually opened. It opened nothing.

```
src/app-layer/usecases/direct-messages.ts     link: `/messages/${conversationId}`
```

There is no `/messages` route. P8.4 ruled one out explicitly, putting the DM
screen under `/t/{slug}/exchange/threads/dm/{id}`; `exchange/threads/page.tsx`
says so in its docblock, the P8.4 note says so, and the comment three lines
above that literal said so while the line below it said otherwise. The value
came from `2026-11-07-p8-3-chat-primitives.md`, which still read "P8.4 mounts
them on `/messages`" — written before the ruling, and now corrected in place.

This is #2932 a second time. There, `push-summary` sent `/notifications`: a
404 through `clients.openWindow` on the web, and on iOS a push that merely
opened the app. That issue measured 19 of 19 production `Notification.linkUrl`
rows starting with `/t/` and found the one violator — and noted that **the
existing test was holding the defect in place**. So was mine:
`p8-2-direct-messages.test.ts` asserted `push.link` equalled
`/messages/${convId}`, which is true of the code and says nothing about
whether it is a page.

### Three decisions came out of it

**1. The payload carries a FARM-RELATIVE PATH, and the job composes the
link.** A channel post and a direct message are tenantless, so the enqueuing
usecase has no slug — and the poster's own farm is the wrong answer, because a
recipient sent to a farm they do not belong to is bounced by the tenant-access
gate. `runPersonPushSend` resolves the recipient's oldest active farm and
builds `/t/{slug}{farmRelativePath}`.

The resolution is NOT the one this job's own docblock refuses. That paragraph
is about ADDRESSING — which devices, which preference — where resolving a
tenant both invents a farm for a person-scoped obligation (P5.4a) and picks
wrong, since `PushSubscription` registration is tenant-scoped. This is a
NAVIGATION SHELL: the notification stays tenantless and the slug is a URL
segment deciding whose chrome the page opens inside. P8.4 settled that the
answer is arbitrary — "a DM list is identical under every farm" — so any
active membership is as correct as any other.

It goes through `listMyFarms` rather than a second copy of its predicate.
Three clauses and an ordering, each argued in that usecase: ACTIVE, the tenant
not soft-deleted, oldest first — which is the membership `/api/auth/me` already
names. The easy miss is the middle one, which the switcher's own docblock calls
out, and a second spelling here is the #1664 class.

**2. An unresolvable farm sends NO LINK, never the bare path.** Both transports
spell "no target" as an absent key, so the push still arrives and simply does
not navigate. Reach preserved. agrent-ios keeps bare paths deliberately
unhandled (#2932), so a bare path is not a degraded link — it is a link to
nowhere on the web and a no-op on the phone.

**3. The field is `farmRelativePath` because `linkPath` was already taken, and
the new guard is what found that.** `notifications/assignment.ts` has carried a
`linkPath` since #2490 meaning the opposite — `(slug, id) =>
/t/${slug}/assets/${id}`, a builder producing the full prefixed link. One name,
two opposite meanings: «Борса» against «Пазар», `app.user_id` against
`app.actor_user_id`. Renaming was the fix; narrowing the guard's population to
exclude those two sites would have left the name ambiguous for the next reader.

### Why no existing check could see it

- `notification-link-is-tenant-scoped` derives from `linkUrl:` assignments. A
  push payload's field is not `linkUrl`, so these sites were outside the
  denominator rather than passing it. That guard's property is also the wrong
  one here: it requires a `/t/` prefix, which a tenantless producer cannot
  write.
- `route-inventory` and OpenAPI describe API routes. A page is not a route
  there.
- `pages-are-reachable` asks whether something LINKS to a page. It cannot ask
  whether a link names one.

`tests/guards/person-push-link-resolves.test.ts` is the missing direction:
every `farmRelativePath` literal under `src/app-layer` must resolve to a
`page.tsx` that exists under `src/app/t/[tenantSlug]/(app)`, matching segment
by segment with an interpolation permitted only where the route has a
`[param]`. Denominator printed (2 destinations, 82 page routes), and
mutation-proved three ways: restoring `/messages/{id}` reddens it, a value
carrying its own `/t/` prefix reddens two assertions, and gutting the page
walker to `return []` reddens three — including the control, which is the half
that stops the matcher passing everything.

### What is deliberately not built

The channel push lands on the CHANNEL, not the post. agrent-ios settled
`/t/{slug}/channels/{channelId}/posts/{postId}` with us on #2987 and
`posts/[postId]` does not exist, so emitting it would be the #2932 outcome
again. **#3030** carries the permalink page and the link upgrade, and the guard
refuses the longer path until the page is there — which is the ordering that
keeps it safe.
