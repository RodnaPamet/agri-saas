# P6.8 PR 2 — the Latin derivation, the search, and a public route

Completes #1817. The schema shipped in **v12.29.0**, verified by tag rather
than assumed, before anything wrote to the new column.

## The derived column needed its own category

`BRAND_FIELD_DECISIONS` answers "may this `FarmBrand` field cross?". It cannot
answer for `displayNameLatin`, which no brand field produces — and the runtime
check read `BRAND_FIELD_DECISIONS['displayNameLatin']` as `undefined` and threw
a `TypeError` saying nothing about why. That happened on the first attempt.

So derived columns are now a declared category, `DERIVED_PROJECTION_FIELDS`,
with reasons — and an **unaccounted** key still fails, loudly, naming both
places it could be registered. The exhaustiveness property now covers both
kinds instead of one.

## The search: both columns, never a reversed query

`similarity()` and `%` are pg_trgm's and Prisma cannot express either. `%`
specifically is what lets the GIN index serve the query — an `ILIKE '%…%'`
would be a sequential scan that looks identical from the outside, which is the
shape the migration's own comment warns about. Every value is parameterised
through `Prisma.sql`; the filters are equality and array containment, so there
is no dynamic SQL.

A Cyrillic query matches `displayName`, a Latin one `displayNameLatin`, and
nothing is transliterated backwards — the mapping is not injective, so a
reverse would have more than one answer and would miss farms silently.
`GREATEST` of the two scores, so a hit ranks by its best match rather than by
whichever column is checked first.

An empty query is **browse**, not "match everything badly": the trigram
predicate is skipped entirely rather than compared against `''`, because
`similarity(x, '')` is 0 for every row — a threshold filter would return
nothing and an unfiltered one would rank randomly. Browsing orders by handle.

## The 429 was already named

P6.10 wants the 61st anonymous request in a minute refused.
`PUBLIC_READ_LIMIT` is 60/min and already exists, so the route **joined the
tier that had it** rather than getting a number chosen for it.

At the **Edge** rather than in the handler, because a trigram search is a
database read: a flood should cost a comparison, not a query.
`/api/public/eik-check` uses the in-handler option only because that tier is
GET-only and eik-check is a POST.

The entry has no trailing slash, and here that is harmless where in `guard.ts`
it would not be: this list is matched with `startsWith`, so over-matching a
rate limit fails in the **safe** direction — more throttling, not less
authentication.

## I put the route in the wrong list, and a child-path test caught it

I added `/api/public/farms` next to `/api/public/notices` and assumed that was
the exact list. It is not: `PUBLIC_PATH_PREFIXES` runs to ~line 226 and
`PUBLIC_PATH_EXACT` starts after it. My route comment confidently said "EXACT
and not a prefix" while the entry sat among the prefixes.

The tell was a probe:

```
PUBLIC  /api/public/farms
PUBLIC  /api/public/farms/secret      <- the signature of a PREFIX entry
gated   /api/public/farmsomething
```

A sibling probe cannot distinguish the two forms — both reject
`farmsomething`. Only a **child** can. Second time this session that probe
design mattered; #1770 was the first, in the other direction.

Measuring the rest of the list turned up **nine** fail-open prefix entries that
each serve exactly one route, where `PUBLIC_PATH_EXACT` would be the precise
claim. Not a live hole — nothing exists under any of them — but nine loaded
claims, because the next route added beneath one is public by inheritance with
nobody deciding. Filed as **#1838**, with the observation that the adjacency is
itself the mechanism: nine single paths sitting in the prefix list make the
prefix list look like where a single path goes.

## What the tests prove that the usecase suite cannot

The route suite asserts the Edge classification, the rate-limit coverage, and
that `oblast` and `crop` reach the right fields — both are optional strings, so
swapping them compiles and silently filters by the wrong thing.

A limit above the cap is a **400**, not a silent clamp: clamping would answer
50 results to a request for 9999 and look successful, where a 400 naming the
field tells the client what it did. (The usecase clamps as well, for any future
non-HTTP caller.)

## Mutation proofs

| mutation | cases failed |
|---|---|
| predicate checks only `displayName` | 2 — the Latin query and `AgroTech` |
| writer stops deriving the Latin form | 2 |
| remove the limit cap | 1 |

The first is the one that matters: it is the design's whole claim, and dropping
the Latin column fails exactly the two cases that depend on it.

## Also fixed

`mine()` in the search suite was typed `Array<{ handle: string }>`, which
compiled at every call site reading only `handle` and broke the ones reading
`score`. `tsc` caught what the passing tests had not. Made generic.
