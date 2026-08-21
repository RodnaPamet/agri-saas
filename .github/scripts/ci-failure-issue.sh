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

    *)
        # cancelled / skipped / neutral / action_required are NOT failures.
        #
        # `cancelled` is the one that matters and the one that bit us. A
        # workflow with a `concurrency` group keeps only the most recent
        # pending run and cancels the earlier ones — so four rapid merges to
        # main produced two cancelled Release runs, and the first version of
        # this notifier filed an issue for one of them. That is the queue
        # working correctly. A human pressing cancel is likewise deliberate.
        # Neither needs a ticket, and filing for them is precisely the
        # accumulating noise this design promised to avoid.
        echo "conclusion=${CONCLUSION} — not a failure, no action"
        ;;
esac
