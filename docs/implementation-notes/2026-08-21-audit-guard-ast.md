# 2026-08-21 — the audit-structured-events guard stops slicing lines

**Issue:** #658

## Design

`tests/guards/audit-structured-events.test.ts` guard 1 asserted that every
`logEvent` call site passes `detailsJson`. It did so by taking a **fixed
15-line slice** from each `logEvent(` line and truncating it at the first
textual `});` found with `String.indexOf`:

```js
const context = lines.slice(i, Math.min(i + 15, lines.length)).join('\n');
const closingIdx = context.indexOf('});');
const callSnippet = closingIdx >= 0 ? context.substring(0, closingIdx + 3) : context;
if (!callSnippet.includes('detailsJson')) { /* violation */ }
```

It never brace-matched, so it did not know where a call ended; `indexOf` has no
notion of nesting, of which call a terminator belongs to, or of comment
context. **Its protection was contingent on formatting, not on structure**,
and it failed in three separate directions. All three were reproduced against
real repo files before the rewrite.

### 1. False positive — a compliant call reported as a violation

`detailsJson` past offset 14 is invisible to the slice. Measured across the
189 usecase call sites, the deepest sits at **offset 11**
(`issue.ts:489`) — **three lines of headroom.** Adding four ordinary comment
lines above it pushes the offset to 15, and:

```
OLD GUARD: 1 violation(s) -> app-layer/usecases/issue.ts:489
NEW GUARD: 16 passed
```

The call is fully compliant in both runs. This is how the defect was found —
a comment added inside a call body during #393/#646 failed CI on correct code.

### 2. False negative — a non-compliant call borrows its neighbour's field

When no `});` falls inside the window, `closingIdx === -1` and the snippet
becomes the whole 15 lines, spilling into the **next** call. Reproduced on a
real file: `editable-lifecycle-usecase.ts`, unmodified except for rewriting
the call at line 294 into the helper-payload form
`await logEvent(db, ctx, buildAuditEvent(entityId));`. The neighbouring
compliant call's `detailsJson` lands inside the window:

```
OLD GUARD: GREEN (0 violations) — mutant UNDETECTED
NEW GUARD: app-layer/usecases/editable-lifecycle-usecase.ts:294 — logEvent without detailsJson
```

A real usecase file, with a real audit call shipping no structured payload,
passed — purely because it had a compliant neighbour. **37 call sites have a
body spanning more than 15 lines**, so the spill condition is common; what is
rare is a site that also lacks the field.

### 3. The token matches inside a comment

`callSnippet.includes('detailsJson')` is a substring test over text that
includes comments. A call with no `detailsJson` **property** but a comment
mentioning the word passes. Found by accident — the first false-positive probe
written for §1 contained the word `detailsJson` in its own comment text and the
old guard went green on it, which invalidated the probe and revealed this.

### The rewrite

Guard 1 now walks the TypeScript AST. A `logEvent` CallExpression either has a
`detailsJson` property or it does not; comments, reformatting and neighbours
cannot change the answer. The detection logic is extracted as a **pure
function over source text**, `assertDetailsJson(displayPath, source)`, so the
mutation proofs feed it synthetic files — the guard tests its own detector
rather than asserting that a detector exists.

Only **bare** `logEvent(...)` identifiers count. This matters:
`sync-orchestrator.ts` has nine `this.logEvent(...)` calls that are a private
method on the orchestrator class, unrelated to the audit writer. Any matcher
that greps for `logEvent(` counts them, and #658's own "27 unscanned call
sites" figure includes them. The real number outside `usecases/` is **17**.

### Widening the scan, and the six sites that fell out

The guard scanned `src/app-layer/usecases` only. Widening it to all of `src`
surfaced **six real audit calls with no `detailsJson` at all**:

| Site | Event |
|---|---|
| `onboarding.events.ts:7,23,40,56` | `ONBOARDING_{STARTED,STEP_COMPLETED,FINISHED,RESTARTED}` |
| `admin/_lib/rotate-dek-handlers.ts:43` | `TENANT_DEK_ROTATED` |
| `admin/key-rotation/route.ts:44` | `KEY_ROTATION_INITIATED` |

That is not cosmetic. **`streamAuditEvent` drops the free-text `details`
field and ships only the structured payload** (`audit-stream.ts:29-31`), so
three of the onboarding events — whose entire content was a `details` string
and which carry no `metadata` either — were reaching a tenant's SIEM as an
action verb and an entity id with **nothing else**. The two key-rotation
events did carry `metadataJson`, so they were not blind, but they left the
field the stream documents as "the SIEM-friendly source of truth" empty.

All six were given a `detailsJson`, so the widened guard needs **no baseline**:
it is 206 of 206.

## Files

| File | Role |
|---|---|
| `tests/guards/audit-structured-events.test.ts` | AST walk replaces the line slice; `assertDetailsJson` extracted; four mutation proofs; scan widened to `src` |
| `src/app-layer/events/onboarding.events.ts` | four events given `detailsJson` + a docblock recording why the stream makes it load-bearing |
| `src/app/api/t/[tenantSlug]/admin/_lib/rotate-dek-handlers.ts` | `TENANT_DEK_ROTATED` given `detailsJson` |
| `src/app/api/t/[tenantSlug]/admin/key-rotation/route.ts` | `KEY_ROTATION_INITIATED` given `detailsJson` |

## Decisions

- **AST, not a wider window.** Bumping 15 to 40 would have moved the cliff, not
  removed it, and would have made the spill worse — a wider window swallows
  more neighbours. The failure mode is structural, so the fix has to be.

- **The detector is a pure function, and the guard tests it.** This is the
  point of the change, not a refactor. The previous implementation would have
  failed proof 1 and passed proof 2, and nothing in the repo would have said
  so. Per CLAUDE.md's "green is not the same as executed": a guard that only
  runs against a tree where it happens to be right is not evidence.

- **A resolving-power floor**, `MIN_EXPECTED_CALL_SITES = 150` (measured 206).
  Without it, a matcher that silently stopped matching would report a clean
  tree, which is the same failure this whole issue is about.

- **The six sites were fixed rather than baselined.** A six-entry baseline with
  written reasons would have been the conventional move, but each reason would
  have read "this event ships no payload to the SIEM and we accept that" —
  which is not a thing to accept, and would have become an untracked hole of
  exactly the kind this repo has spent the week closing.

- **`this.logEvent` is excluded deliberately and has its own test.** Nine
  false violations would have forced a nine-entry exemption list for a function
  that is not the audit writer at all — an exemption list that would then have
  looked like nine known audit gaps to the next reader.

- **Not changed: guards 2–5.** The raw-INSERT scan, the script-existence
  checks and the Zod payload cases are unrelated to the window defect.
