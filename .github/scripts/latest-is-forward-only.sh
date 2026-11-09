#!/usr/bin/env bash
#
# May this build move `:latest`? (#2901)
#
# ── What went wrong ──
#
# On 2026-11-09 two publishes overlapped and finished OUT OF ORDER:
#
#     b92bd5032 (#2897, NEWER commit)  started 01:38:32  ended 01:50:06
#     f56915555 (#2896, OLDER commit)  started 01:39:30  ended 01:59:54
#
# Both succeeded. The older one finished nine minutes later and overwrote
# `:latest` with its own image, so production ran the older commit while the
# newer commit's `sha-` tag sat correct and unused. `image-tip-check` caught it
# — "main's tip is published but :latest points elsewhere" — which is the only
# reason anybody knew.
#
# The cause is structural rather than a fluke. Since #877 the publish
# concurrency group QUEUES instead of cancelling, which fixed starvation; but
# queueing orders STARTS, not COMPLETIONS, and nothing made `:latest` monotonic.
#
# ── Why ancestry and not timestamps ──
#
# The obvious comparison is build time, and it gives exactly the wrong answer
# here: the OLDER commit's build STARTED later, so its image carries the LATER
# `org.opencontainers.image.created`. Time orders the builds; only the commit
# graph orders the code. So this asks whether the commit `:latest` currently
# serves is an ANCESTOR of the one being published.
#
# ── Failing safe means SKIPPING ──
#
# When the decision cannot be made — the label is unreadable, the served commit
# is not in the clone — this skips `:latest` rather than pushing it. The two
# failures are not symmetric:
#
#   · skip wrongly  -> `:latest` is stale, and `image-tip-check` says so within
#                      minutes, on every publish and daily. Loud.
#   · push wrongly  -> production silently runs older code. That is the defect
#                      this script exists to prevent, and it is invisible.
#
# Usage: REF=ghcr.io/owner/name THIS_SHA=<40-hex> ./latest-is-forward-only.sh
#   Prints `LATEST_DECISION=push` or `LATEST_DECISION=skip <reason>`.
#   Always exits 0: a refusal is a decision, not a broken workflow.
#
set -euo pipefail

REF="${REF:?REF is required, e.g. ghcr.io/rodnapamet/agri-saas}"
THIS_SHA="${THIS_SHA:?THIS_SHA is required, the 40-hex commit being published}"
DOCKER="${DOCKER:-docker}"
GIT="${GIT:-git}"

decide() { echo "LATEST_DECISION=$1 ${2:-}"; exit 0; }

# The commit `:latest` currently serves, from the OCI label `metadata-action`
# writes. Read from the REGISTRY rather than a local image: the runner's daemon
# may hold a stale copy, and the question is about what the registry serves.
#
# stderr is NOT suppressed here, deliberately: this branch INTERPRETS the
# result, and `2>/dev/null` would make "the registry refused" and "the image
# carries no label" the same observation — in a log where the difference is the
# only thing that explains a skip. `shell-checks-that-cannot-fail` flags the
# suppressed form by name. The `if` still catches a non-zero exit; the error
# simply arrives where somebody can read it.
SERVED=""
if RAW="$("$DOCKER" buildx imagetools inspect "${REF}:latest" --format '{{ json .Image }}')"; then
    SERVED="$(printf '%s' "$RAW" \
        | tr ',' '\n' \
        | grep -o '"org.opencontainers.image.revision":"[0-9a-f]\{40\}"' \
        | head -1 | grep -o '[0-9a-f]\{40\}' || true)"
fi

# No `:latest` at all is the FIRST publish — there is nothing to regress.
if [ -z "$SERVED" ]; then
    if "$DOCKER" buildx imagetools inspect "${REF}:latest" >/dev/null 2>&1; then
        decide skip "the served :latest carries no revision label, so ordering cannot be established"
    fi
    decide push "no :latest is served yet — first publish"
fi

if [ "$SERVED" = "$THIS_SHA" ]; then
    decide push "re-publishing the commit :latest already serves"
fi

# `--is-ancestor` exits non-zero for an UNKNOWN object exactly as it does for
# "not an ancestor", so the object has to be proven present first. Without this
# a shallow clone would report every served commit as not-an-ancestor and the
# answer would look decisive while meaning "I could not see".
if ! "$GIT" cat-file -e "${SERVED}^{commit}" 2>/dev/null; then
    decide skip "the served commit ${SERVED:0:9} is not in this clone — needs fetch-depth: 0"
fi

if "$GIT" merge-base --is-ancestor "$SERVED" "$THIS_SHA"; then
    decide push "${SERVED:0:9} is an ancestor of ${THIS_SHA:0:9}"
fi

decide skip "the served ${SERVED:0:9} is NOT an ancestor of ${THIS_SHA:0:9} — this build is older or unrelated"
