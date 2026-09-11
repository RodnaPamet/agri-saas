#!/usr/bin/env bash
#
# Decide whether image-tip-check should ASK about the tip, or stay quiet.
#
# Extracted from the workflow so it can be tested. It is the piece that got
# this wrong, so it is the piece that needs a test.
#
# The question this answers is NOT "is the triggering publish the tip's?" but
# "is there a reason to believe the tip is about to be answered for?".
#
# BACKGROUND (#877). ghcr-publish USED TO run under
#   concurrency: ghcr-publish-${{ github.ref }}   with cancel-in-progress
# so a merge cancelled the build in flight. A publish takes 13-23 minutes.
# When merges arrived faster than that, EVERY build was cancelled before it
# finished and the tip was never built. That half is fixed — the workflow now
# carries `cancel-in-progress: false` and queues — but this gate stays, and
# so does the reasoning below: a superseded PENDING run still reports
# `cancelled`, and a queue makes starvation rare rather than impossible.
#
# The old gate skipped whenever the triggering sha was not the tip, saying
# "that commit's own publish will trigger this check". Under starvation that
# premise is false — the tip's publish is cancelled too, so it never triggers
# anything. Measured 2026-09-10: this gate skipped at 15:19:09 and 15:25:08
# while production sat three commits behind, and the job exited 0 both times.
# A gate that cannot fire in the one condition it exists for is worse than no
# gate, because the green tick is read as an answer.
#
# So: not-the-tip is a reason to defer ONLY IF something is actually going to
# answer. That means a publish for the tip that is queued or running.
#
# Reads:  REPO, TARGET (the publishable tip), TRIGGERING_SHA
# Uses:   GH (default `gh`), overridable for tests
# Writes: `skip=true` to $GITHUB_OUTPUT when, and only when, deferring is safe
# Exits:  0 always — the DECISION is the output; failing the run is the
#         caller's job, via the check itself.
set -euo pipefail

REPO="${REPO:?REPO is required}"
TARGET="${TARGET:?TARGET is required (the publishable tip sha)}"
# Empty on `schedule` / `workflow_dispatch`: there is no triggering run to
# compare against, only the question "is anything going to answer for the tip?".
TRIGGERING_SHA="${TRIGGERING_SHA:-}"
GH="${GH:-gh}"
PUBLISH_WORKFLOW="${PUBLISH_WORKFLOW:-Publish image to GHCR}"
OUT="${GITHUB_OUTPUT:-/dev/null}"

echo "publishable tip : ${TARGET}"
echo "triggering run  : ${TRIGGERING_SHA:-<none: scheduled run>}"

if [ -n "${TRIGGERING_SHA}" ] && [ "${TARGET}" = "${TRIGGERING_SHA}" ]; then
    echo "this IS the tip's own publish — asking"
    exit 0
fi

# Is anything actually going to answer for the tip?
#
# Deliberately NOT `... || echo 0`. A rate limit, a 5xx or a jq error must not
# read as "nothing is running", because that answer sends us down the SKIP
# path — the exact collapse that made the notifier go silent in #873. A failed
# probe means we do not know, and not knowing is a reason to ASK, not to defer.
if RUNS_JSON="$("${GH}" api "repos/${REPO}/actions/runs?head_sha=${TARGET}&per_page=100")"; then
    IN_FLIGHT="$(printf '%s' "${RUNS_JSON}" | jq --arg wf "${PUBLISH_WORKFLOW}" \
        '[.workflow_runs[] | select(.name == $wf)
          | select(.status == "queued" or .status == "in_progress")] | length')"
    RECENT="$(printf '%s' "${RUNS_JSON}" | jq -r --arg wf "${PUBLISH_WORKFLOW}" \
        '[.workflow_runs[] | select(.name == $wf) | .conclusion // .status] | join(", ")')"
else
    IN_FLIGHT="unknown"
    RECENT="probe failed"
fi

if [ "${IN_FLIGHT}" = "unknown" ]; then
    echo "::warning::Could not read the tip's publish runs. Not deferring on an answer we do not have — asking."
    exit 0
fi

if [ "${IN_FLIGHT}" -gt 0 ]; then
    echo "skip=true" >> "${OUT}"
    echo "::notice::Publish for ${TRIGGERING_SHA:0:9} completed, but the publishable tip is ${TARGET:0:9}, whose own publish is still running (${IN_FLIGHT} in flight). That run will trigger this check. Not asking yet."
    exit 0
fi

echo "::warning::The publishable tip ${TARGET:0:9} has NO publish queued or running (its runs: ${RECENT:-none}). Nothing is going to answer for it, so asking now rather than deferring to a run that will never happen. See #877."
exit 0
