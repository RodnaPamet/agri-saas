# 2026-08-05 — Evidence file security: ownership, oracles, bytes, and one poisoned transaction

**Commit:** `fix(security): resolve evidence file ownership from the FileRecord, and delete the bytes`

Five defects in the evidence file path. They are grouped into one PR because
four of them share a single root cause — the code checked one value and then
used a different one — and the fifth (the poisoned transaction) is what makes
the fix for the fourth safe to land.

## Design

### The shape of the bug

`downloadFile` did this:

```
isFileOwnedByTenant(ctx, fileName)   →  boolean
     ↓ true
storage.readStream(fileName)         →  the caller's string, unchecked
```

`isFileOwnedByTenant` returned true when a tenant had an `Evidence` row whose
`content` column equalled `fileName`. `Evidence.content` is caller-supplied
free text: `createEvidence` writes `data.content` straight through and only
overwrites it for `type === 'FILE'` uploads. So the attack was to create an
evidence row — an ordinary, permitted write — whose content was another
tenant's storage key, and then ask for it. The check passed on the row the
attacker had just written, and the read went to the raw string with no
`assertTenantKey` anywhere on the local branch.

The S3 branch looked safer, and was worse: when the `FileRecord` lookup missed
it **fell through** to the local read, so an unresolvable key degraded into the
vulnerable path rather than a 404.

The fix is structural, not a patch: **resolve, then read.**

```
findOwnedByTenant(ctx, fileName)     →  FileRecord | null      (tenant-filtered)
     ↓ record
assertTenantKey(record.pathKey, ctx.tenantId)
storage.readStream(record.pathKey)   →  never the caller's string
```

The repository returns the RECORD, not a boolean. That is the load-bearing
part of the change. A boolean invites exactly the pattern that caused this —
check one value, use another — and no amount of care at the call site removes
the invitation. Returning the record means the only key in scope is the one
ownership was proved against. Name and MIME come from the record too: MIME was
previously guessed from the caller's extension and replayed as the download
`Content-Type`, i.e. the caller chose what the browser would treat the bytes
as.

A miss is `notFound`, not `forbidden`. A 403 distinguishes "exists but is not
yours" from "does not exist", which is an existence oracle across tenants.

### The integrity endpoint was the same bug wearing a hat

`verifyFileIntegrity` took a file NAME, resolved it the same way, and streamed
the object to compute a SHA-256 — returning the hash and the size. That is a
cross-tenant *content* oracle: hash equality confirms a file's exact bytes
without ever reading them. It is now id-addressed, wrapped in
`runInTenantContext`, gated by a new `assertCanVerifyIntegrity`
(OWNER/ADMIN/AUDITOR), and it accumulates size incrementally rather than
buffering the whole object to measure it.

### The guard that never fired

`tests/guards/file-security-guards.test.ts` existed to catch precisely this
class. It filtered candidate files to paths containing `download`, then grepped
for `params.pathKey`. Neither vulnerable route matched either filter, so it had
been passing for the entire life of the bug — a guard asserting on a population
it had defined itself out of.

It now scans every `storage.delete` / `readStream` / `createSignedDownloadUrl`
call for a caller-supplied argument, carries an
`expect(callsInspected).toBeGreaterThan(0)` self-check so an empty population
fails loudly instead of silently, and carries a mutation proof: the detector is
run against a vulnerable snippet, the fixed snippet, and a legitimate one, and
must score 1 / 0 / 0.

### The dead-man switch

`markStored` hardcoded `scanStatus: PENDING`. Nothing in the codebase ever
advanced it — grep for `markScanClean` outside its own file returned zero
call sites. The download gate 403s a `PENDING` file, and `AV_SCAN_MODE`
defaults to `strict`. So any deployment that took the default without a
ClamAV service would block every evidence download, permanently, with no
error anywhere: uploads succeed, downloads 403, and the audit trail says the
files are fine. Production escaped only because the VM compose file hardcodes
`disabled` — i.e. by turning scanning off entirely.

`scanUploadedBuffer` now returns a **terminal** status on every path:

| condition | status |
|---|---|
| no scanner configured (`disabled`, or no `CLAMAV_HOST`) | `SKIPPED` |
| scanned, clean / infected | `CLEAN` / `INFECTED` |
| scanner errored, `AV_SCAN_MODE=strict` | `PENDING` (deliberate quarantine) |
| scanner errored, otherwise | `SKIPPED` |

`PENDING` now means one specific thing — a configured scanner failed under a
mode that asked us to fail closed — instead of meaning "nobody looked".

The configuration told four different stories about this: `env.ts` defaulted to
`strict`, prod and staging compose said `strict` (both do run ClamAV, so those
were coherent), the live agrent stack said `disabled` with no scanner, the prod
example env said `permissive` with no scanner, and `docs/cloud-storage.md`
documented the default as `permissive`. The example env and the doc are
corrected, and `tests/guardrails/av-scan-mode-coherence.test.ts` now refuses a
compose file that names a *scanning* mode without wiring a `CLAMAV_HOST` — a
mode is a promise about files, and the host has to be able to keep it.

### The bytes never went

Every purge path did a raw `DELETE FROM "Evidence"` and stopped. The stored
object was never touched, and `purgeSoftDeletedOlderThan` went further: after
90 days it deleted the `FileRecord` too — the only pointer to the object —
while the bytes stayed on the volume.

Unbounded storage growth is the boring half. The serious half is that the
product REPORTS the evidence purged, writes a `DATA_PURGED` audit entry saying
so, and the file remains readable — a retention and GDPR failure that was
directly reachable through the cross-tenant read paths above.

`purgeEvidenceBytes` enforces two rules, and each exists because of a specific
way the obvious implementation goes wrong:

- **Bytes before pointer.** Object first, `FileRecord` second. Crash in between
  and the row still points at a missing object: the next sweep retries, the
  download surfaces a clean "not found". The opposite order loses the only
  handle on live bytes, permanently and silently.
- **Only on the last reference.** SHA-256 dedup lets several `Evidence` rows
  share one `FileRecord` — uploading the same PDF to two controls reuses the
  record. Deleting the object because one of those rows was purged breaks every
  survivor, and breaks it invisibly until someone clicks download.

A storage delete that fails **keeps** the pointer, deliberately. A `FileRecord`
whose object could not be deleted is the only thing a later sweep can find
those bytes with; dropping it is how an unreachable object is made.

### The transaction that was poisoned by its own error handling

`uploadEvidenceFile` wrapped its `ControlEvidenceLink` insert in
`try { … } catch { }`, commented "duplicate link is acceptable". Under a mocked
Prisma client that reads correctly. Under a real interactive transaction it is
the exact opposite: a unique violation (23505) aborts the transaction *at the
database*, and every statement afterwards fails with 25P02 "current transaction
is aborted". Catching the JavaScript exception un-aborts nothing. The audit
write on the next line died, and the operation the catch existed to permit —
uploading the same file to a control twice — was the one thing that reliably
broke.

All three bridge sites (`uploadEvidenceFile`, `createEvidence`,
`attachAutoEvidence`) now use `createMany({ skipDuplicates: true })`, which
compiles to `ON CONFLICT DO NOTHING` and resolves the conflict inside the
statement so 23505 is never raised. Nothing is swallowed either: a real failure
— bad FK, RLS denial — still throws and still rolls the upload back, which is
what should happen and is not what the catch did.

This is why the integration test is not optional here. A mocked Prisma client
cannot exhibit transaction abort; the bug is invisible to every unit test that
could be written for it. `tests/integration/evidence-duplicate-link.test.ts`
proves the premise directly (swallow a real 23505, run one more statement,
expect 25P02) before proving the fix, so a future reader can tell whether the
premise still holds rather than having to trust this paragraph.

### One more thing the run exposed

The integration-suite DB probe in `tests/integration/db-helper.ts` used a 5
second `spawnSync` budget. The probe pays a cold Node start plus the Prisma
client's own load before it can attempt a connection: measured at ~7s on an
ordinary dev machine. Every integration suite in the repo was therefore
silently `describe.skip`-ing locally — the run got *greener by running less*,
which is the failure mode `CLAUDE.md` names explicitly. Raised to 30s. An
absent database still fails fast (ECONNREFUSED returns in milliseconds), so the
larger budget costs nothing in the case the timeout was guarding against.

## Files

| File | Role |
|---|---|
| `src/app-layer/repositories/FileRepository.ts` | `findOwnedByTenant` replaces `isFileOwnedByTenant` — returns the record, not a boolean; `getByPathKey` now requires an explicit `tenantId`; `markStored` takes the real scan outcome |
| `src/app-layer/usecases/file.ts` | `downloadFile` rewritten resolve-then-read; S3→local fallthrough removed; name + MIME from the record |
| `src/app-layer/usecases/audit-hardening.ts` | `verifyFileIntegrity` id-addressed, permission-gated, streaming size |
| `src/app-layer/policies/audit-readiness.policies.ts` | `assertCanVerifyIntegrity` (OWNER/ADMIN/AUDITOR) |
| `src/lib/storage/av-scan.ts` | `scanUploadedBuffer` — terminal status on every path |
| `src/app-layer/usecases/evidence.ts` | scan on upload; two link bridges de-poisoned |
| `src/app-layer/usecases/auto-evidence.ts` | third link bridge de-poisoned |
| `src/app-layer/usecases/journal.ts` | scan on upload |
| `src/app-layer/usecases/evidence-bytes.ts` | **new** — `purgeEvidenceBytes`, the two rules above |
| `src/app-layer/jobs/data-lifecycle.ts` | both purge paths release bytes before deleting rows |
| `src/app-layer/usecases/soft-delete-operations.ts` | `purgeEntity` releases bytes for `Evidence` |
| `deploy/.env.prod.example`, `docs/cloud-storage.md` | AV mode matches the host it describes |
| `tests/integration/db-helper.ts` | DB probe budget 5s → 30s |

## Decisions

- **Return the record, not a boolean.** The whole bug class is "checked one
  value, used another". A boolean ownership check cannot prevent it; a resolved
  record makes the safe key the only key in scope. This is the single change
  that would have prevented all of S1.1 and most of S1.2.
- **`notFound`, never `forbidden`, for a foreign file.** Losing the distinction
  costs a marginally less precise error message. Keeping it hands out a
  cross-tenant existence oracle.
- **`SKIPPED` rather than `PENDING` when no scanner is configured.** `PENDING`
  should mean "a scan is genuinely outstanding". Using it for "nobody will ever
  look" is what let a permanent block masquerade as a transient state.
- **`strict` stays the schema default.** Fail-closed is right *when a scanner
  exists*; the defect was that nothing checked whether one did. The new
  guardrail checks that, so the default no longer needs to be weakened to be
  safe.
- **Keep the `FileRecord` when the object delete fails.** Counter-intuitive —
  it leaves a row pointing at bytes we meant to remove — but it is the only
  state from which recovery is possible. The alternative loses the bytes'
  address while keeping the bytes.
- **`ON CONFLICT DO NOTHING` over a savepoint.** A savepoint would also work
  and would keep the `create` call shape. It is more machinery for the same
  outcome, and it leaves the misleading `try/catch` idiom in place for the next
  reader to copy. `skipDuplicates` says what is meant in one statement.
- **The 23505 premise is asserted, not just described.** If Postgres or Prisma
  ever changes that behaviour, the first test in the integration file fails and
  tells the reader the rationale is stale — instead of leaving a comment
  everyone believes.
