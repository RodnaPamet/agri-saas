# P6.5 — the public read path and `/f/[handle]`

First PR of #1814. The read usecase, the page, the route classification, and
the AASA consequence nobody had to discover.

## Private and missing are the same 404, structurally

The phase requires that a private profile and a missing one be
indistinguishable, so a stranger cannot enumerate farms by probing handles.

This gets it for free rather than by matching two error paths: a
`PublicFarmProfile` row **exists only while the farm is published** — the
writer deletes it on withdrawal rather than flagging it — so "not published"
and "never existed" are one absence, and `notFound()` is reached by one code
path. There is nothing to keep in step by hand.

A `published` column on the projection would have required exactly that, for
ever. A test asserts both halves: the two reads are `toEqual` each other, and
a read through the global client confirms the row is **gone** rather than
flagged — so the first assertion is not resting on a filter somebody could
forget.

## The bypass is load-bearing, and the table bounds it

`readPublicFarmProfile` is the only caller of
`runWithoutRls({ reason: 'public-projection-read' })`. An anonymous visitor has
no session, no tenant and no membership, so `runInTenantContext` has nothing to
enter with — the alternative is not a narrower context, it is no query.

What it may read is bounded by the **table**, not by the reason:
`PublicFarmProfile` has no PII columns and no `tenantId`, so a mistake at the
call site cannot widen its reach and there is nothing to join through.

`no-untyped-rls-bypass` ratchets the caller count; raised 3 → 4 with that
reasoning rather than exempted, so the fourth caller is a visible diff.

## A handle off printed paper

The reader trims and lower-cases, because a handle arrives from a URL a person
may have typed, pasted with a trailing space, or read off A6 paper (P6.7).

That exposed an inconsistency I had shipped: the **writer** stored the handle
verbatim, so a handle chosen as `Pobeda` would have published successfully and
been unreachable at `/f/pobeda` — presenting as a 404 that is *deliberately*
indistinguishable from "no such farm". Normalised in `projectionPayload`, the
single place the payload is built, so the stored row, `projectedHandle` and the
reader agree by construction.

The canonical fix is further up: `FarmBrand.handle` should be normalised where
it is **chosen** (P6.6, #1815), so its `@unique` constraint is case-insensitive
too. As it stands two farms could reserve `Pobeda` and `pobeda` — distinct to
the index, confusable to a person. Recorded on that issue.

## `/f` as a prefix is safe, and my own warning was stale

I had written into #1814 and #1818 that `/f` in `PUBLIC_PATH_PREFIXES` would
also open `/fx`. That was true of the `startsWith` behaviour, and it is not
true now: `matchesPublicPrefix` requires the match to end at a separator or at
the end of the string. Measured against the live predicate —

```
/f          public    the prefix IS the path
/f/pobeda   public    a child
/fx         gated     a sibling sharing the spelling
/fx/admin   gated     a sibling subtree
/f-debug    gated     a sibling with a dash
```

So P6.10's "`/fx` stays protected" is already satisfied by the predicate, not
something this phase arranges. Corrected on both issues — a warning about a
removed hazard sends the next person around a non-problem, or worse, makes them
write a test that can never fail.

No trailing slash, so a bare `/f` is public and answers 404 — the honest reply
for an address with no handle, where gating it would redirect an anonymous
visitor to a login page they have no account for.

### The guard's own parser had the apostrophe bug

`public-prefix-segment-boundary` extracts the entry list with `/'([^']+)'/`
over raw source, which cannot tell a quoted entry from an apostrophe in prose.
My comment reading "a farm's public page" made it capture comment text as an
entry. Hardened with `blankNonCode` rather than worked around, so the next
comment cannot do it. Its floor is the only reason this was a red build rather
than a silently wrong population.

## The AASA claim for `/f/*` has been withdrawn

The most useful thing this PR found, and it was predicted in writing. #1786's
docblock said the claim

> becomes a REGRESSION the day one of them ships as a web route while the app
> still cannot open it — a working page starts being hijacked

That day is today. P6.9's iOS screen does not exist, so an iOS user tapping a
shared farm link — or scanning a printed QR code — would have opened the app at
its home screen while the same link works in every other browser.

The owner's own ruling settles the direction: an absent path "simply falls back
to the browser, which is the BETTER outcome of the two", and there is now
something in the browser worth falling back to. `/f/*` returns with P6.9.

The collision check is derived from the filesystem, so it keeps refusing the
claim while the page exists and nothing re-argues it — the right default,
because the iOS half landing is what changes the answer.

## Design-system guards, all four correct

Hand-written Tailwind tripped `heading-primitive-discipline`,
`typography-eradication` and `spacing-scale-discipline`. Fixed by using
`<Heading level={2}>` and `gap-tight`.

Worth noting why `<Heading>` and not `<Eyebrow>`: `Eyebrow` renders a `<span>`,
and on a **public** page the document outline is read by screen readers and by
crawlers once P6.6 lets a farm opt into indexing. A label that looks like a
heading and is not one costs both.

## `tenant-isolation-structural` allowlist

`/f/[handle]` is outside `/t/[tenantSlug]`, and the entry's reasoning is the
inverse of every other one there: the page is not protected at all. It also
cannot be scoped to a slug even in principle — the handle is a separate public
identifier precisely so a published link does not carry the internal routing
key, so `/t/{slug}/f/...` would reintroduce the coupling the ruling prevents.

## Not in this PR

The OG image (satori needs TTF), `robots.txt` and the sitemap, and the LCP
measurement. `generateMetadata` already emits `noindex` for every profile,
which is the safe half; the sitemap is correctly empty while nothing is
indexable.
