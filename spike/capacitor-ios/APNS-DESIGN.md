# P5 — APNs as a second transport

**GATE NOT OPEN.** P5 runs only if P3 and P4 came back positive. P3 has not run
at all (six device tests). **Do not start the device half.** This file records
the desk design so it is ready if the gate opens — and one schedule finding that
should be acted on regardless.

---

## Schedule finding — start this now, whatever the verdict

There is **no APNs credential of any kind in the repo**: no `.p8`, no team id, no
`APNS_*` env var. `src/env.ts` carries only the VAPID trio for web push.

P5.1 says to stop and record rather than burn the time box on account admin. So:

- [ ] Apple Developer Program account
- [ ] APNs auth key (`.p8`) + Key ID + Team ID
- [ ] provisioning profile with the Push Notifications capability

**This is on the critical path for any iOS route** — Capacitor shell or React
Native rewrite alike. It does not discriminate between the options, so it is pure
lead time and should be started in parallel with everything else. Left late, it
becomes the long pole for reasons that have nothing to do with engineering.

---

## The seam — one sender, two transports

P5 says "find the existing sender and add a transport". Precisely: **there is no
single sender.** `sendWebPushToUser` is called directly from two places:

| call site | notification |
|---|---|
| `src/app-layer/jobs/weather-pull.ts:261` | spray window |
| `src/app-layer/usecases/task.ts:529` | task assignment |

So the transport seam is **inside `src/lib/notifications/web-push.ts`**:

```
sendWebPushToUser(ctx, recipientUserId, payload)      ← rename: notifyUserDevices
  ├─ web push   → pushSubscription rows (endpoint / p256dh / auth)   [today]
  └─ APNs       → device-token rows                                  [to add]
```

Adding APNs *inside* that function serves both call sites at once with no new
dispatch path. **Anything hung off a different trigger is the parallel pipeline
P5 forbids.**

### Why that seam and not somewhere upstream

The `{tenantId}:{TYPE}:{entityId}:{userId}:{date}` dedupe key belongs to the
**notification record** layer (`buildDedupeKey`, `buildAgroDedupeKey`), not to
push delivery. `sendWebPushToUser` has no dedupe of its own — it is a best-effort
side effect of an already-deduped event.

So adding APNs here **inherits the dedupe for free**. A separate APNs dispatcher
on its own trigger would not, and would double-notify precisely as P5 warns.
That is the technical reason for the seam, not a stylistic preference.

---

## The blocker — schema, and the scope tension made concrete

`PushSubscription` (`prisma/schema/automation.prisma:50`) is Web-Push-shaped:

```prisma
endpoint  String
p256dh    String
auth      String
```

An APNs device token is a single opaque string with none of those. A transport
addition therefore needs either:

- a nullable `apnsToken` column + a `kind` discriminator on `PushSubscription`, or
- a separate `ApnsDevice` table.

**Either is a migration against production**, which is exactly the tension noted
when P5 was received: "add a transport to the existing sender" cannot be done
entirely inside a throwaway spike.

**Decision taken here: no schema change is made.** The design is recorded, not
applied. A migration that outlives a discarded spike is the "half a Capacitor
config found in six months" problem P6.4 exists to prevent. If the verdict is
SHIP THE SHELL, this migration is the first item of real work and should land on
its own merits, with its own review.

---

## Device comparison — only when the gate opens

| | web push (today) | APNs |
|---|---|---|
| delivered with app **killed** | | |
| lock-screen presentation | | |
| tap deep-links to correct screen | | |
| opt-in prompt wording / timing | | |
| refusal recoverable in-app? | | |

Remember **F7**: iOS grants web push only to a site added to the Home Screen as a
PWA, which a Capacitor WKWebView is not. So the "web push (today)" column may be
**empty in the shell** — meaning APNs is not adding a capability so much as
restoring one the shell removed. Record which it is; that changes the verdict.
