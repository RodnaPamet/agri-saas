# 2026-11-07 — P8.4: direct messages on the exchange messaging surface

**Commit:** `<pending> feat(social): direct messages on the exchange messaging surface`

## Design

Owner ruling 2026-11-07, in two parts: **«Съобщения» stays with the exchange**
("no need of a duplicate, only exchange stays"), and **DMs go INTO that
surface** — so there is no `/messages` route and no new bottom-bar tab.

```
/t/{slug}/exchange/threads            ← ONE inbox
    ├─ tenant-scoped  GET /api/t/{slug}/exchange/threads   (audience UNCHANGED)
    └─ person-scoped  GET /api/social/inbox?source=dm      (NEW param)

/t/{slug}/exchange/threads/dm/{conversationId}   ← one conversation
    └─ P8.3 primitives: MessageTimeline + MessageComposer
```

`dm/` is a STATIC segment beside the existing `[threadId]`, and Next resolves
static before dynamic — so `threads/dm/<id>` can never be read as a thread
whose id happens to be `dm`, and neither route has to inspect the other's ids.

## Files

| file | role |
|---|---|
| `src/app-layer/usecases/inbox.ts` | `listInbox` gains `sources?: InboxSource[]`; an excluded half is not queried |
| `src/app/api/social/inbox/route.ts` | `?source=dm,exchange`, validated; an unrecognised value is a 400 |
| `.../exchange/threads/page.tsx` | the gate became a DISJUNCTION — see below |
| `.../exchange/threads/ThreadsClient.tsx` | one merged, time-ordered list of both kinds |
| `.../exchange/threads/dm/[conversationId]/page.tsx` | flag-gated, `notFound()` when off |
| `.../dm/[conversationId]/DmConversationClient.tsx` | timeline, composer, accept/decline, mark-read |
| `src/lib/openapi/paths/direct-messages.paths.ts` | the `source` param and `INVALID_SOURCE` |
| `messages/{bg,en}/app.json` | 11 new `chat.*` keys |

## Decisions

- **The page gate is a disjunction, and that is the substantive change.** It
  was `requireModule(ctx, 'EXCHANGE')` — correct for exchange threads, whose
  old docblock said why: "a thread only exists because two farms are
  negotiating on the marketplace". It is wrong for a direct message, which
  depends on no module. Left alone, a farm that switched the marketplace off
  would **lose its direct messages**, and because the gate REDIRECTS the
  symptom is "my messages vanished" rather than an error anybody could act on.
  Measured on production before changing it: **3 live tenants, 0 with
  customised `TenantModuleSettings`, so 0 with EXCHANGE off.** It costs nobody
  today, which is exactly why it would have shipped. Each half now gates on its
  own condition; neither available still redirects, so a tenant with no
  marketplace and no DMs behaves as before. Relaxing the module gate wholesale
  would have been the opposite mistake — exchange threads open to a tenant
  whose plan excludes the marketplace.

- **`listInbox`'s exchange half is deliberately NOT used by this screen.** It
  looked like the tidy merge and is a regression: that half is person-scoped,
  admitting the caller only as inquirer or the listing's seller, and does not
  reproduce `exchange_thread_audience`, which also admits either farm's
  OWNER/ADMIN. Backing the screen with it would silently REMOVE rows an owner
  sees today. Hence `?source=dm` and the screen keeping its own tenant-scoped
  query. The parameter is a disclosure lever, not an optimisation, which is why
  an unrecognised value is a 400 rather than a fallback to both — a fallback
  would render some exchange threads twice, from two different audiences.

- **A DM list is identical under every farm, and that is inherent.** The route
  is `/t/{tenantSlug}/…` while a DM has no tenant, so a member of three farms
  sees the same conversations under all three. Raised before the ruling and
  chosen anyway. It must not be "scoped" later: the DM policies key on
  `app.user_id`, which `runInTenantContext` does not set, so a tenant-scoped
  read returns zero rows with no error (#1664).

- **The read cursor is frozen on arrival.** The screen marks itself read
  immediately, so a divider derived from live data would vanish under the
  reader a moment after they got there. `firstUnreadId` is computed from the
  FIRST payload and held in a ref.

- **A REQUEST has three shapes and only one gets a composer**: accepted → the
  composer; opened by someone else → accept/decline (P8.1's rule lives on
  `lastMessageAt` being NULL, so the recipient answering is what opens the
  conversation); opened by me → a stated wait, because the server would refuse
  a second message and a composer that fails is worse than none.

- **No "load older" control, measured rather than forgotten.** Production has
  **0 conversations and 0 direct messages** and the page size is 100, so nobody
  can reach a second page. #2826 owns paging AND anchoring together: anchoring
  with nothing to prepend is untestable, paging without it ships a visible
  jump.

- **`BlockPersonButton` yes, `ReportButton` no (#2833).** `captureSnapshot`
  resolves `MESSAGE` against `prisma.exchangeMessage`, so a notice about a
  direct message would be filed with `SUBJECT_NOT_FOUND` as its evidence — and
  since the response discloses nothing about the subject by design, the
  reporter could not tell that from a successful report. Worse than not
  offering the control.

- **The request badge is a PHRASE, not a coined noun.** «Заявки» is the obvious
  label and is spoken for by `exchange.nav.myInterests` («Моите заявки»), which
  the owner kept. A per-row «Чака Вашия отговор» says the same thing and coins
  nothing; a separate bucket would need a ruling this PR does not have.

- **The breadcrumb reads `exchange.messaging.inboxTitle`**, not a second
  `chat.*` copy of «Съобщения». A breadcrumb naming a destination must render
  the same value that destination's own title does — two copies is how a
  surface ends up with two names.

## Two mutations survived the first green suite

Both on the properties the conversation client's docblock makes the most noise
about, and both were real gaps rather than near-misses:

- **"marks read once per conversation"** — the rerender passed the SAME `data`
  object, so `useEffect`'s `[data, path]` deps were unchanged and React never
  re-ran it. Deleting the guard changed nothing. A real poll parses new JSON,
  so the fixture now re-renders with a fresh, equal object.
- **"the divider is frozen"** — the suite never asserted the divider at all,
  and `lastReadAt` never moved in the fixture, so recomputing gave the same
  answer. There is now a case where the cursor moves PAST the unread message
  between renders, plus a control asserting a caught-up reader gets no divider
  (so "always on" cannot satisfy the freeze).
