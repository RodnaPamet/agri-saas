# P5.2b — person blocks (#1593)

`UserBlock` enforcement and three routes. The whole PR turns on one question
the owner settled twice, and on a modelling detail I nearly reported as a
blocker.

## Two block tables, opposite disclosure rules

The most confusable thing in this phase, so it is stated as a table rather than
left in prose:

| | `ExchangeBlock` | `UserBlock` |
|---|---|---|
| who refuses whom | a seller FARM refuses a person | a PERSON refuses a person |
| disclosure | **tells** the buyer | reveals **nothing** |
| session variable | `app.actor_user_id` | `app.user_id` |
| direction enforced | the inquirer only | whichever party is blocked |

Both are right. The exchange is commercial and its refusal is information a
buyer is entitled to — the code argues for it at
`exchange-messaging.ts:516`, and the owner confirmed it stays. A social block
must be silent.

`tests/unit/person-block-is-silent.test.ts` asserts both together, because the
likeliest regression is somebody making them consistent.

## The ruling needed a second half, and "refuse the write" was not enough

The owner's first ruling was "the social block is silent". Building it showed
that refusing writes does not achieve silence: if the blocked party can still
read the thread and only the send fails, **the inconsistency is the signal**. A
visible conversation whose composer refuses tells them exactly as much as an
error message would.

Second ruling: hide the thread from the blocked party. Read, list and send all
answer not-found; the blocker keeps full history.

The cost is not free and is recorded here because support will meet it: a buyer
blocking a seller makes a deal in progress vanish from the seller's view, with
no explanation available to anyone without database access.

## Silence is the GENUINE not-found, not a new code

`LISTING_NOT_FOUND` on open, `THREAD_NOT_FOUND` on read/list/send — the same
code, message and status a missing subject returns.

The test is written as a **comparison**: run the same call twice, once blocked
and once with the subject genuinely absent, and require every observable to
match (name, message, code, status, and the set of enumerable keys). A test
asserting `code === 'THREAD_NOT_FOUND'` would have passed on an implementation
that returned it with a different message or an extra field, and any of those is
a tell. The comparison also cannot be satisfied by weakening it — making the two
agree is the only way through.

**What is not claimed: timing.** The block costs an extra indexed lookup, and
the listing stays visible in the marketplace while one person gets a not-found.
A determined blocked user can infer a block. Better to say so than to imply the
mechanism is stronger than it is.

## I nearly reported "both directions" as impossible

`ExchangeThread` carries `inquirerUserId` — a person — while the seller side is
`listing.sellerTenantId`, a farm with N members. I had written the P5.2b scope
saying a person block refuses both directions, then noticed the thread names no
seller person and started drafting the finding that `UserBlock` cannot express
seller-side refusal at all.

`ExchangeListing.sellerUserId` exists: "User within the seller tenant who
created the listing", non-nullable. So the seller person is the lister, and both
directions work.

Worth recording because the near-miss was one grep away from a wrong report to
the owner, and because the residual limitation is real: `requireParty` decides
the seller ROLE by tenant, so a colleague of a blocked lister can still write.
That is the same evasion `ExchangeBlock.blockedUserId`'s docblock already
records as an accepted cost — "it stops a person, not a farm".

## Two predicates, because contact and visibility are not symmetric

- `personBlockExists` — **bidirectional**, governs CONTACT. Blocking is mutual
  silence; the alternative lets the blocker keep writing into a conversation the
  other party cannot see, which turns a block into a one-way megaphone.
- `amIBlockedByAnyOf` — **one-directional**, governs VISIBILITY. The blocked
  party loses sight of the thread; the blocker keeps history.

The visibility check sits in `requireParty`, the choke point every thread read
and write reaches — `get`, `send`, `close`, `markRead` and both exchange-block
calls — so one check covers five paths instead of five that drift apart. A
consequence: a blocked seller also loses their `ExchangeBlock` controls on that
thread. Consistent, since the person who blocked them has already stopped
contact, and the blocker can always lift their own `UserBlock`, which does not
come through that function.

## The thread list filters in the QUERY

`listExchangeThreads` takes `limit + 1` rows to learn whether another page
exists without a second COUNT. Filtering blocked threads out of the page
afterwards would shrink it and make `hasMore` wrong — a block becoming a
pagination bug. So the exclusion is a `where` term built from one indexed
lookup, and the terms are added only when there is something to exclude (an
empty `notIn` matches nothing in some engines).

## `listOwnBlocks`'s `where` is load-bearing, unlike the rest of the module

Everything else in `person-blocks.ts` lets the DATABASE be the authority: the
INSERT policy's `WITH CHECK` and the DELETE policy's `USING` both require
`blockerUserId = current_setting('app.user_id')`, so a forged write is refused
with `42501` and a forged delete removes zero rows. No application check
duplicates them, deliberately — a redundant check looks like the control and is
what a future refactor removes, leaving the impression a guard was there.

The exception is the list. The SELECT policy admits **both** sides of a row,
because enforcement runs in the blocked party's context and a row they cannot
see cannot refuse them. So the API is what withholds it, and removing that
clause would leak every block against the caller — exactly what "never reveal a
block to the blocked party" forbids. Its integration test asserts the filter
works AND that the policy really does admit the row, so the assertion cannot
pass by RLS hiding what the filter was supposed to.

## A refused DELETE does not raise, so the 404 comes from a count

Measured in P5.1 and applied here: under RLS a delete whose policy is
unsatisfied affects zero rows and returns normally. `unblockPerson` reports the
count and the route turns 0 into a 404 — otherwise lifting somebody else's block
would answer 200 and the client would show it as done. The 404 does not
distinguish "never existed" from "not yours", because telling them apart would
reveal that one person has blocked another to anyone able to guess the pair.

## Three guard registrations this needed

- `social-routes-flag-gated` wants the flag key as a **literal at the call
  site**, not a `const` — its reason is the operator's, who has to find the flag
  by reading the route. Repeated three times, which is the cost.
- `route-inventory-ledger` compares its `documented` flag against the spec, so
  the inventory must be regenerated **after** the OpenAPI paths, not before. I
  did it in the wrong order first.
- `error-codes-are-documented` refused two new codes until the spec named them —
  and then refused again, because the prose I added incidentally documented
  `THREAD_BLOCKED`, which was on the undocumented baseline. That line came out.
  The ratchet shrinking itself is the system working.

## `DELETE` takes a body, which is unusual

`DELETE /api/social/blocks/[blockedUserId]` would put a third party's user id in
a URL, and iOS logs the full URL including the path, unsuppressably. P5.7 calls
these routes. The id travels in the body instead.
