# 2026-11-15 — P9.7 stage C: the opt-in 07:15 channel digest

**Commit:** `5b4021dab feat(channels): P9.7 stage C — the opt-in 07:15 channel digest`

## Design

An opted-in person receives ONE push each morning recapping what happened to
them in their channels, linking to «За Вас».

```
*/15 * * * *  channel-digest
                ├─ candidates: User where channelDigestOptIn OR a per-farm
                │              DAILY_DIGEST preference, minus suspended /
                │              deletion-pending / pseudonymised
                ├─ clock gate: is local time inside [07:15, 08:15) Sofia?
                │              → no: log the reading and LEAVE
                └─ per person: already stamped today? → skip
                               readMyActivity (the «За Вас» read)
                               nothing fresh? → skip, stamp NOTHING
                               enqueue person-push-send
                                 farmRelativePath /channels/for-you
                                 collapseKey channel-digest-<YYYY-MM-DD>
                               stamp channelDigestSentOn
```

Three deliberate departures from what the issue asked for or from what the
neighbouring jobs do:

**Push, not email.** #2941's Done-when says the digest "stores rendered text
with an explicit `locale`", which describes `NotificationOutbox`. That is not
available: `NotificationOutbox.tenantId` is NOT NULL and
`EnqueueEmailInput.tenantId` is required, and a channel has no tenant — the
wall #3020 hit, with P5.4a's reason that resolving one would invent a tenant
for a person-scoped obligation. Owner ruling 2026-11-15: deliver by push,
reusing `person-push-send`. The cost is real and worth stating — somebody who
does not open the app gets a banner rather than a mail.

**The schedule is dumb and the JOB holds the clock.** A fixed UTC hour drifts
by one across DST, and #2941 names exactly that as the failure: "silently
shipping a digest that arrives at 06:15 half the year". So the job runs every
15 minutes and asks whether local time is inside its delivery window. This is
the opposite choice from P9.4's card generator, which takes a UTC cron
deliberately — there the hour only needs to be "before anybody looks", and an
hour of seasonal drift changes nothing a reader could notice. Here the time is
a PROMISE to the recipient.

**The gate is a WINDOW, not «has 07:15 passed».** The first draft was
open-ended, which is true at 22:00 — so somebody whose first activity of the
day arrived at 22:00, and who therefore had nothing to report at 07:15 and was
never stamped, would be sent a MORNING digest late at night. That is #2941's
own failure case an hour and a half further out. An hour against a 15-minute
schedule gives four chances to deliver, so a worker down for one beat still
sends; after the window the day is simply missed, which is correct for a
promise about the morning.

## Files

| File | Role |
|---|---|
| `src/app-layer/jobs/channel-digest.ts` | the job, plus the pure `digestDueAt` boundary |
| `src/app-layer/jobs/schedules.ts` | `*/15 * * * *`, with the DST reasoning |
| `src/app-layer/jobs/types.ts` | payload type and `attempts: 3` with its reason |
| `src/app-layer/jobs/executor-registry.ts` | tenantless registration |
| `prisma/schema/auth.prisma` | `channelDigestOptIn`, `channelDigestSentOn` |
| `src/lib/account/channel-digest.ts` | the schema and the write |
| `src/app/api/account/channel-digest/route.ts` | `PUT`, no GET |
| `src/app/api/auth/me/route.ts` | the READ, on a query the handler already runs |
| `src/app/account/profile/ChannelDigestCard.tsx` | the switch — the entry point |
| `src/app-layer/usecases/personal-data-export.ts` | both columns exported |

## Decisions

- **It is ADDITIVE, not a delivery mode.** Opting in adds a recap; it does not
  suppress per-event pushes. Somebody who wants batching INSTEAD sets
  `UserNotificationPreference.delivery = DAILY_DIGEST`. Expressing one decision
  through two mechanisms is how they come to disagree.

- **It also covers the `DAILY_DIGEST` population, which otherwise gets
  nothing.** `resolvePersonDelivery` returns `digest-only` for that
  preference — no push — while the FARM digest counts `Notification` rows,
  which a channel event never writes. So those people would get no channel
  push and no channel digest. Production holds zero
  `UserNotificationPreference` rows, so this affects nobody today; it is closed
  before it has a victim.

- **`readMyActivity` is SHARED with «За Вас», not reimplemented.** A second
  spelling of "what happened to you" is the #1664 class, where the divergence
  is a disclosure rather than a wrong sentence.

- **No activity ⇒ nothing sent AND nothing stamped.** Stamping would mean a
  person who had nothing at 07:20 could not be sent one later in the same
  window if the job were re-run after a fix.

- **`attempts: 3`, and the reason is the COLLAPSE KEY rather than an index.**
  The stamp lands after the enqueue, so a process dying between them
  re-enqueues on retry — and the per-day collapse key means the second banner
  REPLACES the first. The worst a retry can do is redeliver once. That is the
  opposite of `statement-dispatch` (1, because a retry would re-SEND an Art 17
  letter with no collapse key) and `notice-score` (1, because a retry would
  re-SPEND the AI budget).

- **An ERASED account is excluded, and `suspendedAt` does not cover it.** A
  moderation termination sets `suspendedAt`, but a self-service erasure sets
  `deletionRequestedAt` then `pseudonymisedAt` and never `suspendedAt`. P5.6b
  keeps the `User` row alive deliberately (Art 17(3)(b)), which is exactly why
  "the row exists" cannot be read as "there is somebody to notify".

- **`User` has no `deletedAt`, and the first draft's `where` used one.** It
  typechecked — an extended-client `where` key is not caught by `tsc`, the same
  class as the five wrong `select` keys P5.6a shipped — and failed at runtime
  as a `PrismaClientValidationError`.

- **Both new columns are EXPORTED, not omitted.** The opt-in is a preference
  they set and the send date is our record of what we sent them; there is no
  second owner to withhold either for, which is the test every
  `OMITTED_BY_DECISION` entry in the export guard turns on.

- **The card is the feature.** The column defaults to false, so without a
  switch the job would run every 15 minutes over an empty population for
  ever — green, silent and indistinguishable from working. #2844 and P9.3's
  entry-point rule.

- **`.strict()` was removed after a mutation disproved its stated reason.** The
  schema's docblock credited strictness with catching a misspelled `optin`;
  removing `.strict()` left all five cases green, because zod strips unknown
  keys and the refusal was always coming from the REQUIRED key. The claim was
  true and its mechanism was not. Dropping it also buys forward compatibility:
  a newer client sending an extra field keeps working, the posture
  `bottom-tabs` takes toward tab ids it has never heard of.
