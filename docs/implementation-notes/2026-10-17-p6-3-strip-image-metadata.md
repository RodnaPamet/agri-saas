# EXIF/GPS stripped from every photograph a farmer uploads

A shared `stripImageMetadata` re-encodes uploaded images to drop their camera
metadata, wired into the three upload surfaces that accept photographs. No new
surface and no flag: this changes what gets stored on paths that already exist.

Issue: #1812 (P6.3). Owner ruling 2026-10-16: all uploads, public and private.

## What the metadata actually is here

A farmer photographs a field from the field. The GPS tag in that photo is the
parcel's location — the one piece of data the private product treats as
tenant-confidential, and which a public farm profile would publish by
accident. The camera also writes make, model, serial and capture time.

The ruling covers private uploads too, and that is not belt-and-braces: a
private evidence photo shared with an advisor is still a disclosure, and the
journal attachment case is a photo taken *at the operation it records*, so its
GPS tag is by construction the parcel being worked.

## Stripping is a property of re-encoding

sharp writes no metadata unless `withMetadata()` is called. So the strip is not
a filter that can be forgotten or mis-ordered — it is what decode-and-re-encode
*does*. Reintroducing EXIF requires adding a call, which is a visible edit.

That is why the test reads EXIF back out of the **produced bytes** rather than
checking that an option was passed. #1812 asked for exactly this: "an option
that stops being passed is a silent regression". Mutation-proved by adding
`.withMetadata()` to the pipeline — two assertions went red, and both the raw
byte search for the tag value and sharp's own reader caught it.

## Format is preserved, deliberately

JPEG in, JPEG out. Converting to WebP would change `FileRecord.mimeType`,
contradict the stored filename's extension, and alter every download and
preview surface — four coupled changes a privacy fix needs none of.

`src/lib/account/avatar.ts` does convert, and stays as it is: it owns its
storage key and serve route and wants one canonical format. It is listed as a
deliberate exemption from the new guard, with that reason, because it strips by
the same mechanism and asserts it on its own output bytes.

## The scan moved ahead of the write

All three surfaces wrote bytes and *then* scanned them. Stripping means
decoding caller-supplied bytes with libvips, and a decoder fed
attacker-controlled input is the step most worth having a scan in front of —
`avatar.ts` already recorded that ordering and its reason.

So the order is now scan → strip → write at each site. The verdict returned to
callers is unchanged, so this reorders work without changing what anything
decides. The guard asserts the ordering separately from the presence of the
strip call, and that assertion was mutation-proved on its own: moving the write
back above the strip fails only the ordering test, and only for that file.

## Coverage, and the two surfaces deliberately left out

The population is derived from the AV scanner — "bytes we felt the need to
scan" is the honest definition of user-supplied — intersected with the storage
writer. Six files; three strip, three are exempt with recorded reasons.

`spatial-import.ts` and the evidence-imports route stage a shapefile bundle and
a zip, and their `mimeType` is what the client **declared** rather than what
the bytes sniffed as. `stripImageMetadata` requires the resolved type, because
a caller who can opt out of stripping by setting a header defeats the measure
entirely. Images inside an evidence archive reach storage through
`evidence.ts`, which does strip, so the bytes a visitor can eventually see are
covered.

The population is keyed to the scanner rather than to `ingestUploadedFile`
on purpose. CLAUDE.md calls that function "the choke point every record-backed
upload reaches"; measured, it is reached by one of five (#2030). A guard built
on that claim would have inherited the same blind spot.

## Two things left untested, and why that is written down

**Animated images pass through unstripped.** Re-encoding a multi-page image as
a single frame is data loss dressed as a privacy fix, and the frame-preserving
path is one no fixture could exercise: four constructions of a multi-page WebP
all reported `pages: undefined`, and `pageHeight` is not even in this sharp's
`WebpOptions` type. A test written anyway would have compared `1` to `1` and
passed whatever the code did. Shipping an untestable re-encode is the worse
risk, so the branch returns the bytes untouched with `stripped: false`. A
camera does not produce an animation, so the accidental-GPS case cannot arise;
the residual exposure is a crafted animation carrying its *author's* metadata.

**Undecodable images are refused, not passed through.** The alternative keeps
the GPS tags and tells the operator through a log line nobody reads. A privacy
property that degrades silently to no privacy is not a property — and the bytes
only reached the stripper because a magic-number sniff said they *are* that
image type, so a decode failure means a file no viewer could render either.
`IMAGE_UNREADABLE`, with its Bulgarian entry.

## What this does not do

It does not touch images already in storage. The owner's ruling of 2026-10-16
was new uploads only, and a backfill would have to re-encode every stored image
in place — a migration over object storage, not a code change.
