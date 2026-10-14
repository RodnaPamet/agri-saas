# P6.5 PR 2 — the OG card, robots.txt and sitemap.xml

Second PR of #1814. Completes P6.5 except the LCP measurement.

## No new dependency, and the Cyrillic font was already here

The phase warns that satori rejects woff2, which is true — and `next/og`
already bundles satori (`next/dist/compiled/@vercel/og`, Next 16.3.8), so the
OG card needs **no package added**. That mattered rather than being
convenient: the default branch currently reports 20 Dependabot advisories, and
a new transitive tree for one image would have been the wrong trade.

The font is `DejaVuSans.ttf`, already in the repo at `src/lib/pdf/fonts/`
because the ДНЕВНИК PDF needs full Cyrillic coverage. Reusing it is not thrift:
«Стопанство Победа» renders as tofu boxes in any font without Cyrillic glyphs,
and the fonts Next ships (`Geist`) do not have them. The PDF path already
proved this one does.

The test actually **rasterises** rather than asserting a shape — satori throws
on an unparseable font and renders tofu for a missing glyph, so a card that
comes back 200 `image/png` from Cyrillic input is evidence the font loaded and
covered the text.

## "0 hits in the OG image" is answerable after all

P6.10 asks for zero hits of ЕГН, ЕИК, УРН and the address in the OG image, and
I had written on #1818 that this is the awkward one because an image is pixels
and a substring search cannot see into it.

It is answerable, and not by searching: the card renders `displayName` and
`oblast` from the projection, and the PII columns **do not exist** on that
table. The values never reach the process. The assertion is about the input,
not the output.

## robots.txt deliberately does NOT disallow `/f/`

The counter-intuitive half, so it is pinned by a test. `robots.txt` governs
**crawling**, not indexing — a URL disallowed there can still appear in an
index if something links to it. The directive that keeps a page out is the
`noindex` header, which `/f/[handle]` emits per profile from its own
`indexable` flag.

Disallowing `/f/` would stop a crawler ever **seeing** that header, which is
how a URL ends up indexed with no snippet rather than not indexed at all. So
`/f/` is allowed and the per-page header decides.

What is disallowed is the authenticated tree. Not a leak — a crawler reaching
`/t/{slug}` gets a login redirect — but crawl budget spent on redirects is
budget not spent on the public pages, and the logs fill with requests that
cannot succeed.

## The sitemap is empty, and that is the correct output

It filters on `indexable`, not `published`. A row exists only while a farm is
published, so the filter is the narrower question: has this farm agreed to be
**found**? Publishing a page and asking for it to be indexed are different
decisions, and indexing is the one that outlives a withdrawal because a cached
snapshot is not ours to recall.

Nothing is indexable today (P6.6 ships the control), so the document lists
nothing. Deliberate rather than unfinished: the alternative would invite
crawlers to index pages whose owners have not been asked.

`lastModified` is `projectedAt` — it moves when the public content changes and
not when the owner edits a draft, so it leaks no private activity. `new Date()`
would claim everything changed on every fetch, which trains a crawler to
ignore the field.

The 50,000 cap is the sitemap protocol's per-file limit, not a guess: exceeding
it produces a document crawlers reject **wholesale** rather than truncate.

## One bypass file, not two

`listIndexableFarmHandles` lives beside `readPublicFarmProfile` rather than in
`sitemap.ts`. `no-untyped-rls-bypass` ratchets the number of FILES that call
`runWithoutRls`, so a sitemap reading the database directly would have raised
that count for a read the existing reason already covers — spending a ratchet
on duplication.

## Two guards corrected me

- **`no-hardcoded-ui-strings`** flagged `agrent.bg` in the card. The right fix
  was not a carve-out: a literal domain is a **second source of truth** for the
  deployment's own origin, wrong the day it changes and buried in an image
  nobody re-reads. Derived from `getAppBaseUrl()` instead, which answers the
  guard and the underlying problem together.
- The same reasoning had already applied to `robots.ts` and `sitemap.ts`, where
  my first version hardcoded `https://app.agrent.bg` as a fallback.
  `getAppBaseUrl()` is the sanctioned resolver — `APP_URL ?? NEXTAUTH_URL`,
  the latter required by the env schema off Vercel, so the app cannot boot
  without knowing its own origin.

## Mutation proofs

| mutation | effect |
|---|---|
| drop the `indexable` filter | every published farm is offered to crawlers |
| `lastModified: new Date()` | the field stops being informative |

Each failed exactly one case.

## Not in this PR

The LCP ≤2.5s measurement. It needs a built app and a run against it, which is
Lighthouse's job rather than a unit test's — and the page's own shape (one
server read, no client JS beyond the shell) is what the budget rests on.
