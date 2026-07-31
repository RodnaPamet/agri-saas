# 2026-07-31 — Merge queue with a lean gate

**Commit:** _(this PR)_

## The failure this closes

Two PRs each pass CI against `main` as it was when their run started. Both
merge. **Nothing ever tested the combination.** Git only objects when the
collision is textual.

Observed twice in one day:

- **#454 + #456** — wave-22 tests were written against the exchange browse
  API that #456 reshaped in parallel (`commodity` → `commodities`, `side` →
  `sides`, `listInquiriesForSeller` removed). No textual conflict, so both
  merged clean; `main` went red on `Typecheck` and `Test (shard 4/4)` and
  needed **#459** to fix. The hidden cost was not the hour of redness — it
  was that every concurrent PR inherited three red jobs, so #458's author
  had to reason about which failures were their own.
- **#464 + #465** — both raised `RENDERED_TEST_FLOOR` 223 → 224
  independently. Caught only because it was the same line. Had one bumped
  the rendered floor and the other the e2e floor, both would have merged
  clean and left the ratchet under-counting on `main`.

A third, older instance is in the repo's history: two PRs each adding a job
and both bumping the same count guard.

## Why a queue rather than `strict: true`

Branch protection already exists on `main` with 11 required contexts and
`strict: false` — that flag *is* "require branches to be up to date", so the
blunt fix was one toggle away. It was rejected: `main` moved ~25 times on
2026-07-29, and `strict` forces a rebase plus a full ~25-minute re-run per
merge, serialised, with no batching. A queue tests the same combination and
can batch several PRs into one run.

## Why the gate is lean

The queue runs Lint, Typecheck, Test (4 shards + rollup), Build, Security,
CodeQL. **E2E and Docker skip in `merge_group`**, which satisfies branch
protection because a skipped required check passes — the same mechanism the
workflow already relies on for content-only PRs.

That is a deliberate trade, not an oversight:

- The observed escape was a **type error**. `Typecheck` catches it in ~3
  minutes; E2E (~20 min ×2 shards) and Docker (~21 min) catch nothing a
  merge collision produces, because that class shows up as a compile or unit
  failure, not a container-scan finding or a browser regression.
- Both jobs already run **twice** per change — on the PR, and on `main`
  after landing. Adding them to the queue would make it three times and add
  ~20 minutes of serialised wait to every merge.

**Residual risk, stated plainly:** a collision that compiles, passes unit
tests, and only breaks end-to-end still reaches `main` and is caught by the
post-merge run — exactly as today. There are no recorded instances of that
class. If one appears, the fix is to add `e2e` to the queue and accept the
wait.

## Changes

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | `merge_group:` trigger added; `e2e-shard` and `docker` excluded from it; the `changes` filter step skipped on `merge_group` |

The `changes` job needed care. It is a **required check**, and
`dorny/paths-filter` has no base/head pair to diff on a `merge_group` event.
Rather than let the action guess a base — and risk blocking every queued
merge on an error unrelated to the change — the filter step is skipped there
and the output defaults to `'true'`. That is the conservative direction: it
can only cause more to run, never less. In practice nothing reads it in the
queue, since all three consumers (`e2e-shard`, `load-smoke`, `docker`) are
either excluded from `merge_group` or push-only.

The existing concurrency expression already does the right thing:
`merge_group` is not `pull_request`, so it gets a per-commit group and
`cancel-in-progress: false` — a queued run can never be discarded by a newer
one, which is the property the 2026-07-28 comment in that block was added to
protect.

The `e2e` rollup already treats a skipped shard matrix as a pass, so no
change was needed there.

## Enabling order — this matters

1. **Merge this PR first.** The workflow must answer `merge_group` events
   before the queue exists.
2. **Then** enable the queue in branch-protection settings for `main`.

Reversed, the queue would wait forever on checks that never fire, and every
merge would hang.

Rollback is a settings toggle: disable the queue and merges revert to
today's behaviour. The workflow change is inert without it — a
`merge_group:` trigger on a repo with no queue simply never fires.
