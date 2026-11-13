# 2026-11-13 — the channel mute gets its writer

**Commit:** (this branch) `feat/3042-mute-writer`

## Design

#3042. `ChannelMembership.mutedAt` was **honoured and unwritable**. P9.1
declared it; #2987 made it mean something — `reachableTargets` filters on it
for every mention and reply, so a muted member is not pushed to — and nothing
could set it. A mute control on the phone would have done nothing while
looking exactly like a working one, which is the sentence #2987 was filed
about, arriving back at the same column from the other side.

```
POST   /api/social/channels/{channelId}/mute   → { muted, mutedAt }
DELETE /api/social/channels/{channelId}/mute   → { muted: false, mutedAt: null }
GET    /api/social/channels                    → muted: boolean | null
```

Nothing in the schema or the policies changes: `channel_membership_update`
already permits the caller's own act on their own row.

## It was orphaned, not merely unbuilt

#2990 excluded it because *"a mute with no push is inert"*, pointing at #2987.
That PR shipped the push and went green without a writer, so the exclusion's
premise went false and the column belonged to nobody. A scoping argument with
the same expiry as a safety one — and the expiry is silent, because an
exclusion keeps reading as deliberate long after its reason stops holding.

## Decisions

**No monotonic guard, unlike the read cursor next door.** `markChannelRead`
guards with `lastReadAt: { lt: now }` because a cursor has an ORDER and a stale
client must not drag it backwards. A mute is a TOGGLE: there is nothing
later-or-earlier about it, so the same guard would be ceremony copied for its
shape rather than its reason — and it would make unmuting impossible, since
clearing a column is not "moving forward".

**Unmute writes NULL and keeps the row.** The row also carries `lastReadAt` and
`joinedAt`, so deleting it to unmute would discard the read cursor and the
boundary the first unread count is measured from — P9.5's "leaving is not
lossless" reached by accident instead of by a Leave button.

**Idempotent without re-stamping.** `mutedAt` is when the person chose silence,
so a no-op returns the STORED value rather than echoing the request. #2990's
lesson one route over: a function that echoes its input cannot report that it
did nothing.

**`updateMany` and the count.** The `where` matches only rows whose state
actually differs, so the count separates "changed it" from "already like that"
without a second read in the common case. A non-member is a REFUSAL, never an
insert: an insert here would be a second `ChannelMembership` writer, which
`channels-are-never-auto-joined` refuses by name.

**`CHANNEL_NOT_JOINED`, shared with the read cursor.** Deliberately not
`CHANNEL_NOT_A_MEMBER`, whose sentence is "join before posting in it" — the
wrong thing to say about a mute.

**It takes effect on the NEXT post.** `reachableTargets` reads `mutedAt` when a
post is made, so muting does not withdraw a push already enqueued. Stated
because "I muted it and still got one" is otherwise a bug report; the
alternative is re-checking inside the job, which would let a mute at 23:59
silently cancel a notification somebody was already being told about.

**The mention ROW is still written for a muted member.** A mention records being
NAMED; a mute is a statement about being INTERRUPTED. The Art 15 export reads
those rows.

## MY OWN FIRST DRAFT OF THE KEY CASE WAS VACUOUS

The test was named *"a muted member is not a push target"*. Its body asserted a
dummy `SELECT 1 AS count` and the presence of the mention rows. **It never
looked at the push targets.** A test name asserting a cause with nothing in the
body removing it — in the one case the whole issue exists for.

It now captures `enqueue` and asserts `pushesFor(HEARER)` has one and
`pushesFor(MUTER)` has none. **The unmuted member is the control**: without it,
"no push for the muted member" is satisfied by a post that notified nobody at
all, which is indistinguishable from broken mention resolution. Same reasoning
as P8.1's recursion, where all three refusal cases passed while the rule
enforced nothing because nothing could insert at all. A negative needs a
positive beside it or it grades the wrong world.

## Mutation proof

| mutation | result |
|---|---|
| `reachableTargets` no longer filters `mutedAt` | 1 failed |
| unmute writes a timestamp instead of NULL | 1 failed |
| the no-op echoes the request instead of the stored value | 1 failed |

Green after every restore.

## Verification

Derived population **1966**, green in shards summing to it: contracts +
guardrails + the one selected integration file 121, guards 779, unit 1066.
Typecheck exit 0. Lint PASS.

## The client half

agrent-ios #601: «Без известия» in the feed's menu for members, a bell-slash in
the list, and copy saying it applies from the next post.
