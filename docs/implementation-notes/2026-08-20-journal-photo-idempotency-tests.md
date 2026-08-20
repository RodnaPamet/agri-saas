# 2026-08-20 — The journal photo route: the third `Idempotency-Key` seam, and why it needed two files

**Commit:** `<pending> test(offline): drive the photo route's Idempotency-Key through to the audit trail`

Closes gap **#6** of the 2026-08-19 enforcement-seam audit, GitHub issue **#626**, and with it the last of the audit's 15 gaps.

## Design

`#641` covered two of the three offline-replay routes and **deliberately excluded** this one. That exclusion was correct, and its reasoning is the whole design here.

Dedup on `journal/[id]/files` is **content-addressed** — SHA-256 → `FileRecord` reuse → `@@unique([logEntryId, fileRecordId])`, behind an advisory lock on `(tenantId, sha256)`. So the audit's prescribed assertion for this gap, *"drive twice, assert one row"*, **passes here with the header read deleted**. Writing it that way would have produced a fourth test that looked like coverage and asserted nothing about the thing named.

What the key actually does on this route is one thing: it lands in the audit annotation `detailsJson.idempotencyKey` of the `LOG_ENTRY_FILE_ATTACHED` event, at `journal.ts:699` — its **only** consumption site.

### Two mutants, and no single harness kills both

| | Mutant | Killed by |
|---|---|---|
| **M1** | the route stops reading the header, or stops passing it on (`route.ts:41-42`) | a route-level spy on `uploadLogEntryPhoto` |
| **M2** | the usecase stops spending it — delete the `...(idempotencyKey ? { idempotencyKey } : {})` spread at `journal.ts:699` | an assertion that the key reaches `logEvent`'s `detailsJson` |

These are mutually exclusive harnesses. A route test must `jest.mock('@/app-layer/usecases/journal')` wholesale to observe the argument — which makes M2 invisible by construction. A usecase test must keep that module **real** — which puts the route out of reach. One jest module registry cannot hold both.

Hence **two files, deliberately**, and both docblocks say so, because "consolidate these two similar files" is exactly the tidy-up that would silently re-open half the seam.

The concern that produced M2 came from a peer review and is worth recording, because the first instinct was wrong in an instructive way: the worry was that the route might be forwarding into an **ignored** parameter, which would make a route-level spy vacuous. It isn't ignored — `:699` reads it. But checking revealed the real problem one layer over: a spy proves forwarding *and nothing else*, so `:699` could be deleted with the route test still green.

### Neither tier is redundant — measured

Every mutation below was run against the real source, restored afterwards, `git status` verified clean.

| Mutation | `…-route-idempotency` | `…-idempotency` (usecase) | Every other suite |
|---|---|---|---|
| Route: drop the header read + 5th argument | **3 of 5 fail** | pass | **37/37 green — blind** |
| Route: `String(req.headers.get(...))` → forwards `"null"` | **1 of 5 fails** | pass | green |
| Route: swap the `caption` / `idempotencyKey` argument positions | **3 of 5 fail** | pass | green |
| Usecase: delete the `:699` spread | pass | **1 of 5 fails** | **36/36 green — blind** |

The two "blind" rows are the point. The blind set includes `idempotency-forwarding-enforced.test.ts` — the sibling merged the same day for the other two routes — and `log-entry-idempotency.test.ts`, which passes the key as a positional argument and so is structurally incapable of noticing either end stopped supplying one.

### The absent-header assertion, and why it is deliberately loose

The first draft asserted `toBeNull()`. That was over-tight, and a peer review caught it.

`journal.ts:699` spreads on **truthiness**, so `null` and `undefined` are equivalent at the only place the value is used: both omit the audit field, and both are correct. The other two routes write `req.headers.get(...) || undefined`, so unifying this route with them is a **behaviour-preserving refactor** — and `toBeNull()` would have failed on it. A guard that fires on a no-op teaches the next reader to edit the guard rather than think about it, which is the same defect class as issue #658.

So the assertion pins the invariant that actually matters — the value must be **falsy**, and must not be a truthy stand-in. `String(...)` or a `?? 'null'` default writes a literal `"null"` into the audit trail of the БАБХ farm diary, where it reads as a real outbox id.

Verified in both directions:

| change to the route | expected | result |
|---|---|---|
| unify to `\|\| undefined` (benign) | tolerate | **5/5 pass** |
| `String(req.headers.get(...))` (hostile) | catch | **1 of 5 fails** |
| drop the read + argument (hostile) | catch | **3 of 5 fail** |

## Files

| File | Role |
|---|---|
| `tests/unit/journal-photo-route-idempotency.test.ts` | New. Owns **M1**: drives the real exported `POST` through its multipart branch and asserts the key reaches `uploadLogEntryPhoto` in argument slot 5. |
| `tests/unit/journal-photo-idempotency.test.ts` | New. Owns **M2**: drives the real `uploadLogEntryPhoto` and asserts the key reaches `logEvent`'s `detailsJson`; also covers the replay short-circuit, the advisory lock, and the lost-attach-race re-read. |

## Decisions

- **Two files, not one.** Forced by the jest module registry, as above. Documented in both docblocks rather than left for a reader to rediscover.
- **The multipart branch is verified, not assumed.** Setting `content-type: multipart/form-data` by hand omits the `boundary`, `req.formData()` throws, and the request 500s — a test written that way never enters the branch it names. The header is therefore left unset so undici derives it, and a positive control asserts `attachLogEntryFile` was **not** called, which is what falling through to the JSON branch would look like.
- **A fresh `NextRequest` per call.** The body stream is single-use; replaying one object gives 201 then 500. The replay test constructs two requests, which is also what an outbox actually does.
- **Every case asserts `201`.** Without it, a request failing for an unrelated reason — module gate, rate limiter, consumed body — leaves the spy uncalled and the argument assertion vacuous.
- **The rate limiter is not mocked.** `rate-limit-middleware.ts:319-324` auto-bypasses under `NODE_ENV=test`, so the real `withApiErrorHandling` wrapper runs. Mocking it would have removed a real code path for no benefit.
- **`@opentelemetry/api` is deliberately left real.** `errors/api.ts` imports the observability *submodules* directly, so a barrel mock does not intercept, and a hand-built `trace` literal drops `createContextKey` and fails the suite at load. Same finding as the sibling file.
- **The argument-position test exists because the key is last.** A trailing positional parameter slides silently when a parameter is inserted upstream, and TypeScript will not object if the neighbouring types are compatible. Pinning `caption` in slot 4 turns that into a failure here.
