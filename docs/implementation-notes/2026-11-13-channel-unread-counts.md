# 2026-11-13 — the channel read cursor and unread counts

**Commit:** (this branch) `feat/2990-unread-counts`

## Design

#2990. `ChannelMembership.lastReadAt` was declared by P9.1 and **written by
nothing**. Its only consumer was the Art 15 export — which is worse than dead,
because a column read by a real consumer does not look dead to a keyword
sweep. And `channel_membership_update`, the RLS policy that permits this write,
carried a docblock whose only stated justification was the write nobody had
built.

```
POST /api/social/channels/{channelId}/read   → { lastReadAt }
GET  /api/social/channels                    → each item gains unreadCount
```

Nothing in the schema or the policies changes. The permission was already
granted and simply unused.

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/channels.ts` | `markChannelRead`, `unreadByChannel`, `ChannelListItem.unreadCount` |
| `src/app/api/social/channels/[channelId]/read/route.ts` | the mark-read call |
| `src/generated/route-inventory.json` | +1 path, append-only ledger |
| `tests/integration/p9-unread-counts.test.ts` | eleven cases against a real database |
| `CLAUDE.md` | P9.5's `joinedAt` claim, corrected |

## Decisions

**`unreadCount` is NULL for a channel the caller has not joined, never 0.** A
count for a channel you are not in is meaningless, and 0 reads as "joined and
caught up" — the two states a badge most needs to tell apart.

**It counts TOP-LEVEL posts only.** The badge means "N new posts in the feed
you are about to open", and the feed filters `parentPostId: null`. Counting
replies would badge activity opening the channel does not show — and because
the cursor is a TIME, the badge would then clear anyway, which is a lie that
covers its own tracks. A reply you should know about reaches you through the
mention/reply push instead (#2987). The badge is feed activity; the
notification is about you.

**A never-read channel counts from `joinedAt`.** Reading NULL as `-infinity`
hands a brand-new member of a 2,000-post channel a badge of 2,000; you are not
unread on posts from before you joined.

**A hidden post is gone, not unread.** The same three removal columns
`toPostView` collapses. Counting one produces a badge reading can never clear,
because the post will never appear in the feed.

**Own posts do not count.** Posting must not badge the channel you posted in.

## The count is raw SQL, and that is the smaller evil

The threshold is PER ROW: each membership carries its own `lastReadAt`, so no
`groupBy` expresses it — a grouped count filters on one `createdAt` boundary,
not a different one per channel. The alternatives were a count per channel,
which is the N+1 the D1 guardrail refuses, or reading every post newer than the
EARLIEST cursor and counting in memory, which is an unbounded read to answer a
bounded question.

P5.5b's anti-join is the precedent, and the thing that made it careful does not
apply: it had to hand rows back to Prisma because `ContentReport.detail` is
encrypted and raw SQL would have scored ciphertext. `ChannelPost.body` is
plaintext (P9.1, so P9.7 can search it) and nothing here reads a body — this
returns counts.

RLS still scopes the join. Inside `runInUserContext`,
`channel_membership_select` admits the caller's OWN rows only, which is why the
join needs no `userId` predicate and could not be widened by forgetting one. A
tenant context would set `app.actor_user_id` instead and this would silently
count zero (#1664).

## The defect the suite caught, and why the precedent did not cover it

The cursor guard is `lastReadAt: { lt: at }` — `markReadFor`'s precedent in
`exchange-messaging.ts`, for its reason: a stale client must not move the
cursor backwards and resurrect read posts as unread.

**`{ lt: at }` does not match a NULL column.** In the exchange the whole ROW is
absent until the first read, so its create branch covers that case. A
`ChannelMembership` row exists from the moment somebody joins, with
`lastReadAt` NULL — a case the exchange does not have. So the FIRST mark-read
on every channel wrote nothing and returned the caller's own timestamp as
though it had: a badge that never clears, from a function that lies about why.

Three of eleven cases failed on it. The tell was the returned value being the
timestamp SENT rather than the one STORED, which is why the function reports
the stored cursor on a no-op rather than echoing its input — that is how a
stale client learns the real value instead of being told its own number back.

A precedent copied correctly and applied to a case it does not cover.

## `updateMany` rather than `update`, and the count is the answer

`update` on a composite unique throws when the row is absent OR when the guard
excludes it, and those are different outcomes: not a member (refuse) against
already at or ahead of `at` (fine). `updateMany` returns a count, so a zero is
then checked against a separate membership read rather than inferred from an
error. There is deliberately no create branch: an insert here would be a second
`ChannelMembership` writer, which `channels-are-never-auto-joined` refuses by
name, and `channel_membership_update` would not admit it anyway.

## Two test faults of my own, both worth naming

A call missing its `channelId`, which typechecked because the third parameter
is optional and the second is not — so it failed at runtime rather than at
compile time.

And an assertion on the error MESSAGE rather than the `code` property. It would
have passed today and broken the moment the sentence was reworded
(`coding-a-throw-changes-the-copy`), while not asserting the thing a client
reads.

## A claim corrected rather than left

CLAUDE.md's P9.5 section said `joinedAt` was "the one field nothing reads,
which is what made 'lossless' sound plausible". It has a reader now. So all
three columns on the membership row are load-bearing, and leaving a channel
costs the read cursor, any mute, AND the boundary the first unread count is
measured from — which makes the Leave undo toast MORE justified than when it
was argued for. The badge is also the first thing that makes that loss visible
to a person, since a rejoined channel reads as entirely unread.

## Not in scope, and now owned

`mutedAt` — #2990 excluded it because "a mute with no push is inert", pointing
at #2987. That PR shipped the push and closed without a writer, so the
exclusion's premise went false and the column was orphaned between two issues.
Filed as **#3042**.
