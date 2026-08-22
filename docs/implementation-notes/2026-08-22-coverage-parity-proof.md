# 2026-08-22 — Coverage parity: proving the sharded gate before enforcing it

**Commit:** `<pending> ci(coverage): parity proof for the sharded coverage gate`

Stage 2 of restoring the coverage gate. Stage 1 (#714) made the gate report a
number again; this makes that number **provable**, which is the precondition for
letting it fail a build.

## Background

The `Coverage` job was one `--runInBand` process over the whole suite. It
outgrew its ceiling three times (25 → 35 → 60 minutes) and past ~24,600 tests
began CANCELLING at 60 on consecutive main pushes. A cancelled job also loses
its log buffer, so the gate reported neither a number nor a diagnosis — it was
simply dark, and had been for long enough that nobody could say what coverage
was.

Stage 1 sharded it six ways and istanbul-merges the per-shard reports. Measured
result: 5–10 minutes per shard against an 18-minute inner budget, ~13 minutes
wall clock against the 40–60 it was taking.

But the merged number was landed in **shadow mode** (`--report-only`). The merge
is *believed* sound — `CoverageMap.merge` keys on source location, so hit counts
sum and covered/total sets union — and a two-shard merge reproduced an unsharded
run of the same *subset* to the decimal. "A subset reproduced" is not "the whole
suite reproduces", and the gate scores the whole suite. Enforcing on an unproven
claim risks the one outcome worse than a dark gate: a green gate measuring the
wrong population, which nobody investigates.

## Design

One dispatch-only workflow runs the whole suite unsharded on a named commit,
downloads that same commit's sharded merge from its main-push CI run, and diffs
them. Clean diff ⇒ drop `--report-only`.

```
workflow_dispatch(ref)
   │
   ├─ resolve ref -> SHA, find its main-push CI run,        ← fails FAST if the
   │  download the `coverage-report` artifact                 commit has no
   │                                                          sharded artifact
   ├─ jest --coverage --runInBand   (no --shard, 110m)
   │
   └─ scripts/diff-coverage.mjs  sharded  vs  reference
          ├─ file set                    exact
          ├─ per-file covered/total      exact, all four metrics
          └─ threshold-group rows        exact, covered/total AND 2dp pct
```

### What the differ compares, and what it deliberately does not

Compared exactly: **the file set** (first, and most important), **per-file
covered/total**, and **the five threshold-group rows**.

The file set leads because it is the axis a percentage check cannot see. A
missing shard does not depress coverage — istanbul's merge *unions* the file
set, so absent files leave the denominator and the percentages **rise**. This
was measured, not assumed: deleting 3 of 315 files from `./src/lib/` moved it
statements 84.96 → 85.06 and branches 75.90 → 76.14. A parity check comparing
only percentages could therefore be satisfied by the exact failure it exists to
catch.

**Not** compared: raw execution counts (`s`/`f`/`b` hit tallies). This is the one
judgement call. Counts are not what the gate scores — a statement executed 3
times and one executed 3000 times are both "covered" — and they are legitimately
allowed to differ between a sharded and an unsharded run, because anything that
loops on wall-clock, retries, or consults a PRNG or `Date` changes its tally
without changing what is covered. Asserting on them would generate failures that
are real differences but not defects, and a parity check that cries wolf is one
somebody switches off. Covered/total is the coarsest comparison still strictly
stronger than the gate's own resolution.

## Files

| File | Role |
| --- | --- |
| `scripts/lib/coverage-groups.mjs` | jest's threshold-group assignment, extracted so checker and differ share ONE copy |
| `scripts/diff-coverage.mjs` | The parity differ. Exits 1 on any difference; refuses an empty map |
| `scripts/check-coverage-thresholds.mjs` | Refactored onto the shared module — output verified byte-identical |
| `.github/workflows/coverage-reference.yml` | Dispatch-only unsharded reference run + automatic diff |
| `tests/guards/coverage-parity-env-match.test.ts` | Guards the env match the proof depends on |
| `.github/workflows/ci.yml` | Corrected a stale comment describing the pre-shard 60-minute job |

## Decisions

- **The diff is automated inside the workflow, not eyeballed across two logs.**
  The whole point is a decimal-exact comparison; doing that by eye over five
  rows in two different job logs is precisely the step that goes wrong. The
  workflow emits a verdict and a step summary that names the next action.

- **One copy of jest's grouping algorithm.** The differ must group files exactly
  as the checker does or it certifies a population jest would never have scored.
  Rather than duplicate a subtle 60-line algorithm, it was extracted to
  `scripts/lib/coverage-groups.mjs` and both import it. The refactor was
  validated by diffing the checker's output on a real 1378-file map before and
  after: byte-identical. A guard asserts neither script re-implements the loop
  inline.

- **`env:` and `services:` are byte-identical to the sharded job, and guarded.**
  This is the entire validity of the comparison, and it fails silently.
  `tests/integration/bullmq-real-api.test.ts` gates on `REDIS_URL_TEST` and skips
  without it; adding redis to one side runs tests the other never ran, and the
  diff then reports a genuine difference that says nothing about sharding. The
  guard deep-compares both maps and carries a mutation proof (a synthetic redis
  service must break equality).

- **Dispatch-only, deliberately.** A 60–90 minute single-process run is exactly
  the cost sharding removed. On `push` it would reinstate the problem it
  certifies the fix for. Run it when the merge MECHANISM changes — a jest or
  istanbul major, an edit to `merge-coverage.mjs`, a change to the shard count —
  not on a schedule.

- **It compares against a real artifact, not a re-run.** Re-running the shards
  would measure a different execution; the point is to certify the artifact the
  gate actually scored. Hence the fail-fast lookup, which refuses a PR head or a
  commit whose 14-day artifact retention has expired rather than discovering it
  90 minutes in.

- **Test failures do not invalidate the run.** A test failing in both runs still
  produces coverage and the sharded side recorded the same failure. The step
  asserts a non-trivial map was produced (≥500 files) instead of gating on
  jest's exit code.

- **The failure message tells you what NOT to do.** Both the differ and the step
  summary say explicitly: do not re-floor `jest.thresholds.json` to make this
  pass. The floors are not what is in question — a difference means the two runs
  measured different code. That instruction exists because re-flooring from the
  wrong population is the mistake this repo has already made once, on
  2026-08-20.

## Next

Run the workflow on a merged commit. If it proves parity, drop `--report-only`
from the `coverage-gate` step in `ci.yml` and add the gate to branch protection.
If it does not, the file-set section names the divergence — **find the missing
files; do not move the floors.**
