#!/usr/bin/env bash
#
# Weekly: the TWO facts in the known-flake ledger that rot on wall-clock time.
#
#   1. does every entry still point at an OPEN issue?        (#1803)
#   2. has any entry reached its REVIEW DATE?                (#2966)
#
# ## Why a scheduled job and not a guard
#
# `tests/guards/known-flake-ledger.test.ts` is thorough about everything it can
# see offline — the spec file exists, the title still occurs in that spec so a
# rename cannot orphan an entry, the review date is a real date. It cannot
# reach either fact above: the state of a GitHub issue is not in the
# repository, and whether a date has PASSED is not a property of the diff.
#
# Both rot on WALL-CLOCK TIME rather than on a change: nobody edits the ledger
# on the day someone else closes the issue it names, and nobody edits it on the
# day a review date arrives. A per-PR test is the wrong trigger for either, and
# making one network-dependent would fail closed on a rate limit — which is how
# a guard becomes one people disable.
#
# Measured cost of not having check 1: four of six entries pointed at closed
# issues (#1329 x3, #1487) before #1803. An entry whose issue is closed reads
# as tracked while nothing tracks it, and it goes on excusing a CI retry on
# every run.
#
# Check 2 was added because the ledger already carried the dates and nothing
# read them. Three of the four entries name 2026-11-18, set deliberately
# nearer than the usual horizon because each records a fix that shipped and an
# explanation its own text calls spent — exactly the entries where an unread
# date means the excuse outlives the argument for it.
#
# ## What it does
#
# Reads the ledger once and runs both checks, filing ONE tracking issue PER
# CHECK. They are separate issues on purpose: the two findings are different
# human decisions with different remedies, and each self-closes independently,
# so a stale pointer cannot hold a resolved review report open. De-dupe is by
# exact title over the open issues, the same mechanism `ci-failure-issue.sh`
# uses. When a check finds nothing it closes its own issue if open, so the
# ledger being healthy is visible rather than merely silent.
#
# `DRY_RUN=1` prints both verdicts and files nothing — which is how this script
# was tested before it ever ran in CI, including against a deliberately stale
# ledger. `TODAY=YYYY-MM-DD` overrides the clock for check 2, so a test can
# reach a date the repo has not.
set -euo pipefail

LEDGER="${LEDGER:-tests/e2e/known-flakes.json}"
POINTER_TITLE="Flake ledger: an entry points at a closed issue"
REVIEW_TITLE="Flake ledger: an entry is due for review"
DRY_RUN="${DRY_RUN:-0}"
# Indirected so a test can stub it, the `ci-failure-issue.sh` convention.
# PATH games work too and are worse: they also shadow `gh` for anything else
# the script shells out to, and they leave the stub reachable after the test.
GH="${GH:-gh}"
# Overridable so a test can reach a date the repo has not. Not a convenience:
# every review date in the ledger is in the future on the day it is written, so
# without this the due branch is unreachable and only the empty one is ever
# executed — a control that cannot express the failing input.
TODAY="${TODAY:-$(date -u +%Y-%m-%d)}"

if [[ ! -f "$LEDGER" ]]; then
    # A renamed ledger must FAIL, not report a clean bill of health over a file
    # that is not there — the empty-population trap this repo keeps meeting.
    echo "::error::ledger not found at $LEDGER — a rename would make this probe pass over nothing"
    exit 1
fi

# ── one filing mechanism, two questions ──────────────────────────────────────
#
# Create, comment, or close ONE tracking issue. Called once per check with its
# own title, so each self-closes on its own axis. A single shared issue would
# be half-resolved whenever one check cleared and the other did not, and the
# close would then assert something untrue about the other.
file_or_close() {
    local title="$1" findings="$2" body="$3" healthy="$4" existing

    # `--limit 50` + an exact-title filter rather than `| head -1`: under
    # `pipefail` a closing pipe can SIGPIPE `gh`, and a failed lookup silently
    # becoming "no existing issue" would file a duplicate every week instead of
    # commenting on one.
    existing="$("$GH" issue list --state open --limit 50 --search "\"$title\" in:title" --json number,title \
        --jq "[.[] | select(.title == \"$title\") | .number] | first // empty")" || {
        echo "::error::could not list open issues — refusing to guess whether \"$title\" already exists"
        return 1
    }

    if [[ -z "$findings" ]]; then
        echo "  nothing to report: $title"
        if [[ -n "$existing" ]]; then
            if [[ "$DRY_RUN" == "1" ]]; then
                echo "  DRY RUN: would close #$existing"
            else
                "$GH" issue close "$existing" --comment "$healthy"
                echo "  closed #$existing"
            fi
        fi
        return 0
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
        # Spelled out rather than `${existing:+…}${existing:-…}`, which was the
        # original line and printed `#42424242`: `:-` substitutes the VALUE when
        # the variable IS set, so both expansions fire and the number doubles.
        # Dry-run output only, which is exactly why it survived — a hand-test
        # reads it and the eye corrects it.
        if [[ -n "$existing" ]]; then
            echo "  DRY RUN: would comment on #$existing (\"$title\") with:"
        else
            echo "  DRY RUN: would create \"$title\" with:"
        fi
        echo "$body"
        return 0
    fi

    if [[ -n "$existing" ]]; then
        "$GH" issue comment "$existing" --body "$body"
        echo "  commented on #$existing"
    else
        "$GH" issue create --title "$title" --body "$body"
    fi
}

# ── check 1: does every entry point at an OPEN issue? ────────────────────────

mapfile -t ISSUES < <(jq -r '(.flakes // .) | .[].issue' "$LEDGER" | sort -un)
if [[ ${#ISSUES[@]} -eq 0 ]]; then
    echo "::error::no issue numbers parsed from $LEDGER — the shape changed, or the file is empty"
    exit 1
fi
echo "[flake-ledger] ${#ISSUES[@]} distinct issue(s) referenced: ${ISSUES[*]}"

STALE=""
for N in "${ISSUES[@]}"; do
    # The failure is HANDLED, not swallowed. `… || echo UNKNOWN` would bury a
    # rate limit, an auth failure and a deleted issue in one bucket, and
    # `shell-checks-that-cannot-fail` bans that shape for exactly this reason —
    # it caught this script's first version. A lookup we could not perform is
    # NOT a pass: the whole value of this probe is noticing an absence.
    STATE="$("$GH" issue view "$N" --json state --jq .state 2>/dev/null)" || {
        echo "::error::could not read the state of #$N — unverified, which is not the same as fine"
        exit 1
    }
    if [[ -z "$STATE" ]]; then
        echo "::error::empty state for #$N — the lookup succeeded and said nothing, which is worse"
        exit 1
    fi
    echo "  #$N -> $STATE"
    if [[ "$STATE" == "CLOSED" ]]; then
        # Every entry naming it, so the report is actionable without opening
        # the ledger.
        while IFS= read -r line; do
            STALE+="| #$N | $line |"$'\n'
        done < <(jq -r --argjson n "$N" '(.flakes // .) | .[] | select(.issue == $n) | "`\(.spec)` | \(.title)"' "$LEDGER")
    fi
done

POINTER_BODY=$(cat <<EOF
These \`tests/e2e/known-flakes.json\` entries name an issue that is CLOSED, as of $TODAY.

| issue | spec | title |
|---|---|---|
$STALE

An entry whose issue is closed reads as TRACKED while nothing tracks it, and it goes on excusing a CI retry on every run. That is the failure this ledger exists to prevent — its own comment says every entry carries an issue "rather than just a name" precisely so an excuse keeps an owner.

Per entry, one of:

- **Prune it** if the cause really was fixed and the entry's own reason says the explanation is spent.
- **Re-point it** at a live issue if the flake still fires — the fix may have been real and incomplete, which is what #1862 records for one family.

Checked weekly by \`.github/workflows/flake-ledger-pointers.yml\`. This issue closes itself when every pointer is live again.
EOF
)

file_or_close "$POINTER_TITLE" "$STALE" "$POINTER_BODY" \
    "Every ledger entry points at an open issue again, as of $TODAY. Closing; this reopens itself the next time a pointer goes stale."

# ── check 2: has any entry reached its REVIEW DATE? ──────────────────────────
#
# The ledger cannot assert a flake has STOPPED — absence is not observable from
# one run, and its own comment says so — so it records a date by which a human
# should look instead. Nothing read those dates until this check existed.

# The separator is US (U+001F), NOT a tab. `read` treats tab as IFS
# WHITESPACE and collapses runs of it, so an entry with no `review` lost its
# empty field and the spec slid into the date — the missing-field branch then
# reported "unparseable date 'entity-detail-layout.spec.ts'" and the real
# finding was invisible behind a wrong one. Found by testing the refusal.
mapfile -t ENTRIES < <(jq -r '(.flakes // .) | .[] | "\(.issue)\u001f\(.review // "")\u001f\(.spec)\u001f\(.title)"' "$LEDGER")
if [[ ${#ENTRIES[@]} -eq 0 ]]; then
    # Separate from check 1's refusal on purpose: `.issue` parsing fine says
    # nothing about `.review` parsing fine, and a clean bill of health over an
    # unread field is the thing this check is for.
    echo "::error::no entries parsed for the review check from $LEDGER — the shape changed, or the file is empty"
    exit 1
fi

# `date -d`'s EXIT CODE cannot validate a date and is not used for it.
# Measured on this runner: `date -u -d wat +%s` prints 1794265200 and exits 0,
# while `date -u -d not-a-date` fails — it accepts some garbage and rejects
# other garbage, so a non-zero exit from it is no evidence either way.
#
# A ROUND TRIP can. `date` is asked to re-emit the value in the canonical
# `%Y-%m-%d` spelling and the result must be byte-identical to the input, so
# anything `date` had to interpret, normalise or invent fails.
#
# This was written as a format REGEX plus the round trip, and a mutation
# removed the regex with all 19 tests still green. Measured why, over every
# bad value the suite carries:
#
#   value        regex    round trip
#   wat          REJECT   REJECT
#   not-a-date   REJECT   REJECT
#   2026-1-5     REJECT   REJECT
#   2026-13-45   accept   REJECT      <- regex is blind
#   2026-02-30   accept   REJECT      <- regex is blind
#
# The round trip rejects everything the regex rejected and two things it did
# not, so the regex was strictly weaker and carried nothing. It is gone rather
# than kept as belt-and-braces: a protection no mutation can kill is one the
# next reader trusts for a guarantee it does not provide.
require_iso_date() {
    [[ "$(date -u -d "$1" +%Y-%m-%d 2>/dev/null)" == "$1" ]]
}

require_iso_date "$TODAY" || {
    echo "::error::TODAY='$TODAY' is not a YYYY-MM-DD date"
    exit 1
}
TODAY_EPOCH="$(date -u -d "$TODAY" +%s)"

DUE=""
DUE_COUNT=0
for ENTRY in "${ENTRIES[@]}"; do
    IFS=$'\x1f' read -r N REVIEW SPEC SPEC_TITLE <<<"$ENTRY"
    if [[ -z "$REVIEW" ]]; then
        # Skipping it would report a clean bill over a smaller population. The
        # offline guard requires the field, so reaching this means the ledger
        # changed shape and this check is reading the wrong thing.
        echo "::error::entry #$N ($SPEC) carries no review date — refusing to report on a population I cannot read"
        exit 1
    fi
    require_iso_date "$REVIEW" || {
        echo "::error::entry #$N carries '$REVIEW', which is not a YYYY-MM-DD date"
        exit 1
    }
    REVIEW_EPOCH="$(date -u -d "$REVIEW" +%s)"
    DAYS=$(( (TODAY_EPOCH - REVIEW_EPOCH) / 86400 ))
    if (( TODAY_EPOCH >= REVIEW_EPOCH )); then
        DUE_COUNT=$(( DUE_COUNT + 1 ))
        DUE+="| #$N | $REVIEW | $DAYS | \`$SPEC\` | $SPEC_TITLE |"$'\n'
        echo "  #$N review $REVIEW -> DUE ($DAYS day(s))"
    else
        echo "  #$N review $REVIEW -> $(( -DAYS )) day(s) away"
    fi
done
echo "[flake-ledger] ${#ENTRIES[@]} ledgered; $DUE_COUNT due for review as of $TODAY"

REVIEW_BODY=$(cat <<EOF
These \`tests/e2e/known-flakes.json\` entries have reached the review date they set themselves, as of $TODAY.

| issue | review | days past | spec | title |
|---|---|---|---|---|
$DUE

A review date is the ledger's own admission that an entry's explanation has a shelf life. \`tests/guards/known-flake-ledger.test.ts\` asserts the date is a real date and deliberately does NOT assert the flake has stopped — absence is not observable from one run — so arriving at the date is a decision for a person, which is why nothing reported it until #2966.

Per entry, one of:

- **Prune it** if the flake has not fired since. Read CI's own \`::notice\` annotations rather than inferring from silence — at the rate these entries record, roughly 1 run in 13, a dozen clean runs is about P=0.4 of seeing nothing from a flake that has not stopped. Silence is not evidence here.
- **Push the date out WITH a new measurement.** A date moved and a reason left alone is the entry excusing itself; two of these entries already record a shipped fix they SURVIVED, so "the fix is in" is not a reason on its own.
- **Re-point it** if the cause now belongs to a different issue.

Checked weekly by \`.github/workflows/flake-ledger-pointers.yml\`. This issue closes itself when no entry is past its review date.
EOF
)

file_or_close "$REVIEW_TITLE" "$DUE" "$REVIEW_BODY" \
    "No ledger entry is past its review date, as of $TODAY. Closing; this reopens itself when the next date arrives."
