# 2026-09-11 — publish starvation: queue instead of cancel

**Commit:** `<sha> fix(ci): queue publishes instead of cancelling them, so the tip can ship`

The starvation half of #877. The blindness half — `image-tip-check` reporting
success while deferring to a run that starvation guarantees will never
happen — landed separately as #878.

## The defect

`ghcr-publish.yml` carried:

```yaml
concurrency:
    group: ghcr-publish-${{ github.ref }}
    cancel-in-progress: true
```

The reasoning was sound — only the tip's image matters, so an older build
should die — and the outcome was that during a busy period NOTHING ships.
A publish takes longer than the gap between merges often enough that each
build is cancelled before it can push. Nothing goes red: every cancellation
is individually correct, and a notifier keyed on failures sees a healthy
repo. On 2026-09-10 production sat three commits behind for over three
hours; the cure was a merge hold.

The pathological cadence is "slightly less than the publish duration",
which is what considerate people naturally produce. Batching merges
tightly is strictly better than spacing them out.

## What was measured

199 real publish runs, `event=push`, 2026-08-15 → 2026-09-10, captured with
`gh run list --workflow=ghcr-publish.yml --limit 200` and kept as
`tests/fixtures/ghcr-publish-history.json`.

| | |
|---|---|
| publish duration | 13.6 min p50, 18.5 p90, 22.8 max (138 successes) |
| merge gaps | 37% shorter than 21.4 min, 25% under 10 min, 15% under 1 min |
| cancellations | 59 runs, 265 minutes of build time, zero images |

## The fix

`cancel-in-progress: false`, same per-ref group.

The half that is easy to get backwards: this does **not** build every
commit. GitHub keeps ONE running and ONE pending run per concurrency
group, and a newly-queued run cancels the previously pending one. A burst
therefore costs at most two builds — the one already executing (which
finishes and ships) plus the newest commit of the burst. The middle of the
burst is dropped while still pending, at zero runner minutes.

`ci.yml` already carries the same rule written from the other side: there
the pending-drop was the BUG, because CI produces per-commit signals
(SARIF upload, coverage verdict) and dropping a commit loses one. A
publish produces one mutable `:latest` pointer, so dropping the middle of
a burst is the wanted behaviour, and serialising is what keeps that
pointer monotone.

## Before → after

Replaying the real 199-merge timeline through the modelled concurrency
rules, at the worst measured build duration (22.8 min):

| | before | after |
|---|---|---|
| commits shipped | 124 | 173 |
| runner minutes wasted | 458 | 95 |
| worst time a commit spends unshipped | 63.1 min | 45.5 min |
| `:latest` rolled backwards | 0 | 0 |

At the measured incident cadence (merges every 8 min, 21.4-min builds,
three hours): images shipped inside the window **0 → 8**.

## Decisions

- **Modelled, not asserted.** A merge cadence is not something a test can
  produce, so `tests/helpers/actions-concurrency.ts` implements GitHub's
  documented rules and `tests/guards/publish-starvation.test.ts` drives it.
  The model is VALIDATED before it is used: replaying the real merge
  timestamps under the OLD policy reproduces GitHub's own
  success/cancelled verdict on ~94% of the 199 runs. That replay uses a
  CONSTANT build duration deliberately — feeding each run its own recorded
  duration would leak the answer, since a run that succeeded is by
  definition one no merge interrupted.

- **A closed burst does not discriminate, and the test says so.** Three
  merges in twenty minutes followed by silence ends with the tip built
  under BOTH policies, and under the old one it is built SOONER. That case
  is asserted, not hidden — it is exactly why the bug was invisible for so
  long. The discriminating scenario is a busy period that is still going,
  which is the measured incident, and there the old policy ships nothing
  at all.

- **Per-commit group REJECTED (option b).** `ghcr-publish-${{ github.sha }}`
  would beat everything on latency by building every commit in parallel.
  But `:latest` is a single pointer Watchtower polls, and parallel runs
  finish in completion order, not merge order: drawing from the real gap
  and duration distributions, an older commit's publish lands after a
  newer one's in 25.4% of colliding combinations. That is production
  rolling backwards. The test measures it on the real timeline rather than
  asserting it.

- **Faster builds REJECTED (option c).** 15% of merge gaps are under one
  minute and 20% under five. Speeding the build narrows the race; nothing
  ends it.

- **`workflow_dispatch` was never a rescue.** It joins the same per-ref
  group and was cancelled like the others. The test pins that both
  triggers exist so the group being asserted is the group they land in.

## Left undone

- The tip can now wait up to TWO build durations after the last merge of a
  burst instead of one. Bounded, where the old behaviour was not.
- A build wedged short of its 40-minute timeout now holds the queue
  instead of being cleared by the next merge. `timeout-minutes: 40` is the
  only bound on that, and it was not tightened here.
- Nothing measures publish latency continuously. The numbers above are a
  one-off capture and the fixture will age; it is evidence of a shape, not
  a live signal.
