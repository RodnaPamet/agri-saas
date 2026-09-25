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
