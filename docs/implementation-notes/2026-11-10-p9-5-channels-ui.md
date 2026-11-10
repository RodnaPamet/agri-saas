# 2026-11-10 — P9.5: «Канали», the channel web UI

**Issue:** #2939. **Owner rulings (2026-11-10):** the noun is **«Канали»**, and
it lives as a **sidebar item in the «Пазар» section**.

## The naming, and a recommendation that lost to a measurement

I recommended «Общности», on the grounds that «канал» is an irrigation channel
— a ditch — to a Bulgarian farmer, and that this product's vocabulary is
otherwise plain concrete farm nouns («Блокове», «Парцели», «Силози»).

Measured afterwards: **six catalogue values contain «канал», five of them
P9.3's own refusals** (`CHANNEL_ARCHIVED` → «Този канал е затворен», plus
`CHANNEL_BANNED`, `CHANNEL_NOT_A_MEMBER`, `CHANNEL_NOT_FOUND`,
`CHANNEL_SLOW_MODE`). The sixth is «по друг канал» in an access-review email —
the communication sense. The irrigation sense appears **nowhere**.

So the word already ships as this product's name for this concept, and
renaming the surface would have left five refusals using a noun the nav did
not. The objection did not survive the measurement.

Placement: not a bottom tab. The cap is five, the defaults are
dashboard/farm-tasks/locations/journal/exchange, and those path strings are
shared vocabulary with iOS — so a new tab displaces something AND needs a
coordinated change with agrent-ios (#2942).

## The one new mechanism: a nav item gated on a FLAG

Every other `visible:` in `useNavSections()` reads `tenant.availableModules`.
`social.channels` is a feature flag, and flags are server-only by design —
there is no client-side flags hook, and adding one would be a second source of
truth for a kill switch (P5.3).

The precedent was already in the tree: the tenant layout resolves
`googleIntegrationEnabled` with `isFeatureEnabled` inside its existing
`Promise.all` and carries it on `TenantProvider`, with a comment saying it is
there precisely because there is no client flags hook (#2019). `channelsEnabled`
joins that same awaited call, so it costs no extra latency.

Two consequences, both asserted:

- **The polarity is INVERTED against its neighbours.** Theirs degrade to
  "available" when absent; this degrades to HIDDEN. `social.channels` is
  default-OFF, so for most tenants the surface answers 404, and a nav item
  leading to a 404 is worse than an absent one. An old session predating the
  field carries nothing, which must read as hidden.
- **It is NOT ANDed with the EXCHANGE module**, even though it renders inside
  the «Пазар» section. P8.4 is the instance: a farm that switched the
  marketplace off would lose a surface unrelated to it, and because a module
  gate REDIRECTS the symptom is "my channels vanished" rather than an error.

## Reuse, not reimplementation

`MessageTimeline`, `MessageComposer` and `buildTimelineRows` are P8.3's and are
mounted as they are. Three things carried across:

- **The feed is newest-first; the timeline is oldest-first.** The adapter
  REVERSES, once, and that is the only place the two orders meet. Reversing in
  the usecase or asking the API for ascending order would change what `before`
  means and break the keyset.
- **The anchoring policy is a copy of the DECISION, not of the code** (#2826):
  capture before the fetch, restore in a layout effect after the commit. It
  lives on the page because only the page knows a prepend is happening — a
  timeline that anchored on every render would impose one policy on every
  future consumer.
- **The composer's return value is load-bearing.** It clears on anything that
  is not `false`, and its docblock records the cost: text used to be cleared
  unconditionally and synchronously, so a failed send lost the operator's
  words. A channel post fails for reasons they can act on — slow mode, a ban, a
  refused mention — so the handler returns `false`.

## `TimelineMessage.deleted` — three lines so neither path lies

The primitives take `deletedAt?: Date | null` and `MessageBubble` reads it as
`Boolean(deletedAt)` — pure truthiness, never displayed. `ChannelPostView`
gives `deleted: boolean` instead, because the feed COLLAPSES three removal
columns so a reader cannot tell a moderator's act from the author's.

Passing `deletedAt: post.createdAt` would render correctly today and write a
false fact into a field named for a time, which the next person to render
«изтрито преди 5 минути» would display with nothing failing. The optional
boolean is additive; the DM path still passes a timestamp.

## Grouped by the KEY PREFIX, not by `kind`

P9.2 made the prefix load-bearing: an input channel is `TOPIC` with an `input:`
key, because suggestion treats crops and inputs differently. Grouping on `kind`
would file the five input channels under a heading that stops being true the
first time a `TOPIC` is added that is not an input.

Unrecognised prefixes fall into a final group rather than vanishing: a channel
the directory omits is one nobody can join, and `listChannels` already filters
archived ones, so an absence here would be indistinguishable from a retirement.

## Leaving goes through the undo toast, and the exemption I nearly wrote was false

Epic 67's derived layer caught the `apiDelete` and required this file to answer
for itself in one of four ways. The tempting answer was an EXEMPT entry reading
*"leaving is reversible from the same button, so ceremony around it is ceremony
around an undoable action"* — which is `BlockPersonButton`'s exemption almost
verbatim, and it is **false**.

Leaving DELETES the `ChannelMembership` row, and that row carries `lastReadAt`
and `mutedAt`. Rejoining writes a FRESH row (`@@unique([channelId, userId])`),
so a misclicked Leave loses the read cursor — where «Нови съобщения» would
sit — and any mute. `joinedAt` is the one field on it nothing reads, which is
what made "lossless" sound plausible; the two that matter are the two a reader
would notice.

So Leave is deferred five seconds and Undo cancels it before it reaches the
server. **Join stays immediate**: it is additive, and an undo window on it
would delay the thing the person asked for. The rendered test asserts both
directions, because if both went through the toast the deferral test would
pass while nothing was ever immediate.

The toast's TRIGGER is captured in the test rather than its rendering: sonner
renders into a portal and no `<Toaster>` is mounted, so asserting the toast's
text graded the portal. Running the captured `action` is the assertion that
separates "a toast was shown" from "the toast was given the right thing to
do" — a trigger handed a no-op satisfies every other assertion and silently
never leaves the channel.

## Mutation proofs

Twelve mutations; eleven kill exactly the intended assertion.

| mutation | assertion that went red |
|---|---|
| group by `kind` | groups by the KEY PREFIX |
| drop the «Други» group | groups by the KEY PREFIX |
| anchor AFTER the fetch | the anchor order (and the failure case) |
| no reversal | REVERSES the feed |
| fabricate `deletedAt` | a hidden post renders DELETED from the boolean |
| composer for everyone | NON-MEMBER and BANNED cases |
| `send` returns true on failure | a FAILED post KEEPS the text |
| nav ANDed with EXCHANGE | PRESENT with the EXCHANGE module OFF |
| nav truthy polarity | ABSENT when the flag is UNDEFINED |
| Leave fires immediately | leaving DEFERS the DELETE |
| the toast's action is a no-op | leaving DEFERS the DELETE |
| **clear the anchor on failure** | **SURVIVED — recorded as defensive** |

**Two survived the first attempt, and both were the TEST's fault.**

`group-by-kind` survived because the «Други» group filters by PREFIX either
way, so under the mutation the stray `TOPIC` landed in BOTH groups and every
assertion still held. What separates the two rules is that the input group must
EXCLUDE it, plus an assertion that no channel renders twice — which is the
shape the surviving mutation actually produced.

`keep-anchor-on-failure` survives for a reason worth recording rather than
renaming around: the layout effect fires on a change to `older`, only a
successful page changes `older`, and that page captures its own anchor before
fetching — overwriting any stale one. So the clearing has no commit to fire on
in this code path. It stays as a guard against a future commit path that does
not re-capture, and the test now claims only what it can observe: a failed page
does not move the reader.
