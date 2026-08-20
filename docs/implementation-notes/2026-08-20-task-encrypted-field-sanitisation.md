# 2026-08-20 — Task.description / Task.resolution were written unsanitised

**Commit:** `<pending> fix(security): sanitise Task.description + Task.resolution at every write path`

## The defect

`Task.description` and `Task.resolution` are listed in `ENCRYPTED_FIELDS`
(`src/lib/security/encrypted-fields.ts:157`), so Epic B encrypts them at rest.
Neither was ever sanitised. Every task description and every resolution text in
the database is stored exactly as typed.

Encryption and sanitisation answer different questions. Encryption protects the
value **at rest**; it says nothing about the PDF export, the audit-pack share
link, or an SDK consumer that decrypts the row and renders it. That is the
whole reason Epic D.2 put sanitisation at the *usecase* layer rather than the
render layer.

## Why it was green

`tests/guardrails/sanitize-rich-text-coverage.test.ts` derives its inventory
from `ENCRYPTED_FIELDS` — a genuinely good design, and the reason it catches a
new *model* landing unclassified. But its per-model check was **file-level**:

```ts
Task: { usecases: ['src/app-layer/usecases/task.ts'], sanitizer: 'sanitizePlainText' },
```

…asserting only that `task.ts` imports and calls `sanitizePlainText`
*somewhere*. It did — for a task-link `note` (line 630) and a comment `body`
(line 709). Neither is `description` or `resolution`. The model reported
covered on the strength of two unrelated call sites.

This is the repo's own documented failure mode: **green is not the same as
executed.** A structural guard proves a pattern is present in source text. It
cannot tell you the value that reached the repository was clean.

The gap was in fact already written down — the docblock of
`tests/unit/security/sanitize-write-paths.test.ts` recorded it verbatim during
the GRC teardown and deferred the fix to "its own reviewed PR", on the grounds
that a source change did not belong buried in a deletion diff. That was the
right call; this is that PR.

## Four write paths, not one

The single-file coverage entry was also just wrong about *where* these columns
are written. Grepping by column rather than by usecase found four:

| path | column | why it was missed |
|---|---|---|
| `usecases/task.ts` — `createTask` / `updateTask` / `setTaskStatus` / `bulkSetTaskStatus` | both | the only file the guardrail named |
| `usecases/issue.ts` — `createIssue` / `updateIssue` / `setIssueStatus` / `bulkSetStatus` | both | issues and tasks are the **same `Task` row shape**; `issue.ts` sanitised only its comment body |
| `usecases/field-operation.ts` — `reviewFieldOperation` | `resolution` | calls `WorkItemRepository.setStatus` **directly**, never `setTaskStatus`, so a fix in the task usecase would not have covered it |
| `jobs/retention-notifications.ts` | `description` | interpolates a user-supplied evidence title; runs in a background job with no request context upstream to have sanitised it |

`createFieldOperation` writes `description` from `input.targetNote`, but routes
through `createTask` — covered by that fix, not a separate one.

## Ordering: sanitise BEFORE the emptiness gate

Both status paths gate terminal transitions on a non-empty `resolution` (Audit
Coherence S8 — "closed without why" was a recurring review finding). The
sanitise is placed **before** that gate, deliberately.

Measured behaviour of the real `sanitizePlainText`:

```
"   "                       -> "   "     (whitespace preserved)
"  finally fixed  "         -> "  finally fixed  "
"<script>alert(1)</script>" -> ""
"<b>x</b>"                  -> "x"
```

Sanitising *after* the gate would let `<script>alert(1)</script>` satisfy
"a resolution is required" and then render as nothing — a closed task whose
stated reason is the empty string. Sanitising first makes it fail the gate,
which is the correct outcome. Two tests pin this ordering explicitly.

## Files

| file | role |
|---|---|
| `src/app-layer/usecases/task.ts` | sanitise `description` (create/update) + `resolution` (single + bulk status) |
| `src/app-layer/usecases/issue.ts` | same four paths on the same `Task` row |
| `src/app-layer/usecases/field-operation.ts` | sanitise the review `comment` once — it reaches `resolution`, the audit `details` text and the reviewer notification |
| `src/app-layer/jobs/retention-notifications.ts` | sanitise the interpolated evidence title |
| `tests/guardrails/sanitize-rich-text-coverage.test.ts` | file-level → **field-level**; `Task` now lists all four writers |
| `tests/unit/security/sanitize-task-fields.test.ts` | the executing proof — hostile payload per call site |
| `tests/unit/security/sanitize-write-paths.test.ts` | docblock: the gap it recorded is closed |
| `tests/unit/issue-usecase.test.ts` | two assertions updated — the sanitiser now runs on this path |

## Decisions

- **The guardrail now asks per FIELD, not per file.** For every field in
  `ENCRYPTED_FIELDS[model]` it requires a sanitised binding *by name*, in one of
  three shapes that between them cover every idiom in the repo: assigned from a
  sanitiser call, passed as the sanitiser's argument, or bound via a sanitised
  alias (`const safeBody = …; body: safeBody`). 17 of 18 fields resolve
  structurally.

- **Repo-local helpers count, transitively.** `company.ts::sanitizeOptional`
  wraps `sanitizePlainText`, and `sanitizeCompanyInput` wraps *that*. Refusing
  to resolve the chain would have pushed five genuinely-covered fields into an
  exemption list, which teaches the wrong lesson — a whole-input seam is
  *stronger* than per-field sanitisation, not weaker.

- **`SEAM_COVERED` is verified, not trusted.** `FarmProfile.egn` / `.eik` are
  the one case a name-based scan cannot see: `upsertFarmProfile` reduces the
  `PROFILE_FIELDS` constant through a sanitising `norm`, so the field name never
  appears beside a sanitiser call. The exemption entry names the seam and the
  field list, and the test asserts both still exist and that the seam still
  calls a sanitiser. An exemption that cannot be checked is just a way to turn
  the test off.

- **A mutation proof, because a detector that matches everything proves
  nothing.** The guardrail strips the real `sanitizePlainText` calls from the
  real `task.ts` and requires a MISS. It initially failed — correctly: `task.ts`
  sanitises `description` at *two* sites and removing one still leaves a hit.
  The proof now removes both and asserts the count.

- **Verified by reverting.** With the source fix backed out, 10 of the 12 new
  executing tests fail and the guardrail fails on both fields. The 2 that still
  pass are the null / absent-field contract tests, which correctly do not depend
  on the sanitiser.

- **`issue-usecase.test.ts`'s stub was made faithful rather than its assertion
  loosened.** The repo-wide convention mocks `sanitizePlainText` to a visible
  ``SAN::`` prefix. Applied unconditionally, that turns `'   '` into a non-empty
  string and silently disables the file's whitespace-rejection assertion — the
  stub would have been deciding the test's outcome. It now marks the *content*
  and leaves whitespace-only input alone, matching the real function on both
  counts.

## Not fixed here

No backfill. Rows already written carry whatever was typed, and the columns are
encrypted so a plain `UPDATE … regexp_replace` cannot touch them — a sweep would
have to decrypt, sanitise and re-encrypt per row per tenant DEK, which is the
shape of the existing key-rotation job rather than a migration. Worth doing;
worth doing as its own reviewed change with its own dry-run, not appended to a
fix that stops the bleeding.
