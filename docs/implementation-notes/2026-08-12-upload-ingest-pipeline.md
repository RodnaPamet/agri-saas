# 2026-08-12 — One upload ingest pipeline, and no silent skip

**Commit:** (pending — see PR)

## Design

Seven code paths in this repo accept an uploaded file. The pre-storage work
they do was supposed to be the same everywhere:

```
declared-MIME allowlist → size check → object key → buffer
  → byte sniff + RE-CHECK → storage write → AV scan → FileRecord
```

Three carried that block near-verbatim (`evidence`, `journal`,
`cost-entry`). **Two carried a degraded copy** — the evidence ZIP importer
and the spatial importer — with the sniff and the scan missing. Two more
(avatar, promotion image) are a third variant that writes no `FileRecord`
at all.

### What made the gap invisible

Not an oversight in a review. `FileRepository.markStored` declared:

```ts
scanStatus: 'CLEAN' | 'INFECTED' | 'SKIPPED' | 'PENDING' = 'SKIPPED',
```

Both importers called `markStored(db, ctx, fr.id)` — three arguments. The
diff that introduced each contains no mention of scanning, because there
was nothing to mention. And `'SKIPPED'` is not inert:
`isDownloadAllowed('SKIPPED')` returns **true in every `AV_SCAN_MODE`**, so
the default marked a file unscanned *and* downloadable in one move.

The spatial importer's docblock asserted the opposite — "ClamAV scans
async; markStored → scanStatus PENDING". There is no async scan worker.

### What lands

- **`src/lib/upload/ingest.ts`** — `ingestUploadedFile(tenantId, file, opts)`.
  Everything up to and including the scan, once. Returns the fields the
  caller needs plus a terminal `scanStatus`; the caller mints its own
  `FileRecord`.
- **`markStored`'s default is gone.** All five production call sites now
  state a status. The two importers state a *real* one — they buffer the
  bytes already, so scanning them adds no I/O the request was not doing.
- **`cost-entry` is the reference migration** onto the shared pipeline.
- **`TENANT_KEY_REGEX` is derived** from `STORAGE_DOMAINS` instead of
  repeating it. It had already drifted: `cost-invoice` was added to the
  domain union and to `buildTenantObjectKey` but never to the regex, so
  `parseTenantKey` returned `null` for every invoice key this module itself
  minted.

## Decisions

- **A shared PIPELINE, not a generic upload ENDPOINT.** One route that any
  entity posts to would mint a `FileRecord` attached to nothing, with the
  attach as a second request — so a dropped connection between the two
  leaves a file that is stored, scanned, billed and referenced by nothing.
  Every multipart route here mints its record inside the same transaction
  as the entity write, and that part is genuinely per-entity. The
  duplication was entirely in front of it.

- **The pipeline lives in `src/lib/upload/`, not `src/lib/storage/.`** From
  inside `src/lib/storage/` the natural import is `./index`, which resolves
  to a *different module* than the `@/lib/storage` specifier every other
  consumer uses (that one hits the back-compat shim `src/lib/storage.ts`).
  Every existing test mocks the shim, so an ingest module importing
  `./index` silently bypasses all of them — which is exactly what the first
  attempt did, and the cost-entry suite caught it.

- **Write, then scan.** Recording an infected file as `INFECTED` is
  recoverable: the download gate refuses it and an operator can purge the
  key. Scanning first and writing second means a crash between the two
  leaves a stored object with no record — nothing will ever look at it
  again.

- **`extraCheck` narrows, never widens.** `isAllowedMime` still runs; a
  surface hook is applied on top. An importer may accept only `.zip`; none
  may accept something the shared allowlist refuses.

- **The guard DERIVES its call sites.** A curated list of "the upload
  routes" is what failed here — the two unscanned paths were importers that
  happen to store a file, so nobody had them on such a list.
  `tests/guards/upload-scan-explicitness.test.ts` scans for the *call*,
  wherever it lives, and separately EXECUTES `isDownloadAllowed('SKIPPED')`
  to prove the premise it argues from.

## Not in this change

`evidence.ts` and `journal.ts` still carry their own copies of the block.
Migrating them is mechanical — their SHA-256 dedup begins exactly where
`ingestUploadedFile` returns, so the extraction point already lines up —
but each is interleaved with entity-specific validation and deserves its
own diff and its own run of the evidence/journal suites.

The avatar and promotion-image paths remain a separate variant: fixed keys,
webp magic bytes, no `FileRecord`. The avatar path performs **no AV scan at
all**, which this change does not alter. Both are worth folding in next.

> **Superseded for the avatar path** by
> `2026-08-12-avatar-scan-gate.md`: it scans now, via `scanOrRefuse` in this
> same module — the record-less shape's gate, which runs BEFORE the write
> because there is no download gate to defer to. Promotion artwork keeps its
> own stricter verdict policy, deliberately; see that note.
