# 2026-08-20 — `.trivyignore`: eight dead exemptions, and the guard that was missing

**Commit:** `<pending> chore(security): delete the eight dead .trivyignore exemptions and guard the contract`

Closes GitHub issue #644.

## Design

`.trivyignore` is the single structural escape hatch from the container CVE
gate. CI runs Trivy with `--severity CRITICAL,HIGH` and fails the build on a
hit; an id in this file removes that hit. The file's own header has always
stated a contract — every entry carries the CVE id, the affected package path,
why it is safe today, and the trigger that retires it.

**Nothing enforced any of it.** `grep -rl trivyignore tests/` returned zero
files before this change. The npm-audit half of the same gate has had a real
enforcement script since #468's era (`scripts/audit-exemptions.mjs`, whose rule
is "exempt ONLY by GHSA id … so a NEW advisory on the same package still blocks
the merge"). Trivy had the escape hatch and none of the discipline.

### What went stale, and how

All eight entries named an affected path under
`usr/local/lib/node_modules/npm/node_modules/…` — packages bundled inside the
npm CLI that ships with `node:22-alpine`, not in our application tree.

`Dockerfile:163` deletes that directory:

```dockerfile
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx
```

So the packages are absent from the image Trivy scans, and the exemptions
matched nothing. Each entry also carried a retirement trigger of the form *"the
next Node base-image bump that ships an npm CLI bundling a fixed version"* —
which had become **unreachable**, because there is no npm CLI in the image at
any version. The condition that was supposed to retire them could never occur.

The Dockerfile comment that accompanies the deletion had already said as much:
*"Deleting the CLI removes the finding at the source rather than suppressing it
in `.trivyignore`."* The entries were simply never deleted afterwards.

### Why a dead entry is not merely untidy

`.trivyignore` suppresses a CVE id **across the whole image**. It has no notion
of the path the comment names — that path exists only in prose, for humans.

`picomatch` is the live example. `CVE-2026-33671` was exempted on the argument
that the only vulnerable copy lived inside the npm CLI, our own tree being
pinned safe by `"picomatch": "^4.0.4"` in `package.json`'s `overrides` block
(the tree resolves 4.0.4/4.0.5 today). Drop that override, or take a transitive
dependency that vendors its own copy, and the same id now describes a package
we genuinely ship — and Trivy stays silent under a comment that still reads as
a considered justification for a situation that ended.

That is the asymmetry: a dead entry costs nothing the day it dies, and its cost
arrives later, silently, in the one place designed to be loud.

### The guard

`tests/guards/trivyignore-exemptions.test.ts` parses both files rather than
grepping either. An entry is a bare `CVE-…`/`GHSA-…` line plus the contiguous
comment block above it; `deletedPaths()` extracts every absolute path from the
Dockerfile's `rm -rf` invocations, continuation lines included. Three rules:

1. every entry carries `Affected path:`, `Why exempt:`, `Upgrade plan:`;
2. its stated path is not one the Dockerfile deletes (prefix-matched, and
   leading slashes normalised, because Trivy reports `usr/local/…` while the
   Dockerfile writes `/usr/local/…`);
3. the `.trivyignore` header still names those three field labels, so the
   error messages point at something the file actually teaches.

### The vacuity problem, and the fixtures that solve it

The file now holds **zero** entries, which is exactly when a guard rots into a
tautology: rule 2 would pass against an empty list forever, including after
someone broke the parser. Two defences.

A **positive control** on the parser itself — `deletedPaths()` must find
`/usr/local/lib/node_modules/npm`. If the Dockerfile's deletion is ever
restructured out of `rm -rf` shape, the guard says so instead of silently
approving everything. This is the same failure-open shape the CSP nonce patch
verifier guards against, for the same reason.

A **synthetic-fixture suite** that runs the real parser and the real rules over
hand-built input: a verbatim reconstruction of one of the eight stale entries
(must be rejected), one entry per missing required field (must be rejected),
an entry whose path the image does contain (must be *accepted* — without this,
a rule that rejected everything would look identical to one that works), and a
leading-slash variant.

### Mutation proof

Run before committing, each against the real files, each restored afterwards:

| Mutation | Result |
|---|---|
| Re-add the original `CVE-2026-33671` picomatch entry verbatim | **fails** — `the Dockerfile deletes "/usr/local/lib/node_modules/npm"` |
| Add a live-path entry missing `Upgrade plan:` | **fails** — `is missing a "Upgrade plan:" field` |
| Neuter the Dockerfile's `rm -rf` | **fails** — the positive control fires |

## Files

| File | Role |
|---|---|
| `.trivyignore` | Eight dead entries removed. Header rewritten to spell the three required field labels literally, with a copyable template, so the vocabulary the parser wants is the vocabulary a contributor reads. |
| `tests/guards/trivyignore-exemptions.test.ts` | New. Parses `.trivyignore` + `Dockerfile`; three rules, a parser positive control, and five synthetic fixtures. |

## Decisions

- **Delete the entries rather than rewrite their triggers.** A retirement
  trigger that can never fire is not a weaker exemption, it is a permanent one.
  Nothing is lost by deletion: if any of these CVEs ever appears against a
  package we actually ship, we want the build to fail.
- **Key the staleness rule on the Dockerfile, not on a Trivy run.** The guard
  had to work in the unit-test tier, offline, with no image build and no CVE
  database. "The image cannot contain this path" is decidable from the two
  files alone, and it is the specific way these eight died.
- **Fix the header, not the assertion.** Rule 3 failed on first run because the
  rewritten header described the required fields in prose instead of naming
  them. Weakening the assertion was the tempting one-line fix, and it would
  have preserved the actual defect — a contributor told to "include the reason
  it's safe" has no way to know the parser wants that reason under a specific
  label. The header now carries a template.
- **Field-presence only; no attempt to verify the *claims*.** The guard cannot
  know whether "not reachable from any request path" is true. It checks the
  reasoning exists, is structured, and still has a subject — the parts that are
  machine-decidable. Judging the argument stays a human review job.
- **No baseline / exemption list.** The `REPO_BASELINE` pattern used by
  `no-secrets.test.ts` exists for pre-existing debt that cannot be cleared in
  one diff. Here it could be, and was.
