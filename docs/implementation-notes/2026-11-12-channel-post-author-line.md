# 2026-11-12 — a channel post shows name + farm

**Issue:** #2989. **Owner decision:** every channel post and reply shows name
+ farm, e.g. «Иван Петров, ЗК Победа» (2026-11-12), and a member's name
becoming visible to other farms in public channels was accepted.

## Design

Three pieces, and the third is the one that would have been left out.

**The name** comes from a PUBLISHED `PersonProfile.displayName`. `User.name`
was rejected deliberately: it is encrypted *because* it is PII and is
published nowhere in the product, so rendering it to every authenticated
person in a public channel would cross a boundary somebody built on purpose —
and as a *fallback* it would cross it silently, for whoever never set a name,
which was everyone. The fallback is the farm alone.

**The farm** is `ChannelPost.authorTenantId`, recorded at write time. Resolved
at read it would mutate history: the only rule available is the DM
recipient's (oldest membership, then id), and under it a person who leaves a
farm has every past post relabelled, and a post made as farm A comes to read
as farm B.

**The entry point** is `PUT /api/social/profile`, prompted from the composer.
Production held **zero** `PersonProfile` rows because nothing in the product
ever wrote one, so without this every post shows the farm alone for ever —
#2844 a third time, and no guard would notice, because `pages-are-reachable`
governs screens and this is not a screen.

## Where #2989 was wrong, and what changed because of it

It says to take the farm from "the tenant slug already present in the posting
request's own path". There is no such slug: channel routes are
`/api/social/channels/...`, person-scoped, because the channel policies key on
`app.user_id` and a tenant route would read zero rows with no error (#1664).
The PAGE is at `/t/{slug}/channels`; the API is not.

So the client supplies `tenantSlug` and the usecase validates it against an
ACTIVE membership. A slug the caller is not in is REFUSED rather than
downgraded to null — the client is asserting "I post as this farm" and the
assertion is false — with one code covering "no such farm" and "not your farm",
so this is not an enumeration oracle for slugs. A MISSING slug records null
rather than guessing: applying the read-time rule at write time is the same
guess, merely frozen into a row.

## Files

| file | role |
|---|---|
| `prisma/schema/channels.prisma` | `authorTenantId String?`, with the counterparty-safety note the guard requires |
| `prisma/migrations/20261112220000_channel_post_author_tenant/` | additive, nullable, no FK, no index |
| `src/app-layer/usecases/channels.ts` | `resolveAuthorTenantId` (write), `resolveAuthors` (read), `toPostView` |
| `src/app-layer/usecases/person-profile.ts` | the display-name read and write |
| `src/app/api/social/profile/route.ts` | GET (the signal) and PUT |
| `src/lib/schemas/index.ts` | `tenantSlug` on both post schemas, `SetDisplayNameSchema` |
| `src/lib/openapi/paths/channels.paths.ts` | the `author` field and the new route, documented rather than baselined |
| `src/components/chat/message-timeline.tsx` | `senderLabel` per MESSAGE |
| `.../channels/[channelId]/DisplayNamePrompt.tsx` | the composer prompt |
| `tests/integration/p9-author-line.test.ts` | 9 executing tests |
| `tests/integration/person-display-name.test.ts` | 7, through the FEED |

## Decisions

- **Giving a name PUBLISHES it.** `published` defaults false, so a writer that
  set `displayName` and left the flag alone would change nothing visible — the
  dormancy this issue is about, one level down. The person's own act is the
  consent, and the copy says so: «Името Ви ще се вижда от други стопанства».
  Clearing the name unpublishes, which is the honest inverse.

- **The prompt gates on `social.channels`, not a flag of its own.** Two flags
  means an operator can enable channels while leaving the name editor off,
  which is exactly the state this issue exists to prevent. One switch, so the
  entry point cannot be dark while the feature needing it is live.

- **The route is under `/api/social/`, not `/api/account/`.** That family is
  exempt from the #1655 deletion freeze on the reasoning that self-service
  account management is not "content". A public display name IS content.

- **`senderLabel` became a property of the MESSAGE.** `MessageTimeline`'s
  resolver is keyed by `senderUserId`, which is right for a DM, where the
  label belongs to the sender. A channel label belongs to the post: one person
  can have posted in the same channel as two farms, and a userId-keyed
  resolver would relabel the older posts with the newer farm — the read-time
  guess the column exists to avoid. Same shape and reason as the `deleted`
  field that file already carries.

- **`author` is NULL on a hidden post** — owner ruling, relayed 2026-11-12:
  "no author line on a removed post, its time only". The body is already
  empty, and naming somebody above content nobody can read attributes an
  accusation to them. The timestamp stays, so the gap in a thread is still
  placed in time. It cannot leak which of the three removals applied, because
  they collapse before this point. #2989 had flagged this as open; it is now
  settled in the direction already built.

- **The display name is OPTIONAL** — owner ruling, relayed 2026-11-12: «Не
  сега» posts with the farm alone, and a name is never required before a first
  post. So the prompt is dismissible and the dismissal is remembered, and the
  farm-alone line stays a designed state rather than a degraded one.

- **Written into the SAME collapse as the empty body**, in `toPostView`, so a
  reader sees one rule for one state and the two cannot drift. That mapper
  stays the only one: #2961 is the case where a second read path returned what
  the first one hid.

- **Two queries per page, never one per post.** The D1 guardrail refuses a
  Prisma read in a loop, and P9.3d had to be rewritten into this shape. Both
  tables are outside RLS, so the lookups run on the `tx` the feed already
  holds — a privileged read would take a second pool connection while holding
  one, which is #1191's P0.8 deadlock.

- **`published: true` is the only fence, and that is tracked.**
  `PersonProfile` has RLS disabled — measured, `relrowsecurity` false — so
  nothing in the database withholds an unpublished name if that clause goes.
  The negative control in `p9-author-line` is what fails if it does, and
  **#3007** proposes the policy that would make the database the backstop
  again.

- **One PR rather than two, deliberately.** P9 ships schema a release ahead of
  its writer; P8.6 weakened that for an additive nullable column on an
  existing table, with the reason written down — the rule exists so a NEW
  TABLE precedes its writer, and a nullable column carries neither the
  rollback risk nor the policy risk. Stated explicitly, as #2989 asked, rather
  than by omission.
