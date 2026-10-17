# Immutable public media: `/api/public/media/{hash}`

The route that serves the bytes of an image a published farm profile
references. Flag-gated and OFF: `social.farm-media` has no row, so this is
unreachable until somebody creates one.

Issue: #1812 (P6.3). Owner ruling 2026-10-17 on the rate-limit budget.

## The hash is in the path, and that is a constraint not a style

iOS logs the full request URL including the query string, unsuppressably, so an
identifier in `?hash=` lands in device logs that outlive the request. A path
segment does not. This is written in the route, the spec description and here,
because the only thing stopping a later "simplification" is that the reason is
findable.

## Publication is the authorisation, not existence

A sha256 is unguessable but **permanent**. So "serve any `FileRecord` whose
hash matches" would hand out a capability nothing could revoke: a farm
unpublishes, and every image stays reachable to anyone who ever saw a URL —
including a crawler that cached one.

`resolvePublicMedia` therefore asks whether any `PublicFarmProfile` references
the hash, and only a yes leads to the file. `projectFarmBrand` deletes the
projection row on unpublish, so withdrawal stops the images resolving in the
same step, with no second revocation path to forget. That is also why the
projection carries its own hash columns rather than the route joining back to
`FarmBrand`: the authority has to be the row whose presence means "published".

## Two bypasses, two reasons, and the order is the safety property

Both reads bypass RLS because an anonymous visitor has no tenant. They are
**not** the same kind of read, and conflating them would have been the quiet
mistake here.

`public-projection-read` already existed and its recorded safety argument is
*bounded by the table*: `PublicFarmProfile` has no PII columns and no
`tenantId`, so a mistake at the call site cannot widen its reach.
`FileRecord` has both. So the file read carries a new reason,
`public-media-read`, and what bounds it is the **order**: the row it returns
belongs to whichever tenant published that image.

Reverse the two reads and this becomes a cross-tenant file lookup by hash. So
the claim is not left to a comment — `tests/unit/public-farm-media.test.ts`
asserts that the file read **does not happen at all** when the projection says
no, and that is mutation-proved: deleting the `if (!published) return null;`
guard fails exactly that test. An ordering assertion on the *results* would
have passed under the same mutation, which is why the test observes the absence
of a call rather than the shape of an answer.

`no-untyped-rls-bypass` went 4 → 5 files and 10 → 12 sites, raised rather than
exempted, which is what that ceiling is for: another part of the product now
reads across tenants.

## Classification: a prefix, with a load-bearing slash

The hash is part of the path, so there is no finite set of paths to list and
`PUBLIC_PATH_EXACT` is not available. `/api/public/media/` goes in
`PUBLIC_PATH_PREFIXES` **with** the trailing slash, or it would also open a
future `/api/public/mediaX` — the `/api/scim` vs `/api/scimulator` hazard that
file names. The bare `/api/public/media` stays gated; it has no handler, and a
401 is the honest answer for an API path rather than a redirect to a login page
an anonymous visitor has no account for.

Two existing guards already cover this by construction, which is why no new
classification guard was written: `public-prefix-segment-boundary` iterates
every entry in the list, and `public-route-exemptions-are-edge-reachable`
derives its population from `src/app/api/public` and asserts `isPublicPath` for
each. The route joined both populations by existing.

**A prefix opens every METHOD.** The route exports only `GET`, so POST and
DELETE 405 rather than reaching a handler. That is the whole defence, and it is
why the route must not grow a mutating export without a different gate — stated
in the route, and asserted by the tier predicate refusing POST.

## Its own rate-limit tier, and the arithmetic behind it

300/min/IP (`PUBLIC_MEDIA_LIMIT`), not the 60/min public-read tier. P6.10 asks
for the 61st anonymous request in a minute to be refused, and that fits a data
read — one request per user action. A profile page is a logo plus a few photos,
so one view is around six requests: at 60/min a visitor would start getting
429s on the ninth or tenth profile, and a throttled image fails **silently**.
A broken picture tells them nothing, so they read it as the product being
broken.

The sharper argument is that the two could not both be right.
`PUBLIC_READ_PREFIXES` justifies `/f/` sitting at 60/min *because* its assets
come from `/_next/static/*` and "do not count against the budget". Serving
images through an API route makes them count, so folding this prefix into that
tier would have retroactively broken the entry it sits next to.

Still at the Edge, which is the half the phase asks for: refusing costs a
comparison, reaching the handler costs a projection query and a storage read.
And carrier-grade NAT cuts the same way as `PUBLIC_READ_LIMIT`'s own docblock
describes — many rural subscribers share one public IPv4, so a village behind
one cell tower shares this budget.

`tests/unit/public-media-rate-limit-enforced.test.ts` drives the real
middleware to a 429 at request 301, because a limiter unit test proves the
budget COUNTS and cannot see whether the middleware acts on it. Mutation-proved
on the narrow regression: keeping `checkPublicMediaRateLimit` and dropping the
`return rl.response` fails §1 while everything else stays green.

## One answer for every refusal

Malformed hash, hash no published profile references, reference whose file is
gone, file the scanner quarantined — all one 404 with `{ error: 'NOT_FOUND' }`.
Distinguishing them would let a caller use the response to confirm which hashes
exist, and an unguessable identifier stops being unguessable the moment
something confirms a guess. The flag-off case 404s for the same reason, which
is `assertFeatureEnabled`'s existing behaviour.

The scan verdict goes through `isDownloadAllowed`, the same gate as every
authenticated download, rather than a second opinion. An image on an indexable
page is the last thing that should get a looser rule.

## Immutable, because the name IS the content

`Cache-Control: public, max-age=31536000, immutable`, and the `ETag` is the
hash — content-addressed, so a strong validator with no bookkeeping. The avatar
route explicitly cannot offer that ("a content hash would be stronger… but
nothing persists it"); here the hash is the key. Replacing an image changes the
URL, so no cache anywhere has to be told.

## What this does not do yet

Nothing populates the hashes. `BRAND_FIELD_DECISIONS` still marks
`logoMediaHash` and `photoMediaHashes` `private`, so no projection carries one
and this route answers 404 for every hash — correctly. The editor upload
surface and the `published()` flip are the next PR, and the ContentReport
moderation wiring (owner ruling 2026-10-17: reportable rather than
pre-moderated) after it.

**The flag row does not exist.** `social.farm-media` must be created before
this is reachable, and that is the third time this phase has needed saying —
see #2009, which tracks a scheduled check comparing code-referenced flag keys
against production rows.
