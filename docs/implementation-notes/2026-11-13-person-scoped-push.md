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
