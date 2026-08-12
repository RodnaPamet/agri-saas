# 2026-08-12 — Avatars were never scanned, and the guard that could not see them

**Commit:** (pending — see PR)

## Design

`POST /api/account/avatar` accepted bytes, checked they were a webp, and
wrote them to `avatars/<userId>.webp`. No antivirus scan ran at any point.
Not a weak scan and not a skipped default — the code contained no call.

`GET /api/account/avatar/[userId]` then streams that object to **any**
authenticated user, and avatars render in member lists, people pickers and
the app chrome. So this is one of the few uploads in the product with a
distribution path built in.

### Why #543 did not catch it

#543 removed `FileRepository.markStored`'s `scanStatus = 'SKIPPED'` default
and gave the codebase one ingest pipeline. Its guard,
`upload-scan-explicitness`, derives its call sites from `markStored`. The
avatar path mints no `FileRecord`, so it has no `markStored` call and is
invisible to that derivation — the guard is correct and complete over the
class it can see, and the avatar is in a different class.

The sibling record-less path, promotion artwork (#12), *does* scan. Two
paths of the same shape, one scanning and one not, and nothing in the repo
compared them.

### The two shapes

```
RECORD-BACKED                          RECORD-LESS
evidence / journal / invoice /         avatars/<userId>.webp
importers                              promotions/<id>.webp

allowlist → write → sniff → scan       cheap checks → sniff → SCAN → write
  → FileRecord(scanStatus)               → object at a fixed key
                                       
read: download route asks              read: <img> hits the key.
isDownloadAllowed(scanStatus)          Nothing to ask.
```

Writing before scanning is safe in the left column *because* of the last
line: an infected file recorded as `INFECTED` is refused on the way back
out and an operator can purge the key. The right column has no way back
out, so the same decision has to happen before the write or not at all.

### `scanOrRefuse`

Added beside `ingestUploadedFile` in `src/lib/upload/ingest.ts`, so there
is still exactly one module a new upload path reaches for. It scans, and
throws `badRequest` when the verdict is not storable:

| verdict | | why |
|---|---|---|
| `CLEAN` | store | scanned, nothing found |
| `SKIPPED` | store | no scanner deployed, or one failed under a mode that asked to fail open |
| `PENDING` | refuse | a scanner IS configured, DID error, mode is `strict` |
| `INFECTED` | refuse | always |

That table is not written down anywhere in the implementation: it is
`isDownloadAllowed(verdict)`, run one step earlier. A record-backed file
with verdict V is readable exactly when the gate says so; a record-less one
is readable unconditionally; so the honest translation is to run the same
gate before the write. `INFECTED` is the one explicit check, ahead of the
gate, because `isDownloadAllowed` short-circuits on `AV_SCAN_MODE=disabled`
before reaching its own infected rule.

## Files

| file | role |
|---|---|
| `src/lib/upload/ingest.ts` | `scanOrRefuse` — the gate for record-less uploads, beside the record-backed pipeline |
| `src/lib/account/avatar.ts` | scans before the write; `isWebp` now delegates to the shared signature table |
| `src/app/account/profile/AvatarUploadField.tsx` | reads `payload.error.message`, so a refusal renders as its sentence |
| `tests/guards/upload-route-scan-reachability.test.ts` | second derivation — from routes, covering the class `markStored` cannot see |
| `tests/unit/upload-scan-gate.test.ts` | the gate's policy, executed against the real `isDownloadAllowed` |
| `tests/unit/account-avatar.test.ts` | the wiring: infected and scanner-failed avatars are never written |
| `tests/rendered/avatar-upload-field.test.tsx` | a refusal reaches the user as words |

## Decisions

- **`SKIPPED` stores rather than refuses.** The promotion-artwork path
  refuses when the scanner is merely unconfigured, and is right to: that is
  third-party artwork emailed in by an outside company and rendered in every
  tenant's feed. An avatar is the user's own photo, already forced through a
  client canvas re-encode, shown to their colleagues. The live stack runs
  `AV_SCAN_MODE=disabled` with no ClamAV service in the compose file, so
  refusing on "no scanner deployed" would mean nobody can set a profile
  photo in the only deployment we run — while every `FileRecord` path in the
  repo stores the identical verdict happily. `PENDING` (a scanner that
  exists and broke, under `strict`) still fails closed.

- **Promotion artwork was left alone.** Folding it into `scanOrRefuse` would
  have relaxed a deliberate, tested, five-day-old security decision made for
  a materially worse threat model, in exchange for tidiness. The two
  surfaces share the mechanics, and the mechanics are what got extracted;
  the verdict policy is where they legitimately differ.

- **The new guard derives from ROUTES, not from a helper.** Both previous
  misses were paths nobody had on a list — importers that happen to store a
  file (#543), an avatar with no record (this one). Every ingest of client
  bytes begins at an API route reading `formData()` and pulling out a
  `File`, which is enumerable from the filesystem. A route passes when a
  scanner call is reachable within two module hops.

- **A module that DEFINES a scanner is not evidence that one is called.**
  The first version of that guard passed vacuously: `@/lib/upload/ingest`
  contains `scanUploadedBuffer(...)` by construction, so every module that
  imported the pipeline "reached a scan" two hops later without invoking
  anything — and the mutation proof caught it, which is the entire reason
  that proof is in the file. Definition sites are excluded, derived from the
  same name list. Comments are stripped before matching, for the mirror
  failure: the spatial importer's docblock claimed an async scan that did
  not exist, and a raw-text grep would have read it as compliance.

- **`isWebp` delegates to `sniffMimeType`.** It carried its own RIFF/WEBP
  header read, a second implementation of a question `src/lib/storage/mime-sniff.ts`
  already answers for the whole upload pipeline. Two magic-number readers
  agree only until one of them is corrected.

## Not in this change

No backfill, and none is needed — confirmed against the production database
rather than assumed. `FileRecord` rows whose `pathKey` begins `avatars/`:
**0** (this path writes none, by construction). Users whose `image` points
at the avatar serve route: **0** — the five non-null `User.image` values are
OAuth provider URLs. So no unscanned avatar object exists to scan.

One thing worth someone's attention that is out of scope here: five
`FileRecord` rows in the `spatial` domain sit at `scanStatus = 'PENDING'`,
which under `AV_SCAN_MODE=disabled` cannot be produced by today's code
(`scanUploadedBuffer` returns `SKIPPED` without a scanner). They pre-date
#543 and are almost certainly rows whose `markStored` never ran, leaving the
schema default. `isDownloadAllowed` allows them in `disabled` mode, so
nothing is blocked; under a future `strict` deployment they would become
undownloadable.
