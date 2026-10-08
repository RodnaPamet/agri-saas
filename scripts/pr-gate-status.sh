#!/usr/bin/env bash
# Score a PR against the REQUIRED contexts, read from the gate itself.
#
# Both readings I used today were wrong in opposite directions. `ok/pend` from
# the rollup divides by what has REGISTERED, so absent checks vanish from the
# denominator and the PR looks closer to green than it is. Diffing against a
# merged sibling's rollup divides by what RAN there — 26 checks, 17 of them
# shard children that feed the aggregates — so it double-counts and the PR
# looks further away than it is.
#
# Only branch protection says what must PASS. Note the endpoint has to be
# called ALONE: chaining it after `gh api .../rules/branches/main` is how I
# missed it, because that returns `[]` and a `-q` filter over `[]` prints
# nothing and exits 0, so an `||` fallback never fires.
#
# ## Exit codes, and why "cannot read the gate" needs its own
#
#   0  every required context passes
#   1  outstanding — something has not finished
#   2  a required context is RED
#   3  the gate could not be READ, so this script has no answer
#
# 3 exists because of a positive control that caught the first version: with an
# unreadable repository the script exited 1, which is also "checks still
# pending", and it never reached its own refusal message because `gh api` died
# under `set -e` first. A caller — the CI monitor this feeds — reads 1 as "keep
# waiting", so a broken probe would have produced `outstanding` for ever
# instead of saying the instrument failed. A failed probe means UNKNOWN, never
# a state of the thing being probed.
set -uo pipefail
PR="${1:?usage: pr-gate-status.sh <pr-number>}"
REPO="${REPO:-RodnaPamet/agri-saas}"

# Not under `set -e`, and captured rather than piped, so a gh failure reaches
# the explicit check below instead of killing the script with whatever exit
# code gh chose.
PROTECTION=$(gh api "repos/$REPO/branches/main/protection" \
    -q '.required_status_checks.contexts[]' 2>/dev/null) || PROTECTION=""
mapfile -t REQUIRED <<<"$PROTECTION"
# An empty first element is what `mapfile` gives for empty input.
if [ "${#REQUIRED[@]}" -eq 0 ] || [ -z "${REQUIRED[0]}" ]; then
    echo "#$PR  GATE UNREADABLE — cannot list the required contexts for $REPO."
    echo "  Refusing to guess. Do NOT fall back to the rollup: its length is what"
    echo "  has registered, not what must pass."
    exit 3
fi

ROLLUP=$(gh pr view "$PR" --repo "$REPO" --json mergeable,mergeStateStatus,statusCheckRollup)
echo "#$PR  $(jq -r '"\(.mergeable)/\(.mergeStateStatus)"' <<<"$ROLLUP")"

green=0; bad=0; waiting=0
for ctx in "${REQUIRED[@]}"; do
    row=$(jq -r --arg c "$ctx" '[.statusCheckRollup[]? | select((.name // .context)==$c)][0] // empty' <<<"$ROLLUP")
    if [ -z "$row" ]; then
        # ABSENT is not pending and not green. Every aggregate scores absence
        # as neither, which is how a PR reads "nearly green" with a third of
        # its gate not yet registered.
        printf '  %-38s ABSENT\n' "$ctx"; waiting=$((waiting+1)); continue
    fi
    st=$(jq -r '.status // "-"' <<<"$row"); cc=$(jq -r '.conclusion // "-"' <<<"$row")
    case "$cc" in
        SUCCESS|SKIPPED) printf '  %-38s %s\n' "$ctx" "$cc"; green=$((green+1));;
        FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED) printf '  %-38s %s  <-- RED\n' "$ctx" "$cc"; bad=$((bad+1));;
        *) printf '  %-38s %s\n' "$ctx" "$st"; waiting=$((waiting+1));;
    esac
done
echo "  ── ${green}/${#REQUIRED[@]} required passing · ${waiting} outstanding · ${bad} red"
[ "$bad" -gt 0 ] && exit 2
[ "$waiting" -gt 0 ] && exit 1
exit 0
