# A farm can publish a logo and a few photographs

The writer half of P6.3: an upload endpoint, the check that decides which
hashes may be published, and the `published()` flip that lets them cross into
the projection.

Issue: #1812. Owner rulings: "logo plus a few photos" (2026-10-16), EXIF
stripping on all uploads (2026-10-16).

## The check is the security boundary, and it has two conditions

`/api/public/media/{hash}` serves any hash a published projection references,
and its safety argument is that the file belongs to whoever published it. The
read path cannot establish that — by the time a hash is in a projection, who
owned the bytes has been decided. `public-farm-media.ts` says so in terms, and
this is where the obligation is met.

**Ownership, enforced by RLS rather than a comparison.** The lookup runs inside
`runInTenantContext`, so another tenant's `FileRecord` is simply not visible and
the hash comes back unmatched. The function carries no `tenantId` term at all,
deliberately: an explicit comparison is something a refactor can drop, where
removing the tenant context breaks every query in the function at once.

**The `farm-media` storage domain.** Ownership alone is not enough, and this is
the condition that is easy to miss. Every `FileRecord` a tenant owns has a
hash, so without it a farm could publish the hash of an evidence photo of
something private, or of a supplier invoice PDF, and the public route would
serve it on an indexable page with that file's own `Content-Type`. The domain
makes "uploaded in order to be published" a property of the row instead of a
promise about which screen was used.

Both are proved at the database, not with mocks, because the claim *is* a
database behaviour: `tests/integration/farm-media-publishable.test.ts` creates
tenant B's file for real — identical in every respect except the owner — and
asks tenant A to publish it.

Mutation-proved twice, each failing exactly its own assertion and nothing else:

- dropping `domain: FARM_MEDIA_DOMAIN` fails only *"REFUSES its own file from
  another DOMAIN"*;
- running the lookup through `runWithoutRls` fails only the two cross-tenant
  assertions — which is what demonstrates that RLS is doing the work rather
  than some incidental filter.

## Upload and publish are two steps

`POST /farm-brand/media` stores bytes and answers a content hash. It touches
nothing on `FarmBrand`; `PATCH /farm-brand` decides whether an image appears,
as the logo or where in the gallery.

An upload that also published would make dropping a file onto the page a
publication decision, with no way to upload four photographs and then choose
two. It also makes a retry safe: the same bytes give the same hash, so a
dropped connection cannot produce a second gallery entry.

The upload goes through `ingestUploadedFile` rather than writing bytes itself,
because the EXIF strip is wired into that choke point (#2034) and a second
upload path would be a second place to forget it. It narrows the shared
allowlist to JPEG, PNG and WebP — `IngestOptions` permits narrowing, not
widening — so only formats the strip pipeline re-encodes can enter the domain,
and the domain check downstream then has nothing to let through by mistake.

## The flip, and the phase rule it waited for

`BRAND_FIELD_DECISIONS` now marks both fields `published()`. They were
`private` for exactly one release, and the rule is satisfied by measurement
rather than assumption: the columns shipped in #2029 and `v12.73.1` contains
that migration, so rolling it back cannot leave this writer naming a column the
database lacks.

## No eye toggle for images, and the reason is not "nobody asked"

`HIDEABLE_FIELDS ∪ NOT_HIDEABLE` must cover every published field, so the flip
forced this decision rather than allowing it to be skipped. Both media fields
are `NOT_HIDEABLE`, with the argument recorded there.

The eye toggles exist because hiding a text field must not destroy the text: it
lives only on that row, so withholding and deleting had to be separated. An
image is different in a way that matters — the bytes are in storage under a
content address that does not depend on the column, so clearing the column
withholds the image and loses nothing. Restoring it needs only the hash.

For the gallery there is a second reason: the array *is* what is on the page, so
removing a hash is the act of withdrawing that photograph. A flag withholding
the whole gallery while the array stayed populated would mean two sources of
truth for what the page shows.

That does put a requirement on the editor, and it is a requirement rather than
an assumption: it must be able to LIST this tenant's `farm-media` files, so an
owner who removes a photograph can put it back without re-uploading. The hash
is returned on upload and the domain makes the set findable.

## The cap lives in the usecase, not the schema

Six photographs — enough for a field, a barn, a crop and a machine, and few
enough that the page stays a page. The logo is separate and does not count.

In the usecase rather than as a Zod `max()`, because a schema rejection names
an array index and a coded refusal names the limit: `FARM_MEDIA_TOO_MANY`
carries `maxPhotos` on the wire so a translated message can state the figure.

## One code for every refused hash

`FARM_MEDIA_NOT_PUBLISHABLE` covers not-this-tenant's, wrong-domain,
soft-deleted and never-stored. The owner's remedy is the same for all of them
(upload it again), and distinguishing them would tell a caller whether a hash
exists elsewhere in the system — the same anti-enumeration reasoning the public
route's single 404 rests on.

## A latent duplication removed on the way past

`VALID_DOMAINS` was a second hardcoded copy of `STORAGE_DOMAINS`, free to
diverge the moment someone added a domain to one and not the other. It now
derives from it. Adding `farm-media` was what surfaced it.

## What remains

The editor UI, and then the ContentReport moderation wiring (owner ruling
2026-10-17: farm profiles reportable through the existing DSA machinery rather
than pre-moderated). `social.farm-media` still has no row, so the public read
surface stays unreachable — see #2009.
