#!/usr/bin/env bash
#
# Re-dispatch a FAILED image publish, once (#2582).
#
# ── The gap this closes ──
#
# On 2026-10-31 two consecutive commits on main shipped no image. One publish
# was CANCELLED as a supersession — correct by design — and the next FAILED
# with `no space left on device`. The concurrency design assumes the newest
# build of a burst ships; when it does not, nothing retries, so a single disk
# failure strips the publish from every commit in the burst. `/api/readyz` was
# green throughout, because a stale image is a healthy image.
#
# Detection already exists and worked: `image-tip-check.yml` reported the
# missing tag within a minute. What had no mechanism was RECOVERY — a human
# read the issue and re-ran the workflow. This is that one click, automated.
#
# ── Three guards, and each would be a defect without it ──
#
# 1. `failure` ONLY, never `cancelled`.
#
#    Since #877 the publish QUEUES rather than cancels, so a cancellation is a
#    supersession: the queue dropping a pending run because a newer commit
#    arrived. Retrying one would rebuild an OLDER commit — see guard 3 for why
#    that is actively harmful rather than merely wasteful. `timed_out` is
#    excluded for a different reason: the one real instance had already pushed
#    successfully 13 minutes before the budget killed it, so a retry there
#    rebuilds something that is already served.
#
# 2. FIRST ATTEMPT only.
#
#    `run_attempt` is 1 for an original run and increments on every re-run, so
#    the retry cannot retry itself. Without this a genuinely broken build — a
#    full disk, a bad Dockerfile — loops until somebody notices, which is the
#    failure mode an automated remedy is most likely to introduce.
#
#    Note that re-running is the RIGHT tool here and the wrong one for CI. A
#    re-run replays the original commit, which is exactly the point when the
#    artefact is keyed to that commit; for a test workflow it means the run can
#    never pick up a fix.
#
# 3. The failed run's sha must STILL be main's publishable tip.
#
#    `ghcr-publish.yml` pushes `type=raw,value=latest` as well as
#    `sha-<short>`. So re-publishing a commit that main has moved past would
#    move `:latest` BACKWARDS — production would be told to run older code by
#    the thing meant to repair it. If the tip has moved, the newer commit's own
#    publish covers it and there is nothing to do.
#
# Usage: CONCLUSION=… RUN_ID=… RUN_ATTEMPT=… HEAD_SHA=… TIP_SHA=… REPO=… \
#          ./publish-retry.sh
#
set -euo pipefail

REPO="${REPO:?REPO is required, e.g. RodnaPamet/agri-saas}"
CONCLUSION="${CONCLUSION:?CONCLUSION is required}"
RUN_ID="${RUN_ID:?RUN_ID is required}"
RUN_ATTEMPT="${RUN_ATTEMPT:?RUN_ATTEMPT is required}"
HEAD_SHA="${HEAD_SHA:?HEAD_SHA is required}"
TIP_SHA="${TIP_SHA:?TIP_SHA is required: the newest publishable commit on main}"
GH="${GH:-gh}"

# Guard 1 — only a genuine failure.
if [ "$CONCLUSION" != "failure" ]; then
    echo "conclusion is '${CONCLUSION}', not 'failure' — nothing to retry"
    echo "  a cancellation is a SUPERSESSION since #877; retrying it would rebuild an older commit"
    exit 0
fi

# Guard 2 — never retry a retry.
if [ "$RUN_ATTEMPT" != "1" ]; then
    echo "run ${RUN_ID} is attempt ${RUN_ATTEMPT} — already retried, leaving it alone"
    echo "  a second automated retry is a loop; image-tip-check has reported the gap"
    exit 0
fi

# Guard 3 — the sha must still be the tip, or `:latest` would regress.
if [ "$HEAD_SHA" != "$TIP_SHA" ]; then
    echo "run ${RUN_ID} built ${HEAD_SHA:0:9}, but main's publishable tip is ${TIP_SHA:0:9}"
    echo "  the tip MOVED — its own publish covers it, and re-pushing the older"
    echo "  commit would move :latest backwards"
    exit 0
fi

echo "retrying run ${RUN_ID}: a failed publish of the current tip ${TIP_SHA:0:9}"
"$GH" run rerun "$RUN_ID" --repo "$REPO"
echo "re-dispatched run ${RUN_ID} (attempt 2)"
