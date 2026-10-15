#!/usr/bin/env bash
#
# Weekly: does every known-flake entry still point at an OPEN issue? (#1803)
#
# ## Why a scheduled job and not a guard
#
# `tests/guards/known-flake-ledger.test.ts` is thorough about everything it can
# see offline — the spec file exists, the title still occurs in that spec so a
# rename cannot orphan an entry, the review date is a real date. About the
# issue it can only assert `Number.isInteger(f.issue)`, because the state of a
# GitHub issue is not in the repository.
#
# That fact rots on WALL-CLOCK TIME rather than on a diff: nobody edits the
# ledger on the day someone else closes the issue it names. A per-PR test is
# the wrong trigger for it, and making one network-dependent would fail closed
# on a rate limit — which is how a guard becomes one people disable.
#
# Measured cost of not having this: four of six entries pointed at closed
# issues (#1329 x3, #1487) before #1803. An entry whose issue is closed reads
# as tracked while nothing tracks it, and it goes on excusing a CI retry on
# every run.
#
# ## What it does
#
# Reads the ledger, asks GitHub for each distinct issue's state, and
# create-or-comments ONE tracking issue naming the stale entries. De-dupe is by
# exact title over the open issues, the same mechanism `ci-failure-issue.sh`
# uses. When nothing is stale it closes that tracking issue if it is open, so
# the ledger being healthy is visible rather than merely silent.
#
# `DRY_RUN=1` prints the verdict and files nothing — which is how this script
# was tested before it ever ran in CI, including against a deliberately stale
# ledger.
set -euo pipefail

LEDGER="${LEDGER:-tests/e2e/known-flakes.json}"
TITLE="Flake ledger: an entry points at a closed issue"
DRY_RUN="${DRY_RUN:-0}"

if [[ ! -f "$LEDGER" ]]; then
    # A renamed ledger must FAIL, not report a clean bill of health over a file
    # that is not there — the empty-population trap this repo keeps meeting.
    echo "::error::ledger not found at $LEDGER — a rename would make this probe pass over nothing"
    exit 1
fi

mapfile -t ISSUES < <(jq -r '(.flakes // .) | .[].issue' "$LEDGER" | sort -un)
if [[ ${#ISSUES[@]} -eq 0 ]]; then
    echo "::error::no issue numbers parsed from $LEDGER — the shape changed, or the file is empty"
    exit 1
fi
echo "Ledger entries reference ${#ISSUES[@]} distinct issue(s): ${ISSUES[*]}"

STALE=""
for N in "${ISSUES[@]}"; do
    STATE=$(gh issue view "$N" --json state --jq .state 2>/dev/null || echo "UNKNOWN")
    echo "  #$N -> $STATE"
    if [[ "$STATE" == "CLOSED" ]]; then
        # Every entry naming it, so the report is actionable without opening
        # the ledger.
        while IFS= read -r line; do
            STALE+="| #$N | $line |"$'\n'
        done < <(jq -r --argjson n "$N" '(.flakes // .) | .[] | select(.issue == $n) | "`\(.spec)` | \(.title)"' "$LEDGER")
    elif [[ "$STATE" == "UNKNOWN" ]]; then
        # A lookup failure is NOT a pass. Say so and fail the run rather than
        # reporting a clean ledger we did not actually verify.
        echo "::error::could not read the state of #$N — treating as unverified rather than fine"
        exit 1
    fi
done

EXISTING=$(gh issue list --state open --search "\"$TITLE\" in:title" --json number,title \
    --jq ".[] | select(.title == \"$TITLE\") | .number" | head -1)

if [[ -z "$STALE" ]]; then
    echo "Every ledger entry points at an open issue."
    if [[ -n "$EXISTING" ]]; then
        if [[ "$DRY_RUN" == "1" ]]; then
            echo "DRY RUN: would close #$EXISTING (ledger is healthy again)"
        else
            gh issue close "$EXISTING" --comment \
                "Every ledger entry points at an open issue again, as of $(date -u +%Y-%m-%d). Closing; this reopens itself the next time a pointer goes stale."
        fi
    fi
    exit 0
fi

BODY=$(cat <<EOF
These \`tests/e2e/known-flakes.json\` entries name an issue that is CLOSED, as of $(date -u +%Y-%m-%d).

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

if [[ "$DRY_RUN" == "1" ]]; then
    echo "DRY RUN: would ${EXISTING:+comment on #$EXISTING}${EXISTING:-create an issue} with:"
    echo "$BODY"
    exit 0
fi

if [[ -n "$EXISTING" ]]; then
    gh issue comment "$EXISTING" --body "$BODY"
    echo "Commented on #$EXISTING"
else
    gh issue create --title "$TITLE" --body "$BODY"
fi
