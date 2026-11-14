# 2026-11-14 — a post's author carries its farm handle

**Commit:** (this branch) `feat/3043-author-farm-handle`

## Design

#3043, for agrent-ios #596: a direct message should be startable from a
channel post. `toPostView` carried `author { displayName, farmName }` and no
handle, while `POST /api/social/conversations` takes a **handle** — so the
phone could show who wrote a post and could not open a conversation with them.

`author.farmHandle: string | null` — the handle of the farm the author posted
AS, present only where that farm has a published page.

## Decisions

**INSIDE the `author` object, not beside it.** `toPostView` sets `author` to
null on a hidden post, deliberately: the body is already empty, and naming
somebody above content nobody can read attributes an accusation to them. A
handle hung outside that collapse would let a client offer «Пиши» above
suppressed content, reintroducing exactly what the collapse prevents.

**Resolved from `authorTenantId`, recorded at write time.** #2989 settled that:
the only read-time rule available is "oldest membership, then id", under which
a person who leaves a farm has every past post silently relabelled. The handle
must follow the same column as the farm NAME already shown, or the two halves
of one byline can disagree.

**It adds navigability, not information.** The post already shows the farm's
name. Given a farm already named in the byline, this answers "is there a
published page for it" — the inverse of the handle→tenant direction P8.2 is
careful about.

**Not an address for the AUTHOR.** A DM to a farm reaches that farm's ACTIVE
OWNER (P8.2, owner ruling 2026-11-06), who may be somebody else. The field name
invites the opposite reading, so both the type and the spec say so.

## Three things the first draft got wrong

**1. It read `FarmBrand` through the feed's transaction, and got zero rows
SILENTLY.** `FarmBrand` is tenant-scoped; the channel read paths run in a USER
context (`app.user_id`, deliberately no `app.tenant_id`), so `tenant_isolation`
matched nothing. #1664's shape.

The symptom is the part worth keeping: **all four negative cases passed while
both positives failed.** A resolver that answers null for everything is
indistinguishable from one being correctly conservative, and only the positives
can tell them apart. The bad version of that outcome is all six passing because
the positives were never written — which is how P8.1's recursion shipped green
past three refusal cases.

So it runs privileged, and **outside** the transaction: a privileged read inside
an open one takes a second pool connection while the first is held, which is
#1191's P0.8 deadlock. `postToChannel`'s mention resolution sits outside its
transaction for the same reason.

**2. It was a SECOND SPELLING of an existing rule.** The draft asked "is this
farm publicly reachable" against `PublicFarmProfile`.
`ExchangeRepository.listPublishedFarmBrands` has answered that question since
the exchange attributed listings, against `FarmBrand.published` — and with the
better argument: `published` is what makes WITHDRAWAL propagate, so a farm
taking its page down stops being returned, attribution reverts on the next
read, nothing is back-filled and no listing is left naming a page that 404s.

A divergence here would not merely drift. It would drift toward keeping a farm
visible after it asked not to be — the exchange and the channels disagreeing
about whether a farm is public is a DISCLOSURE, not an inconsistency. Same
shape as `UserBlock`'s two SELECT arms, where removing the "redundant" one
breaks two features silently.

It delegates now, with its own bypass reason: the rule is shared, the READER is
not, and `exchange-farm-attribution` in a bypass log would name the wrong
surface.

**3. The fixture could not express SUCCESS.** `listPublishedFarmBrands` drops
any row whose `handle` or `displayName` is null — nullable columns the
publication preconditions guarantee — and the fixture created a published brand
with no `displayName`. That is what kept both positives red after the context
fix.

## Verification

Derived population **1966**, green in shards summing to it: contracts +
guardrails + the selected integration file 121, guards 779, unit 1066.
Typecheck exit 0. Lint PASS.

Ratchets raised with a reason each: `no-untyped-rls-bypass` 9 → 10 files and
18 → 19 sites. One site, because the delegation keeps the boundary in one
module rather than spreading it across two.

Asserted through BOTH read paths — `readChannelFeed` and `readPostReplies` —
because `toPostView` is one mapper over two selects, and #2961 drifted exactly
there.
