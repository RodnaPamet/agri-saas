# Exchange messaging on iOS — the server contract

Written 2026-09-25 for whoever builds this in `agrent-ios`. The owner's
decision was **read and reply on the phone**, i.e. full parity.

Everything below is live on `app.agrent.bg` and documented in the OpenAPI
snapshot (`src/generated/openapi.json`, tag `Exchange messaging`). Read that
for schemas; this file is for the things a schema cannot tell you.

## The one hard security constraint

**Thread and message ids must never appear in a query string.**

Apple's CFNetwork writes the full request URL — query included — to the unified
log, and nothing in your own logging discipline suppresses it. Headers and
bodies are not logged. Every endpoint below therefore takes its ids in the
PATH, which is safe; if you add a helper that turns them into query parameters
for convenience, that convenience is a disclosure.

## Endpoints

All are tenant-scoped: `/api/t/{tenantSlug}/…`, and all require the `EXCHANGE`
module, which the web screens gate on too.

| method | path | what it does |
|---|---|---|
| `POST` | `exchange/listings/{listingId}/thread` | open, or return the existing thread |
| `GET` | `exchange/threads` | the inbox, both sides in one list |
| `GET` | `exchange/threads/{threadId}` | one conversation with scrollback |
| `POST` | `exchange/threads/{threadId}/messages` | send |
| `POST` | `exchange/threads/{threadId}/read` | move the read pointer |
| `POST` | `exchange/threads/{threadId}/close` | close (either party) |
| `DELETE` | `exchange/threads/{threadId}/block` | lift a block (seller only) |
| `POST` | `exchange/threads/{threadId}/block` | block (seller only) |
| `DELETE` | `exchange/messages/{messageId}` | retract your own message |

## Semantics you would otherwise have to discover

**Opening is idempotent.** `POST …/thread` returns the existing thread when
there is one, with `created: false`. Tapping twice does not make two
conversations. It also doubles as "back to our conversation", so it is safe to
wire to a button that is always visible.

**`mine` tells you the side.** Every message carries `mine: true|false`. Do not
compare `senderTenantId` to your own tenant — the server already knows which
party is asking and has answered for it.

**A deleted message is a TOMBSTONE, not a gap.** `deleted: true` with a null
`body`. Render it in place as removed. Dropping the row leaves a hole where the
other party demonstrably read something, which reads as data loss rather than a
retraction.

**Scrollback comes back oldest-last.** The server selects the newest page and
reverses it, so what you get is reading order and the END of a long thread, not
its beginning.

**The read pointer is monotonic.** Fire `…/read` freely — on appear, on
foreground, from two devices, out of order. It never travels backwards, so
there is nothing to coordinate. It cannot resurrect messages the user has read.

**Closing is soft, and sending reopens.** Either party may close; a message
clears it. There is no reopen endpoint because there is no need for one. Keep
the composer visible on a closed thread — hiding it removes the only way back
and lets one party mute the other.

**Blocking is seller-only and one-directional.** A blocked buyer gets `403`
with code `THREAD_BLOCKED` from both open and send. The seller can still write
in that thread. `GET …/threads/{id}` returns `blocked`, so you can explain the
refusal before the user types rather than after.

## Notifications

Two channels, deliberately different cadences:

- **in-app**: one `Notification` row per message, pushed on the SSE bus. No
  dedupe. This is the accurate one.
- **email**: one per thread per recipient **per UTC day**, deduped silently by
  the outbox.

If you add push notifications, model them on the in-app channel, not the email
one — the daily cap exists to protect an inbox and would make a phone alert
wrong from the second message of a conversation onward.

## There is no realtime transport for messages yet

The usecase layer persists and never publishes; the web polls (30s inbox, 5s
open thread). The SSE bus carries *notifications*, not message bodies, and is
per `(tenantId, userId)`.

So: poll, or subscribe to the notification stream and refetch the thread when
one arrives for it. The second is cheaper and is the closer analogue of what a
phone should do. Do not build against a message socket — there isn't one, and
adding one is a server decision.

## Error codes worth mapping

`THREAD_NOT_FOUND`, `THREAD_NOT_A_PARTY`, `THREAD_OWN_LISTING`,
`THREAD_BLOCKED`, `BLOCK_SELLER_ONLY`, `MESSAGE_EMPTY`, `MESSAGE_TOO_LONG`,
`LISTING_NOT_FOUND`.

The English beside each code is a fallback, not a display string —
`docs/i18n-airtight-roadmap.md` class B. The app is single-locale Bulgarian, so
map the codes; anything unmapped degrades to the server's English rather than
to blank, which is the property that makes incremental adoption safe.

---

# Answers to the iOS session's questions (2026-09-25)

**First, a correction to the premise.** The brief above was written as though
persistence had landed and delivery was still deferred. That is no longer true:
messaging is **merged and live on app.agrent.bg**, including a delivery channel.
Nothing below is "still mine to shape" in the sense of being unbuilt — but it is
all still changeable, and shaping it around what the phone needs is easier now
than later.

## 1. The model

Copy these from `src/generated/openapi.json` (`components.schemas`) rather than
this table — but the shapes are:

```
ExchangeThreadSummary   (GET /exchange/threads -> { threads: [...] })
  id                 string
  listingId          string
  listingCommodity   string
  role               "seller" | "inquirer"
  lastMessageAt      string   (ISO 8601)
  closed             boolean
  hasUnread          boolean

ExchangeThread          (GET /exchange/threads/{threadId})
  id, listingId, listingCommodity, role, lastMessageAt, closed   as above
  blocked            boolean
  unreadCount        integer
  messages           ExchangeMessage[]   (oldest LAST is false — see §3)

ExchangeMessage
  id                 string
  senderTenantId     string
  mine               boolean
  body               string | null       (null iff deleted)
  deleted            boolean
  createdAt          string   (ISO 8601)
```

**No decimals anywhere in messaging**, so the string-vs-number trap you have
been bitten by does not arise here. Every timestamp is an ISO 8601 string.
Nothing is optional — every field above is always present.

**Enums: `role` is the only one, and both values are real today.** There is no
planned third. A server-side `NotificationType.EXCHANGE_MESSAGE` exists but
never appears in these DTOs. Your `unknown` sentinel has nothing to catch here,
which is worth knowing so you do not build a case that can never fire.

Write responses:

```
POST   .../thread            201 { id, created }                 created:false = idempotent hit
POST   .../messages          201 { id, createdAt, reopened }     reopened: this send un-closed the thread
POST   .../read              200 { readAt }
POST   .../close             200 { closedAt, alreadyClosed }
POST   .../block             200 { blocked, alreadyBlocked }
DELETE .../block             200 { blocked }
DELETE /exchange/messages/{id} 200 { id }
```

`blocked` and `reopened` were MISSING from the published contract until this
document was written — the server sent them, the schema did not describe them.
Both are in `src/generated/openapi.json` now. Regenerate before you codegen.

## 2. Identity and isolation

**A message identifies its author as a TENANT, not a person.** `senderTenantId`
is an opaque farm id and `mine` is the boolean you should actually render on.
Do not compare `senderTenantId` to your own tenant — the server already knows
which party is asking and has answered for it.

**There is no person, no name, and no contact detail anywhere in these DTOs,
and that is deliberate.** Contact reveal belongs to the *inquiry* flow, which
gates it behind the seller accepting (`contactSharedAt` on
`ExchangeInquiry` / "my interests"). Messaging does not reveal contacts at any
point and must not be used to infer them. So: render "You" / the listing's
`sellerDisplayName` (which may legitimately be the anonymous placeholder), and
do not build a contact card from a thread.

Isolation is party-based RLS: exactly two tenants can read a thread, enforced in
the database rather than by a filter. A third tenant gets 404, not an empty list.

## 3. Reads

**Ordering.** `GET /exchange/threads` is `lastMessageAt` DESC. Inside a thread,
the server selects the NEWEST page and reverses it, so `messages` arrives
**oldest-first (reading order) and is the END of the conversation**, not its
beginning.

**Pagination: there is none.** Both endpoints take a hard `take: 100` and no
cursor. A thread with 101 messages silently loses its oldest, and an inbox with
101 threads loses its quietest. This is the single thing in the contract I
expect to change shape — see §7.

**Unread is per THREAD, on two channels of differing precision:**

- `unreadCount` (thread detail) is exact and **excludes your own messages**.
- `hasUnread` (inbox list) is a cheap timestamp compare, `lastMessageAt > yourReadPointer`.

There is **no per-tenant total** anywhere. If you want a tab badge you must sum
`hasUnread` across the inbox, which is a boolean count, not a message count.

**On your badge warning — you were right, and it found a bug.** Until today
`hasUnread` did not check WHO sent the last message, so sending a message lit
up your own thread as unread. Fixed by moving the sender's read pointer on
send. Two consequences for you:

- the badge is now correct rather than eventually-correct; it is computed per
  request from timestamps, not cached, so there is nothing stale to render
  around;
- replying without opening a thread marks the other party's earlier messages
  read. If you add reply-from-notification, that is the trade you are taking.

## 4. Writes — idempotency

**No exchange route honours `Idempotency-Key`. Build the client to tolerate
duplicates.** A double tap on a bad connection creates two messages.

Your map of which usecases honour it is close but wrong in two places, measured
just now against the route files:

| honours `Idempotency-Key` | does NOT |
|---|---|
| `farm-tasks`, `journal` (+ `[id]`, `[id]/files`), `locations/[id]/operations` (field operations), `grain/costs`, `grain/yield-records` | `exchange` (all), `insurance`, inventory |

So **grain partly does** (costs and yield-records), and **inventory does not** —
both the opposite of what you had.

One exception worth using: **opening a thread IS idempotent**, structurally
rather than by header — unique on (listing, inquirer). `POST .../thread` returns
the existing thread with `created: false`. Safe to retry, and safe to wire to a
button that is always visible.

## 5. Failure shapes

**There is no 409 in messaging at all.** Do not write a conflict branch; it can
never fire. The complete set, enumerated from source:

| status | codes |
|---|---|
| 400 | `MESSAGE_EMPTY`, `MESSAGE_TOO_LONG`, `THREAD_OWN_LISTING` |
| 403 | `THREAD_NOT_A_PARTY`, `THREAD_BLOCKED`, `BLOCK_SELLER_ONLY`, `MESSAGE_NOT_SENDER` |
| 404 | `THREAD_NOT_FOUND`, `LISTING_NOT_FOUND`, `MESSAGE_NOT_FOUND` |

The one with meaning beyond "it failed" is **`THREAD_BLOCKED` (403)** — the
seller has refused contact. It is not retryable and not a transient error, and
`GET /exchange/threads/{id}` returns `blocked: true` so you can say so *before*
the user types rather than after they hit send.

Match on `error.code`, never on the English message: that text is a fallback for
an unrecognised code, not display copy.

## 6. Delivery — it exists, and it is not a socket

For the first version the web **polls**: 30s for the inbox, 5s for an open
thread. Both are capped, indexed queries.

But there is also a real push path, already shipping: every message writes an
in-app `Notification` row and publishes it on an **SSE bus keyed by
`(tenantId, userId)`**. That carries the *notification*, not the message body.

**There is no APNs or web-push, and no message socket.** Adding either is a
server decision, not something to design around yet.

**There is no "has anything changed" endpoint.** The inbox list is the cheap
check — it is one indexed query capped at 100 rows and returns no message
bodies. Polling that and refetching only threads whose `lastMessageAt` moved is
the efficient shape.

**Recommendation:** design a screen that REFRESHES, not one that streams. If you
want better than polling, subscribe to the notification stream and refetch the
affected thread when one arrives — that is the closer analogue of what a phone
should do, and it does not depend on a transport that does not exist.

**Notification cadence differs by channel, deliberately** — model any future
push on the in-app one:

- in-app / SSE: **one per message**, no dedupe. This is the accurate signal.
- email: **one per thread per recipient per UTC day**, deduped silently.

A push built on the email cadence would be wrong from the second message of a
conversation onward.

## 7. What not to build yet

- **Anything assuming pagination.** The `take: 100` cap will become a cursor,
  and that will change the response shape of both read endpoints. Render what
  you are given and do not build an infinite scroll against it.
- **A message socket.** It does not exist.
- **A contact card built from a thread.** Contact reveal is the inquiry flow's,
  and coupling the two would route around a consent gate.
- **A per-tenant unread total.** There is no endpoint for it; summing the inbox
  is a count of threads, not messages, and labelling it otherwise is the wrong
  badge you warned about.

## Still open

- **Rate limiting.** None today. The owner chose seller-side blocking over send
  caps, so volume from many buyers is unbounded. If the phone adds retry-on-
  failure, make it bounded — the server will not stop you.
- **Cursor pagination**, as above: known gap, shape undecided.
