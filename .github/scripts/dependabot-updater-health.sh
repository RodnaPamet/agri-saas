#!/usr/bin/env bash
#
# Is the Dependabot updater actually running? — #2230
#
# ## Why this is a SCHEDULED probe and not a `workflow_run` watch
#
# `ci-failure-issue.yml` watches every workflow that can fail silently, and
# `Dependabot Updates` is exactly that class — a failing updater means security
# bumps stop arriving with nothing saying so. It was listed there and had to be
# REMOVED, for a reason no permissions block can fix:
#
#   A `workflow_run` triggered by a run whose actor is `dependabot[bot]` is
#   given a READ-ONLY token regardless of the declared `permissions:`, so the
#   issue-creation call answers 404 and the notifier itself becomes a red run.
#
# Measured 2026-10-23, the same workflow inside seven minutes:
#
#   22:08  actor=h0mele55        success
#   22:11  actor=dependabot[bot] FAILURE  {"message":"Not Found","status":"404"}
#   22:15  actor=h0mele55        success
#
# A `schedule` trigger carries a normal token, so this asks the SAME question
# from the other side: rather than reacting to the run, it reads the run
# HISTORY. That is the shape `ci-failure-issue.yml`'s own comment prescribes.
#
# It also closes the gap that made this necessary: the updater failed four times
# on 2026-10-23 and nothing was filed, so "are security updates running at all"
# was answerable only by opening the Actions tab.
#
# ## The verdict rule
#
# Not "the most recent run failed". Dependabot runs several jobs concurrently —
# three at 22:52 on 2026-10-23 — so the newest row is one of a batch and a
# single red among greens is a per-ecosystem hiccup, not a dead updater.
#
# Instead: compare the newest SUCCESS against the newest FAILURE. A failure with
# no success after it means the updater is currently down. One success since
# clears it, which is also what makes the issue self-closing.
#
# ## It exits 0 even when it finds a problem
#
# The ISSUE is the signal. A non-zero exit would make this workflow red, and
# `ci-failure-issue.yml` watches it — so a Dependabot outage would file two
# issues saying the same thing. The flake-ledger probe takes the same line for
# the same reason. What a non-zero exit is reserved for is this probe being
# unable to ANSWER: a renamed workflow, an API error, an empty history.
set -euo pipefail

# The workflow name lives HERE and nowhere else: the query and the error
# message both read it, so they cannot name different things. A mutation that
# changed only the query produced an error naming the workflow it had NOT
# looked for, which is the shape that sends a reader to the wrong place.
WF_NAME="Dependabot Updates"
TITLE="Dependabot Updates has failed with no success since"
WINDOW=20
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

die() {
    echo "::error::$1"
    exit 1
}

# ── Locate the workflow BY NAME ──────────────────────────────────────────────
#
# Not by id. The id (295247577 here) is per-repository, unverifiable from this
# file, and would silently match nothing on a fork — a probe that cannot fail
# loudly when it is pointed at the wrong thing.
WF_ERR="$(mktemp)"
trap 'rm -f "$WF_ERR"' EXIT
if ! WF_LIST="$(gh api "repos/${REPO}/actions/workflows" --paginate \
    --jq ".workflows[] | select(.name == \"${WF_NAME}\") | .id" 2>"$WF_ERR")"; then
    die "could not list workflows in ${REPO}: $(tr '\n' ' ' < "$WF_ERR" | cut -c1-200)"
fi
WF_ID="$(printf '%s' "$WF_LIST" | head -1)"

if [ -z "$WF_ID" ]; then
    # Not "healthy". GitHub registers this workflow as soon as a
    # `dependabot.yml` exists, so its absence means the config is gone or the
    # name changed — either way this probe is now blind and must say so.
    die "no workflow named '${WF_NAME}' in ${REPO}. Dependabot config removed, or GitHub renamed it — this probe is blind until that is reconciled."
fi

if ! RUNS="$(gh api "repos/${REPO}/actions/workflows/${WF_ID}/runs?per_page=${WINDOW}" \
    --jq '[.workflow_runs[] | select(.status == "completed")
           | {created_at, conclusion}]' 2>"$WF_ERR")"; then
    die "could not read the run history for workflow ${WF_ID}: $(tr '\n' ' ' < "$WF_ERR" | cut -c1-200)"
fi

TOTAL="$(printf '%s' "$RUNS" | jq 'length')"
if [ "$TOTAL" = "0" ]; then
    # An empty window is not a pass. Only COMPLETED runs are counted — a
    # queued or in-progress run carries `conclusion: null`, and reading that as
    # anything is the mistake that makes a pending check look green.
    die "no COMPLETED ${WF_NAME} runs in the last ${WINDOW}. Nothing to judge, so this is unanswered rather than healthy."
fi

LAST_OK="$(printf '%s' "$RUNS" | jq -r '[.[] | select(.conclusion == "success")][0].created_at // ""')"
LAST_BAD="$(printf '%s' "$RUNS" | jq -r '[.[] | select(.conclusion != "success")][0].created_at // ""')"
FAILED_N="$(printf '%s' "$RUNS" | jq '[.[] | select(.conclusion != "success")] | length')"

echo "[dependabot-health] ${TOTAL} completed run(s) examined; ${FAILED_N} not successful"
echo "[dependabot-health] newest success: ${LAST_OK:-none in window}"
echo "[dependabot-health] newest failure: ${LAST_BAD:-none in window}"

DOWN=0
if [ -n "$LAST_BAD" ]; then
    if [ -z "$LAST_OK" ]; then
        DOWN=1   # failures only, in the whole window
    elif [[ "$LAST_BAD" > "$LAST_OK" ]]; then
        DOWN=1   # ISO-8601 UTC strings compare lexicographically
    fi
fi

if ! EXISTING="$(gh issue list --repo "$REPO" --state open --limit 50 \
    --search "\"$TITLE\" in:title" --json number --jq '.[0].number // ""' 2>"$WF_ERR")"; then
    die "could not search existing issues, so refusing to file a possible duplicate: $(tr '\n' ' ' < "$WF_ERR" | cut -c1-200)"
fi

if [ "$DOWN" = "0" ]; then
    echo "[dependabot-health] updater is healthy (a success is newer than any failure)"
    if [ -n "$EXISTING" ]; then
        gh issue close "$EXISTING" --repo "$REPO" --comment \
"The updater has succeeded since this was filed — newest success \`${LAST_OK}\`, newest failure \`${LAST_BAD:-none in window}\`. Closing automatically.

Of the last ${TOTAL} completed runs, ${FAILED_N} were not successful, so this says the updater is working NOW rather than that it never broke."
    fi
    exit 0
fi

BODY="Dependabot's updater has failed and has not succeeded since, so security and version bumps are not arriving.

- newest failure: \`${LAST_BAD}\`
- newest success: \`${LAST_OK:-none in the last ${WINDOW} completed runs}\`
- not successful: **${FAILED_N} of the last ${TOTAL}** completed runs

Run history: https://github.com/${REPO}/actions/workflows/${WF_ID}

**Why a scheduled probe reports this and not the CI-failure notifier.** A \`workflow_run\` triggered by a \`dependabot[bot]\`-actored run gets a READ-ONLY token whatever \`permissions:\` declares, so the notifier's issue-creation call answers 404 and the notifier goes red instead. Measured on 2026-10-23: the same workflow succeeded at 22:08 under a human actor, failed at 22:11 under \`dependabot[bot]\`, succeeded again at 22:15. See the comment in \`.github/workflows/ci-failure-issue.yml\` and #2230.

This issue closes itself once a run succeeds."

if [ -n "$EXISTING" ]; then
    echo "[dependabot-health] commenting on existing issue #${EXISTING}"
    gh issue comment "$EXISTING" --repo "$REPO" --body "$BODY"
else
    echo "[dependabot-health] filing a new issue"
    gh issue create --repo "$REPO" --title "$TITLE" --body "$BODY"
fi

# Deliberately 0 — see the header. The issue is the signal; a red run here would
# make `ci-failure-issue.yml` file a second one about the same outage.
exit 0
