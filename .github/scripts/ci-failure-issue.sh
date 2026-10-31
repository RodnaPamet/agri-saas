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

# Workflows whose `cancelled` conclusion carries NO information (#805).
#
# The suppression condition in the `cancelled)` branch below — "does this run
# have any job records?" — was derived from CI, where a superseded run is killed
# while still PENDING and so has none. That reasoning does not transfer to
# `Publish image to GHCR`: it is a SINGLE-job workflow whose job record exists
# within seconds of the run being created, so a supersession finds one every
# time and would be reported as a real failure. Its cancellations on 2026-09-04
# were the concurrency group working exactly as designed — filing issues for
# them is the accumulating noise #682 removed.
#
# The case a cancellation CAN hide — main's tip has no published image — is
# therefore NOT answered here. It is answered by `image-tip-check.yml`, which
# asks about STATE ("does the tip have a successful publish?") rather than
# about an event, and which this notifier watches under its own name.
#
# `failure` and `timed_out` are still reported for this workflow. Only the
# genuinely ambiguous conclusion is suppressed.
SUPERSEDED_ONLY="${SUPERSEDED_ONLY:-Publish image to GHCR}"

# ── a run whose ONLY failed jobs are known-flaky is not reported (#1472) ──
#
# Owner decision, 2026-10-09, taken with the measurement in front of them: of
# the 35 classifiable `ci-failure` issues in this notifier's 39 most recent,
# 20 — 57% — were the E2E flake and nothing else. Every one self-closed on the
# next green merge, and the cost was not the issues themselves but what they
# did to the ones that mattered: #1468 recorded a real Lint breach that was
# blocking three PRs, sat open for four hours, and was passed over twice
# because it looked exactly like the other twenty.
#
# So this is a VOLUME change and nothing else. De-dupe, the `ci-failure-run:`
# high-water mark and auto-close are all correct and are untouched — all three
# were verified against live runs on 2026-10-09 (filed 05:49 on a failure, held
# through an older success, closed by a newer one).
#
# A `|`-separated list of job BASE names. Each entry matches a job called
# exactly that, or one called `<entry> (…)` — which is how this repo names
# shards (`E2E (shard 1/2)`). Written as a prefix rule rather than a glob
# because a `case` pattern cannot carry the parentheses literally.
#
# Deliberately NOT in the `on: workflows:` key: `workflow_run` carries the RUN,
# and E2E is a JOB inside `CI`. Filtering by workflow name there would match
# nothing at all.
# The colon is deliberately absent. `${VAR:-default}` substitutes when the
# variable is unset OR EMPTY, which would make `FLAKY_JOBS=` mean "use the
# default" — so the one value a reviewer would reach for to switch this off
# would quietly switch it on. `${VAR-default}` honours an explicit empty.
FLAKY_JOBS="${FLAKY_JOBS-E2E}"

is_flaky_job() {
    local name="$1" entry
    local IFS='|'
    for entry in ${FLAKY_JOBS}; do
        [ "${name}" = "${entry}" ] && return 0
        # The literal half is quoted so `(` stays a character and only `*` is a
        # wildcard; an unquoted `E2E (shard *)` would not even parse here.
        case "${name}" in
            "${entry} ("*) return 0 ;;
        esac
    done
    return 1
}

# True only when the run has at least one failed job and EVERY failed job is in
# FLAKY_JOBS. False in every other case, INCLUDING every case where it could
# not find out — the same rule the cancel probe follows, and for the same
# reason: suppression must never be what happens when a read fails.
all_failed_jobs_are_flaky() {
    local probe count names name
    if ! probe="$("$GH" api "repos/${REPO}/actions/runs/${RUN_ID}/jobs?per_page=100" \
        --jq '[.jobs[] | select(.conclusion == "failure") | .name] | [length, join("|")] | @tsv')"; then
        echo "::error::could not read the job list for run ${RUN_ID} — cannot tell a flaky-only failure from a real one, so reporting it"
        return 1
    fi
    count="${probe%%$'\t'*}"
    names="${probe#*$'\t'}"
    if ! [ "${count}" -eq "${count}" ] 2>/dev/null; then
        echo "::error::failed-job probe returned no usable answer: '${probe}' — reporting the failure"
        return 1
    fi
    # An EMPTY set satisfies "every failed job is flaky" vacuously, and that
    # branch is silence. A run really can conclude `failure` with no failed job
    # attributed — a startup failure, or a conclusion the Jobs API has not
    # filled in yet — and that is precisely the failure nobody else reports.
    if [ "${count}" -eq 0 ]; then
        echo "run ${RUN_ID} concluded ${CONCLUSION} with no failed job in the API — reporting it rather than reading an empty list as 'only flaky'"
        return 1
    fi
    local IFS='|'
    for name in ${names}; do
        is_flaky_job "${name}" || return 1
    done
    return 0
}

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

# Filled in by the `cancelled)` branch with the measured created/executed job
# split. Empty for every other conclusion, where there is nothing to
# disambiguate.
CANCEL_ROW=""
SHAPE=""

body() {
    cat <<EOF
**${WF}** concluded \`${CONCLUSION}\`.

| | |
|---|---|
| run | [${RUN_ID}](${RUN_URL}) |
| trigger | \`${EVENT}\` |
| branch | \`${BRANCH}\` |
| commit | ${SHA} |${CANCEL_ROW}

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
        # Checked BEFORE the `EXISTING` split, so a flaky-only failure neither
        # files nor comments. Leaving the high-water mark untouched is correct:
        # the mark should track the newest failure worth reporting, and this is
        # not one, so the next green still closes whatever real failure is open.
        if all_failed_jobs_are_flaky; then
            echo "run ${RUN_ID}: every failed job is in FLAKY_JOBS (${FLAKY_JOBS}) — not reporting (#1472)"
            exit 0
        fi
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
        # The SUPPRESSION condition, derived from both real cases rather than
        # guessed: a SUPERSEDED run is killed while PENDING, so GitHub never
        # creates its job records — #680's run reports ZERO jobs. A timed-out
        # run has jobs that ran, and siblings that succeeded (17 of 18, in the
        # Coverage case).
        #
        # Counting cancelled-vs-succeeded jobs does NOT work: measured 17/1 for
        # the timeout and 16/1 for the other candidate. Job DURATION alone does
        # not work either. "Does this run have any job records?" does.
        #
        # That last sentence used to read "Did any job start?" and the code
        # used to claim to test it. It did not — see the #748 paragraph below,
        # which is the correction, not an addition.
        #
        # ── #748: `started_at` is NOT "did this job start" ──
        #
        # The probe below used to be `[.jobs[] | select(.started_at != null)]
        # | length`, described as "did any job start?". It is not that. The
        # Jobs API populates `started_at` as a PLACEHOLDER equal to
        # `created_at` the moment a job record exists, before any runner is
        # assigned — verified live on run 36889033354, whose `E2E (shard 1/2)`
        # reported `status: "queued"` with `started_at` already set, and on run
        # 35754149459, where all 21 jobs carry `started_at == created_at` and
        # `steps: []`. So the old expression answered the job COUNT, and
        # `STARTED == 0` could only ever be true for a run with no job records
        # at all. Measured over 115 cancelled `ci.yml` runs (2026-09-17 →
        # 2026-10-01): 6 had zero records and were suppressed; the other 109
        # all reported a non-null `started_at` on every job, so every one was
        # filed as `timed_out_or_cancelled` — including seven main pushes on
        # 2026-09-22 where 19 of 21 jobs never executed a single step because
        # the queue was 80 jobs deep. A queue drop and a budget kill need
        # opposite responses and arrived under one word.
        #
        # What DOES separate them is whether a job executed a STEP, which the
        # same payload carries. Measured on the two classes:
        #
        #   run 35754149459  queue drop   21 jobs · 21 started_at · 2 executed
        #   run 35246281669  budget kill  21 jobs · 21 started_at · 21 executed
        #
        # The FILING DECISION is deliberately unchanged — it still suppresses
        # only on zero job records, which is what the old probe actually tested.
        # Widening the suppression to "nothing executed" would silence a main
        # push that lost every check, which is the false negative #682 created
        # once already. This change makes the report say which of the two
        # happened; it does not change who gets reported.
        case "|${SUPERSEDED_ONLY}|" in
            *"|${WF}|"*)
                echo "cancelled ${WF}: this workflow's cancellations are ambiguous by construction — image-tip-check.yml covers the case that matters (#805)"
                exit 0
                ;;
        esac
        # This probe is the SOLE discriminator between "cancelled because it
        # was superseded" (not a failure) and "cancelled because something
        # went wrong" (very much a failure), and — since #748 — the only thing
        # that says WHICH kind of wrong. `2>/dev/null || echo 0` used to stand
        # here, which collapsed a rate limit, a 5xx and a jq error into the
        # same answer as a genuine zero — byte-identical stdout, exit 0, and
        # no issue filed for a real timeout. A control that cannot fail
        # cannot discriminate.
        # -- #2508: SKIPPED jobs are not "never started", and the payload settles --
        #
        # Two corrections, and the first is the one that was actually wrong.
        #
        # `NEVER_STARTED = CREATED - EXECUTED` counted a SKIPPED job as one
        # that never started. A path filter skips jobs on most runs, so the
        # queue-drop branch fired on a SETTLED payload. Measured on run
        # 41100129873, the budget kill #2508 was filed about, read long after
        # it concluded:
        #
        #   total 25 - executed 23 -> never_started 2  => "queue drop"   WRONG
        #
        # Both of those two are `conclusion: skipped` matrix placeholders,
        # which carry ZERO steps and so cannot execute one in either reading.
        # Excluding skipped from eligibility:
        #
        #   eligible 23 - executed 23 -> never_started 0 => "budget kill" RIGHT
        #
        # and the known queue drop is unaffected: run 35754149459 reads
        # eligible 21 - executed 2 -> never_started 19.
        #
        # The second correction is the one #2508 names: the read happens ~25s
        # after the run concludes, while GitHub is still writing step records,
        # so "not yet populated" is byte-identical to "never ran". A job that
        # has CONCLUDED, HAS steps, and reports none of them started is a
        # self-inconsistent payload - still settling. It is counted
        # separately, re-read a bounded number of times, and reported as
        # `unknown` if it does not settle. An unknown stated as unknown beats
        # a confident wrong class - `classifyProbe`'s third outcome in
        # `tests/integration/db-probe.ts`, and the same rule.
        #
        # A placeholder is told from a settling job by whether it has steps at
        # ALL: zero steps is a job that was never going to run one.
        PROBE_JQ='[ (.jobs | length),
                    ([.jobs[] | select(.conclusion != "skipped")] | length),
                    ([.jobs[] | select(.conclusion != "skipped" and ((.steps // []) | map(select(.started_at != null)) | length > 0))] | length),
                    ([.jobs[] | select(.conclusion != "skipped" and (((.steps // []) | length) > 0) and (((.steps // []) | map(select(.started_at != null)) | length) == 0))] | length) ] | @tsv'
        # `SETTLE_SLEEP` is a test seam: the suite drives this script with a
        # stubbed `gh` and must not pay three real sleeps to reach the unknown
        # branch. Defaulted, so production pays the wait.
        SETTLE_SLEEP="${SETTLE_SLEEP:-5}"
        PROBE=""
        for settle_attempt in 1 2 3; do
            # `timeout` per ATTEMPT, so one hung request cannot eat the budget
            # and leave attempts 2 and 3 unrun - `ci-retry-loop-timeout`
            # enumerates this loop and requires the cap.
            if ! PROBE="$(timeout 30 "$GH" api "repos/${REPO}/actions/runs/${RUN_ID}/jobs?per_page=100" \
                --jq "$PROBE_JQ")"; then
                PROBE=""
                break
            fi
            _settling="$(printf '%s' "$PROBE" | cut -f4)"
            case "$_settling" in
                0) break ;;
            esac
            echo "::notice::job payload still settling (${_settling} concluded job(s) report no started step) - attempt ${settle_attempt}/3"
            [ "$settle_attempt" = "3" ] || sleep "$SETTLE_SLEEP"
        done
        if [ -z "$PROBE" ]; then
            echo "::error::could not read the job list for run ${RUN_ID} — cannot tell a superseded cancel from a timeout, so refusing to stay silent"
            PROBE=""
        fi
        CREATED="$(printf '%s' "$PROBE" | cut -f1)"
        ELIGIBLE="$(printf '%s' "$PROBE" | cut -f2)"
        EXECUTED="$(printf '%s' "$PROBE" | cut -f3)"
        SETTLING="$(printf '%s' "$PROBE" | cut -f4)"
        # Both halves are validated, not just the first. A probe that returns
        # one number, or prose, must not be read as "0 created" — that is the
        # suppression branch, and a failed probe landing there is silence.
        if [ -z "$PROBE" ] \
            || ! [ "${CREATED}" -eq "${CREATED}" ] 2>/dev/null \
            || ! [ "${ELIGIBLE}" -eq "${ELIGIBLE}" ] 2>/dev/null \
            || ! [ "${SETTLING}" -eq "${SETTLING}" ] 2>/dev/null \
            || ! [ "${EXECUTED}" -eq "${EXECUTED}" ] 2>/dev/null; then
            echo "::error::job-list probe returned no usable answer: '${PROBE}'"
            echo "job-list probe failed; treating this cancellation as a real failure"
            CREATED=-1
            ELIGIBLE=-1
            EXECUTED=-1
            SETTLING=0
        fi
        if [ "${CREATED}" -eq 0 ]; then  # a genuine zero, never a failed probe
            echo "cancelled with no job record at all — superseded while pending, not a failure"
            exit 0
        fi
        NEVER_STARTED=$(( ELIGIBLE - EXECUTED ))
        if [ "${CREATED}" -lt 0 ]; then
            # No counts in the body: `-1 created` reads as data and is not.
            # An unknown shape, stated as unknown, is the honest report.
            CANCEL_ROW="
| cancel shape | unknown — the job-list probe failed, so neither a queue drop nor a budget kill can be ruled out. Read the run (#748). |"
            echo "cancelled, probe unavailable — treating as a real failure"
            SHAPE=""
        elif [ "${SETTLING}" -gt 0 ]; then
            # #2508: the payload is self-inconsistent — a job has CONCLUDED,
            # carries steps, and reports none of them started. That is GitHub
            # still writing step records, and it survived three re-reads. The
            # count would be "jobs not yet populated", which is
            # byte-identical to "jobs that never ran" — so neither class can
            # be asserted, and asserting one rules out the other BY NAME in a
            # body a human acts on.
            CANCEL_ROW="
| cancel shape | unknown — ${SETTLING} of ${ELIGIBLE} eligible jobs had concluded while reporting no started step, so the job payload was still settling after three reads. Neither a queue drop nor a budget kill can be ruled out; re-read the run and check the longest job against its \`timeout-minutes\`. |"
            echo "cancelled: payload still settling (${SETTLING} of ${ELIGIBLE}) — shape unknown"
            SHAPE=""
        elif [ "${NEVER_STARTED}" -gt 0 ]; then
            SHAPE="**queue drop** — ${NEVER_STARTED} of ${ELIGIBLE} eligible jobs never executed a step, so this is a runner-availability cancellation, NOT a \`timeout-minutes\` kill. Those jobs produced no log and no verdict (#748)."
            echo "cancelled: ${EXECUTED}/${ELIGIBLE} eligible jobs executed a step — ${NEVER_STARTED} never started (queue drop)"
        else
            SHAPE="**budget kill** — all ${ELIGIBLE} eligible jobs executed, so a step or job budget ran out. The killed job's own log names it."
            echo "cancelled: all ${ELIGIBLE} eligible jobs executed a step — budget kill"
        fi
        if [ -n "$SHAPE" ]; then
            CANCEL_ROW="
| jobs | ${CREATED} created · ${EXECUTED} executed a step · ${NEVER_STARTED} never started |
| cancel shape | ${SHAPE} |"
        fi
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
