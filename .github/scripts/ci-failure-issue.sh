#!/usr/bin/env bash
# Decide what a completed workflow run means, and act on it.
#
# Extracted from the workflow so it can be TESTED. The first version of this
# lived inline in ci-failure-issue.yml and shipped two defects that a test
# would have caught in seconds — see tests/unit/ci-failure-notifier.test.ts.
#
# Reads (all required except GH):
#   WF CONCLUSION RUN_URL RUN_ID EVENT BRANCH SHA REPO
# Uses `gh`, which the test replaces with a stub on PATH.
set -euo pipefail

GH="${GH:-gh}"
TITLE="CI failure: ${WF}"
# Machine-readable high-water mark. The close path compares against this so a
# slow-finishing run for an OLDER commit cannot close an issue about a NEWER
# failure — which is exactly what happened on 2026-08-21, when a success for
# c3581cfb closed an issue filed for d725e214.
MARKER_PREFIX="<!-- ci-failure-run:"

find_open_issue() {
    # Exact title over the LABEL, never `--search`: the search index lags by
    # seconds to minutes, which is precisely the window in which a nightly
    # files its second duplicate.
    "$GH" issue list --repo "$REPO" --label ci-failure --state open --limit 100 \
        --json number,title \
        --jq "[.[] | select(.title == \"${TITLE}\")] | .[0].number // empty"
}

recorded_run_id() {
    "$GH" issue view "$1" --repo "$REPO" --json body --jq .body 2>/dev/null \
        | sed -n "s/.*ci-failure-run: \([0-9]\{1,\}\).*/\1/p" | head -1
}

body() {
    cat <<EOF
**${WF}** concluded \`${CONCLUSION}\`.

| | |
|---|---|
| run | [${RUN_ID}](${RUN_URL}) |
| trigger | \`${EVENT}\` |
| branch | \`${BRANCH}\` |
| commit | ${SHA} |

This trigger has no PR page, so nothing else would have said so.

This issue closes itself on the next green run of the same workflow that is
NEWER than the failure above. Repeat failures arrive as comments here rather
than as new issues — many comments means the problem is persistent, not new.

${MARKER_PREFIX} ${RUN_ID} -->
EOF
}

EXISTING="$(find_open_issue)"

case "$CONCLUSION" in
    success)
        if [ -z "$EXISTING" ]; then
            echo "green, nothing open — nothing to do"
            exit 0
        fi
        RECORDED="$(recorded_run_id "$EXISTING")"
        # Run ids are monotonically increasing per repository, so this is a
        # reliable ordering even when runs finish out of order.
        if [ -n "$RECORDED" ] && [ "$RUN_ID" -lt "$RECORDED" ]; then
            echo "stale success: run ${RUN_ID} predates recorded failure ${RECORDED} — leaving #${EXISTING} open"
            exit 0
        fi
        "$GH" issue comment "$EXISTING" --repo "$REPO" --body \
            "✅ **${WF}** is green again — [run ${RUN_ID}](${RUN_URL}) on \`${BRANCH}\` (${SHA})."
        "$GH" issue close "$EXISTING" --repo "$REPO" --reason completed
        echo "closed #${EXISTING}: ${WF} recovered"
        ;;

    failure|timed_out)
        if [ -n "$EXISTING" ]; then
            "$GH" issue comment "$EXISTING" --repo "$REPO" --body "$(body)"
            # Refresh the high-water mark so a later success must be newer than
            # the LATEST failure, not the first one.
            "$GH" issue edit "$EXISTING" --repo "$REPO" --body "$(body)"
            echo "commented on #${EXISTING}: ${WF} failed again"
        else
            "$GH" issue create --repo "$REPO" --title "$TITLE" --label ci-failure --body "$(body)"
            echo "filed a new issue for ${WF}"
        fi
        ;;

    cancelled)
        # `cancelled` covers TWO different events, and the difference matters.
        #
        #   SUPERSEDED — a `concurrency` group keeps only the most recent
        #   PENDING run and cancels the earlier ones. Routine queue behaviour.
        #   #682 stopped filing on these because the first version of this
        #   notifier filed #680 for exactly that, which was the accumulating
        #   noise the design promised to avoid.
        #
        #   TIMED OUT — a job hit its `timeout-minutes` and was killed. That is
        #   a REAL failure, and GitHub reports it with the same conclusion
        #   string. Excluding all cancellations therefore created a false
        #   NEGATIVE: the Coverage gate exceeded its 60-minute budget on three
        #   consecutive main pushes on 2026-08-21 and this notifier said
        #   nothing, so a gate that could neither pass nor fail went dark
        #   unannounced. Fixing one false positive had created a worse false
        #   negative.
        #
        # The discriminator, derived from both real cases rather than guessed:
        # a SUPERSEDED run is killed while PENDING, so no job ever starts —
        # #680's run reports ZERO jobs. A timed-out run has jobs that ran, and
        # siblings that succeeded (17 of 18, in the Coverage case).
        #
        # Counting cancelled-vs-succeeded jobs does NOT work: measured 17/1 for
        # the timeout and 16/1 for the other candidate. Job DURATION alone does
        # not work either. "Did any job start?" does.
        STARTED="$("$GH" api "repos/${REPO}/actions/runs/${RUN_ID}/jobs?per_page=100" \
            --jq '[.jobs[] | select(.started_at != null)] | length' 2>/dev/null || echo 0)"
        if [ "${STARTED:-0}" -eq 0 ]; then
            echo "cancelled with no job ever started — superseded, not a failure"
            exit 0
        fi
        echo "cancelled after ${STARTED} job(s) started — treating as a real failure"
        CONCLUSION="timed_out_or_cancelled"
        if [ -n "$EXISTING" ]; then
            "$GH" issue comment "$EXISTING" --repo "$REPO" --body "$(body)"
            "$GH" issue edit "$EXISTING" --repo "$REPO" --body "$(body)"
            echo "commented on #${EXISTING}: ${WF} failed again"
        else
            "$GH" issue create --repo "$REPO" --title "$TITLE" --label ci-failure --body "$(body)"
            echo "filed a new issue for ${WF}"
        fi
        ;;

    *)
        # skipped / neutral / action_required are not failures.
        echo "conclusion=${CONCLUSION} — not a failure, no action"
        ;;
esac
