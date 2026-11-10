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

# ── a green run cannot close an issue about a FIXED subject (#2884) ──
#
# The close path asks "is this workflow green now". For most watched workflows
# that re-establishes the assertion the failure broke, because the SUBJECT
# moves: `Image tip check` asks about main's tip, `Restore Test` about whether
# a restore works today, `Basemap Provenance` about the deployed build. A later
# green genuinely answers the same question again. #2580 and #2641 both went
# away on the next green run and both were RIGHT to.
#
# `Release` is not like that. Its artefacts are keyed to a TAG, which never
# moves. On 2026-11-08 four Release runs published tags with no SBOM — the
# Syft checksum download failed to connect, `status=000`, with no retry — and
# the notifier filed #2871, #2872, #2877 and #2882. Every one went away on the
# next green Release, which produced a DIFFERENT tag's SBOM and repaired
# nothing. #2882 existed for 27 minutes and was the only record that
# `v12.152.0` had none. Backfilling it was manual, had been done by hand twice
# before, and the pattern was invisible both times because each look started
# from scratch.
#
# So: for these workflows a green run COMMENTS and leaves the issue open. The
# reader has to confirm the earlier subject was repaired, because nothing else
# can.
#
# `${VAR-default}` and not `${VAR:-default}`, for the reason FLAKY_JOBS gives
# below: the latter makes an explicit empty value mean "use the default", so
# the one setting a reviewer would reach for to switch this off would quietly
# switch it on.
FIXED_SUBJECT_WORKFLOWS="${FIXED_SUBJECT_WORKFLOWS-Release}"

is_fixed_subject() {
    local name="$1" entry
    local IFS='|'
    for entry in $FIXED_SUBJECT_WORKFLOWS; do
        [ -n "$entry" ] || continue
        [ "$name" = "$entry" ] && return 0
    done
    return 1
}

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

# ── what failed, recorded so a retired issue still says it (#2714) ──
#
# The body used to carry run / trigger / branch / commit and a link, and
# nothing about the failure itself. Once a run's logs age out, a retired issue
# holds NO cause — which is how #2712 and #2746 each left nothing behind, and
# why a second occurrence read as a first.
#
# The names come from the same call `all_failed_jobs_are_flaky` already makes,
# cached so the failure path does not ask twice. An unreadable probe yields the
# empty string and the row is omitted: a body that says nothing is the status
# quo, while a body asserting "none" would be a claim this cannot support.
FAILED_JOBS_CACHE=""
FAILED_JOBS_READ=""

failed_job_names() {
    if [ -z "$FAILED_JOBS_READ" ]; then
        FAILED_JOBS_READ=1
        # shell-check-ok: this is a DIAGNOSTIC read, not a check. The script
        # runs under `set -euo pipefail`, so without the `|| true` an
        # unreachable API would abort the notifier — and the notifier failing
        # is strictly worse than a body missing one row, because then nothing
        # reports the CI failure at all. An empty value is handled: the caller
        # omits the row rather than writing "none", which would be a claim
        # this cannot support.
        FAILED_JOBS_CACHE="$("$GH" api "repos/${REPO}/actions/runs/${RUN_ID}/jobs?per_page=100" \
            --jq '[.jobs[] | select(.conclusion == "failure") | .name] | join(", ")' 2>/dev/null || true)"
    fi
    printf '%s' "$FAILED_JOBS_CACHE"
}

find_issue() {
    # OPEN first, then CLOSED — #2714.
    #
    # Searching open only made the body's own promise false the moment the
    # issue was retired: "Repeat failures arrive as comments here rather than
    # as new issues - many comments means the problem is persistent, not new"
    # holds while it is open, and after a self-close the next occurrence filed
    # a FRESH issue with the comment count back at zero. A flake that had
    # recurred five times read as five unrelated one-offs.
    #
    # Open is preferred so the ordinary path is unchanged and costs one call.
    local n
    n="$(find_open_issue)"
    if [ -n "$n" ]; then printf '%s' "$n"; return 0; fi
    "$GH" issue list --repo "$REPO" --label ci-failure --state closed --limit 100 \
        --json number,title \
        --jq "[.[] | select(.title == \"${TITLE}\")] | .[0].number // empty"
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
# Set on the failure path only, where `failed_job_names` has something to say.
FAILED_ROW=""

body() {
    cat <<EOF
**${WF}** concluded \`${CONCLUSION}\`.

| | |
|---|---|
| run | [${RUN_ID}](${RUN_URL}) |
| trigger | \`${EVENT}\` |
| branch | \`${BRANCH}\` |
| commit | ${SHA} |${FAILED_ROW}${CANCEL_ROW}

This trigger has no PR page, so nothing else would have said so.

This issue closes itself on the next green run of the same workflow that is
NEWER than the failure above. Repeat failures arrive as comments here rather
than as new issues — many comments means the problem is persistent, not new.

${MARKER_PREFIX} ${RUN_ID} -->
EOF
}

EXISTING="$(find_issue)"

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
        if is_fixed_subject "$WF"; then
            # Green again, and that says nothing about the subject the earlier
            # failure broke — see FIXED_SUBJECT_WORKFLOWS. Comment and LEAVE
            # OPEN.
            "$GH" issue comment "$EXISTING" --repo "$REPO" --body \
                "✅ **${WF}** is green again — [run ${RUN_ID}](${RUN_URL}) on \`${BRANCH}\` (${SHA}).

**Left open deliberately.** This workflow's artefacts are keyed to a tag, which does not move, so a later green run produces a DIFFERENT tag's artefact and repairs nothing for the one that failed. Confirm the failed run's own tag carries what it should — \`gh release view <tag> --json assets\` — and close this by hand once it does. See #2884."
            echo "left #${EXISTING} open: ${WF} is green but its subject is FIXED (#2884)"
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
        # Named in the body from here on (#2714). Set AFTER the flaky gate so a
        # suppressed run costs no extra API call.
        FAILED_NAMES="$(failed_job_names)"
        [ -n "$FAILED_NAMES" ] && FAILED_ROW="
| failed jobs | \`${FAILED_NAMES}\` |"
        if [ -n "$EXISTING" ]; then
            # A match may be RETIRED — `find_issue` looks at closed issues too.
            # Reopening keeps one issue per workflow accumulating its history,
            # which is what makes a second occurrence legible.
            #
            # ACCEPTED COST, stated rather than hidden: on an intermittently
            # failing workflow the issue now FLAPS — a green retires it, the
            # next failure reopens it. That is noisier than before, and it is
            # the point: each flap leaves a comment, so the count answers "has
            # this happened before" instead of resetting. `gh issue reopen` on
            # an already-open issue is a no-op, so this needs no state check.
            # shell-check-ok: reopening is best-effort for the same reason.
            # It fails when the issue is already open — the ordinary path, and
            # a no-op — and under `set -e` that would abort before the comment
            # below, losing the failure report to tidy bookkeeping. The comment
            # is the record; the reopen only makes it findable.
            "$GH" issue reopen "$EXISTING" --repo "$REPO" >/dev/null 2>&1 || true
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
            #
            # That claim was FALSE when written and is true since #2576: the
            # guardrail scanned only workflows and actions, and its pattern
            # wanted a counter named exactly `attempt`, so `settle_attempt` in
            # a script missed on both counts. Removing this `timeout` left it
            # 19/19 green. Both are fixed; the cap is now policed by
            # population, and `ci-failure-notifier` pins the break-on-settled
            # behaviour the population guard cannot see.
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
