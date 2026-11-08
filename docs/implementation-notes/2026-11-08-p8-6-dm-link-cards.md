# 2026-11-08 — P8.6 link cards (#2800)

**Commit:** `<pending>` feat(social): link cards in a direct conversation

## Design

A link card is a SNAPSHOT of a third-party page, taken when the message is
sent and never refreshed. Four nullable columns on `DirectMessage`
(`linkUrl`, `linkTitle`, `linkDescription`, `linkFetchedAt`), a bounded
best-effort fetcher, and the card in the conversation payload.

```
  POST /api/social/conversations/{id}/messages { body, linkUrl? }
        │
        │  linkUrl: httpsUrl().optional()        ← contract narrowing
        ▼
  sendDirectMessage
        │
        ├─ fetchLinkCard(linkUrl)                ← OUTSIDE the transaction
        │     requireHttpsUrl                    (a second caller's guard)
        │     _fetchCardAt
        │        fetchPublicUrl  redirect:'manual', host policy EVERY HOP
        │        128 KB cap, 3 s timeout, HTML content types only
        │        extractMeta → sanitizePlainText → slice
        │     every failure ⇒ { url, null, null, fetchedAt: null }
        ▼
  prisma.$transaction
        └─ create { …, linkUrl, linkTitle, linkDescription, linkFetchedAt }
                     with sanitizePlainText applied BY NAME at the write
        ▼
  readConversation ⇒ messages[].linkCard  { url, title, description, fetchedAt }
                     messages[].attachment { mime, bytes, sha256 }
```

### Why the fetch is synchronous and in the request path

The house pattern for an external call is a job — soil goes to SoilGrids on
BullMQ, `notice-score` is scheduled. This one is not, because the card is
OPTIONAL. If the fetch fails, times out, or the page carries no metadata, the
message sends with `linkUrl` set and no title: there is no "the card arrives
later" state to design, no second realtime publish, and no job that can
silently stop running.

What makes that safe is the bound: a 3-second timeout, a 128 KB read cap, and
every failure path returning an empty card rather than throwing. The worst
case for a sender is the timeout, not a refused send.

### Why it is fetched BEFORE the transaction

An external fetch inside an open transaction holds a pool connection for its
whole duration. `PG_POOL_MAX` is 12, so twelve concurrent sends each holding a
slot for three seconds is #1191's P0.8 shape. The card is resolved first and
the transaction only writes.

### `fetchedAt: null` is the discriminator

A refused fetch and a page with no metadata produce the same empty title, so
one of them has to carry a mark. A refusal leaves `fetchedAt` NULL; a page
that answered but had nothing stamps a time. Without that, a client cannot
tell "we could not read this link" from "this link has no preview", and
neither can a reader six months later looking at a stored row.

## Files

| file | role |
|---|---|
| `prisma/migrations/20261108010000_p8_6_dm_link_cards/migration.sql` | the four columns; drops and recreates the `says_something` CHECK to add the `linkUrl` arm |
| `prisma/schema/social.prisma` | the columns, and why they arrive WITH their writer |
| `src/lib/security/encrypted-fields.ts` | `DirectMessage: ['body', 'linkTitle', 'linkDescription']`, and why `linkUrl` is not there |
| `src/app-layer/usecases/direct-message-link-cards.ts` | NEW — `fetchLinkCard`, `requireHttpsUrl`, `_fetchCardAt`, the caps |
| `src/app-layer/usecases/direct-messages.ts` | the fetch before the transaction, the write, the retraction, and the card + attachment in `readConversation` |
| `src/lib/schemas/index.ts` | `linkUrl: httpsUrl().optional()` on `SendDirectMessageSchema` |
| `src/lib/openapi/paths/direct-messages.paths.ts` | `linkCard` and `attachment` on the message schema, `DM_LINK_URL_INVALID` |
| `messages/{en,bg}/app.json` | `errors.DM_LINK_URL_INVALID` in both locales |
| `tests/guards/conversation-columns-are-counterparty-safe.test.ts` | a note per new column |
| `tests/unit/social/dm-link-cards.test.ts` | NEW — the fetch, against real `http.Server`s |
| `tests/integration/p8-6-dm-link-cards.test.ts` | NEW — storage, sanitisation at rest, ciphertext, retraction, RLS |
| `tests/integration/p8-6-dm-photos.test.ts` | the photograph in the timeline (see below) |

## Decisions

- **`linkImageKey` was dropped before merge, and `#2855` holds it.** Both
  earlier drafts of this migration added one. Nothing writes it: the fetcher
  reads two meta tags and never fetches an image. A column whose safety
  argument has no writer to check it against is what the migration's own
  header argues against, and `conversation-columns-are-counterparty-safe`
  would have wanted a sentence about what the counterparty reads from a
  column that holds nothing. Storing a preview image is also not a column: it
  is a DECODE of bytes a hostile server chose, so it needs `scanOrRefuse`
  before `stripImageMetadata`, a key, a storage write and an egress route
  gated by participation — the whole record-less upload shape.

- **`linkUrl` is PLAINTEXT and the two text columns are encrypted.** The text
  is what somebody chose to share, and it is as revealing as what they typed
  about it, so it goes under the global KEK with `body`. The URL stays
  readable because the inbox preview and any future unfurl cache read it with
  no tenant in scope, and because a URL is the one part of a card the
  recipient was always going to see in full. It is a judgement, recorded in
  `ENCRYPTED_FIELDS` as one, and it is revisited with the image on #2855.

- **Sanitised in TWO places, deliberately.** The fetcher sanitises because
  that is where untrusted remote text enters the process; the write names the
  field so `sanitize-rich-text-coverage`'s field-level detector covers it
  directly, which that guard calls stronger than per-field rather than
  weaker. The alternative was a `SEAM_COVERED` exemption, and an exemption
  describing a seam can outlive the seam. `sanitizePlainText` strips tags and
  trims, so it is idempotent and the second call costs nothing.

- **`requireHttpsUrl` and `_fetchCardAt` are separate functions, and the
  split is a TEST SEAM.** The subject of the fetch tests is what undici does
  with a `Location` header, so they drive real `http.Server`s on loopback — a
  mocked fetch would assert my understanding of undici back to me. The scheme
  pin correctly refuses those URLs. Splitting makes both testable; the
  alternative was a `NODE_ENV`-gated loopback exemption inside a security
  check, which is the kind of hole that reads wrong a year later.
  `_resetDnsVerdictCache` one module over is the precedent for the
  underscore.

- **The redirect test needed TWO loopback hostnames.** With both servers on
  `127.0.0.1` the DNS stub cannot tell them apart, so blocking the target
  blocked the hop as well and the test passed for the wrong reason — measured:
  `hop.hits` was 0, meaning the first request never left. The target now sits
  on `127.0.0.2`, and the assertion is that the hop WAS reached and the target
  was not.

- **`sanitizePlainText` decodes entities AFTER stripping tags, so
  `&lt;script&gt;` round-trips into literal `<script>` text.** Measured on
  five inputs. That is the opposite of what its own docblock claims, and it is
  filed as #2854 rather than fixed here: 139 call sites, and the fix changes
  what all of them store. It is pinned by a test carrying the issue number, so
  the fix lands against a red assertion instead of silently disagreeing with
  one. Not an injection today — React escapes it and `script-src` carries no
  `unsafe-inline` — and it matters more here than at the other 138 sites,
  because this is the first caller whose input is adversarial by default.

  *(Superseded 2026-11-08 by #2854: `sanitizePlainText` decodes to a FIXED
  POINT before stripping and is idempotent. The single pass this note argues
  for is unchanged and still correct; its reason is now C.5 placement rather
  than the harm measured above.)*

- **The PHOTOGRAPH was missing from the timeline too, and that is fixed in
  this diff.** P8.6's photo half (#2852) shipped `sendDirectPhoto` and
  `readDirectPhoto` and never added the attachment columns to
  `readConversation`'s select, so a client reading a conversation saw a photo
  message as `body: null` with nothing saying a photograph existed —
  fetchable by a client that already knew, invisible to one reading the
  payload. Adding `linkCard` without it would have shipped a payload that
  describes link cards and not photographs, which reads as a decision. Both
  are sub-objects rather than loose columns so "is there one" is a single
  null check, and `attachmentKey` is deliberately NOT in the payload: the
  egress route is derived from the message id, and it authorises by RLS
  participation rather than by possession of a key.

- **Two mutations survived the first green integration run, both on the
  `deletedAt` arm of the mapping.** The delete clears the columns, so
  `!m.linkUrl` answers first and the extra check is unreachable through any
  normal path. The arm's only reason to exist is the state the delete is
  supposed to prevent — and the CHECK permits that row, since `deletedAt IS
  NOT NULL` is its first arm — so both suites now create such a row directly
  rather than trusting the writer the arm is a backstop for.

- **`DM_LINK_URL_INVALID` is documented though it is unreachable through the
  route.** `httpsUrl()` makes a non-https value `INVALID_BODY` at the
  boundary. The code exists for a second caller arriving without the schema,
  and it ships with both locale entries because a refusal code with no
  catalogue entry is one a client cannot show anybody.

- **The migration does not edit its predecessor.**
  `20261107150000_p8_6_dm_media` names `linkImageKey` in its own forward plan,
  and that sentence is superseded by a paragraph in the new file rather than
  corrected in place: an applied migration's checksum is recorded in
  `_prisma_migrations`, so changing even a comment makes `prisma migrate
  deploy` refuse the whole history.
