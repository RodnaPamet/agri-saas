# 2026-07-27 — Clearing the code-scanning backlog

**Commit:** _(this PR)_

The repo's Security tab carried **18 open code-scanning alerts** and **zero**
Dependabot or secret-scanning alerts. This clears the 18.

| Class | Count | Resolution |
|---|---|---|
| `js/unused-local-variable` (note) | 17 | fixed at source — dead code deleted |
| `js/xss-through-dom` (high) | 1 | dismissed as a false positive, with the invariant hardened |

## The 17 unused-variable alerts

All dead imports or write-only locals, removed rather than suppressed —
matching the precedent set when the sibling repo cleared its CodeQL backlog
("fixed at source rather than dismissed").

Two were not simple deletions and are worth recording:

- **`rate-limit-middleware.ts`** imported `checkRateLimit` and
  `resetRateLimitDistributed` at the top *and* re-exported both at the
  bottom via `export { … } from '…'`. That form needs no local import, so
  the imports were genuinely dead while the re-exports — which callers
  depend on — are untouched. Deleting the whole import line would have been
  wrong; deleting the two specifiers was right.

- **`FarmTasksClient.bulkValueLabel`** was a **write-only** state: set in
  three places, read in none. The setter calls were removed with it, since
  a `useState` nobody reads is a re-render nobody needs. The alternative
  (rendering the label) would have invented a feature to justify the
  variable.

The removals were done by a script that refuses to touch any identifier
appearing more than once in its file, so the three that needed judgement
(above, plus `JournalRepository` in `inventory.ts` whose second "occurrence"
was its own module path) were surfaced for a human look instead of being
silently deleted.

## The XSS alert — dismissed, and why that is the right call

`js/xss-through-dom` at `JournalPhotosTab.tsx`: "DOM text is reinterpreted as
HTML without escaping meta-characters", on the `<img src={previewSrc}>` that
shows a just-captured photo.

It is a false positive, for reasons that hold at three independent levels:

1. **The value is not DOM text.** `previewSrc` has exactly one setter, and it
   is `URL.createObjectURL(file)`. That returns a browser-generated
   `blob:<origin>/<uuid>` — the string is minted by the browser, not read
   from the page and not supplied by any caller. CodeQL flags it because the
   `File` originates in an `<input type="file">` change event, so the *file*
   is DOM-derived; the *URL* is not.
2. **The sink escapes.** React escapes JSX attribute values, so even a
   hostile string could not "reinterpret as HTML" here.
3. **There is a runtime guard** — now at both ends: `mintPreviewUrl`
   validates `/^blob:/` where the URL is created (failing closed, revoking
   the URL and returning null), and the render still checks
   `previewSrc?.startsWith('blob:')`.

Point 3 is what this PR adds. It does not silence CodeQL — a prefix test is
not a modelled sanitiser for this query — but it moves the invariant to the
single place the value is born, so a future refactor that routes some other
string into `previewSrc` fails closed instead of rendering it.

**Why dismissal rather than a code change that clears the taint.** The only
restructurings that would break the dataflow are worse code: a `FileReader`
`data:` URL (larger, slower, and a genuinely riskier sink), or imperative
`ref`-based DOM writes (which trade a typed React attribute for exactly the
kind of manual DOM manipulation this query exists to catch). Neither removes
the taint — the `File` is still DOM-derived — so both would be contortions
that fix nothing. GitHub's dismissal flow, with a written reason, is the
intended resolution for a finding that is understood and not real.

The alert is dismissed as `false positive` with a comment pointing here.

## Not a fix: what remains true

Dismissal changes the Security tab, not the code. If `previewSrc` ever gains
a second setter, this note and the dismissal are both wrong and the alert
should be reopened — which is why the invariant is now asserted in
`mintPreviewUrl` rather than living only in a comment.
