#!/usr/bin/env bash
#
# Does main's tip have a published image?
#
# ── Why this asks about STATE, not about an event (#805, #826) ──
#
# `Publish image to GHCR` QUEUES rather than cancels since #877 — it
# carries `cancel-in-progress: false`, so a burst supersedes runs that are
# still PENDING while the executing one finishes. Cancellations therefore
# still happen, and GitHub reports a superseded run and a run killed by its
# own `timeout-minutes` with the same word — `cancelled` — and on
# 2026-09-08 run 34208631386 was the second kind.
#
# That run had, in fact, pushed successfully 13 minutes before it was
# killed. Two readers looked at the same run list and reached opposite
# conclusions; settling it took a manual read of 1630 lines of buildx
# output. An event-keyed alert cannot do better, because the event is
# genuinely ambiguous. This one ignores runs entirely and asks the
# registry what it is serving.
#
# ── Failing safe ──
#
# The dangerous failure here is reporting "the tip has no image" when the
# probe simply could not see. So the CONTROL runs first: the registry must
# serve a digest for `:latest` before any conclusion is drawn about the
# tip's tag. If the control fails, this exits non-zero with a message
# saying the check could not run — never with "the image is missing".
#
# Usage: REPO=owner/name TIP_SHA=<40-hex> ./image-tip-check.sh
#   Requires: docker, already logged in to ghcr.io.
#
set -euo pipefail

REPO="${REPO:?REPO is required, e.g. RodnaPamet/agri-saas}"
TIP_SHA="${TIP_SHA:?TIP_SHA is required (40-hex commit sha)}"
REGISTRY="${REGISTRY:-ghcr.io}"

# `docker/metadata-action` emits `type=sha,prefix=sha-,format=short`, which
# is the first 7 characters. Derived here rather than passed in, so a change
# to the tag scheme breaks this loudly instead of silently checking a tag
# that never existed.
SHORT="${TIP_SHA:0:7}"
REF="${REGISTRY}/$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')"
TIP_TAG="${REF}:sha-${SHORT}"

digest_of() {
    # Prints the manifest digest, or nothing if the tag does not resolve.
    docker buildx imagetools inspect "$1" --format '{{println .Manifest.Digest}}' 2>/dev/null \
        | head -1 | tr -d '[:space:]'
}

# ── CONTROL: can this probe see the registry at all? ──
LATEST_DIGEST="$(digest_of "${REF}:latest" || true)"
if [ -z "$LATEST_DIGEST" ]; then
    echo "::error::CONTROL FAILED — ${REF}:latest did not resolve, so this check could not run."
    echo "This is NOT a report that the tip is unpublished. Distinguish the two:"
    echo "  · a registry/auth failure means the probe is blind;"
    echo "  · a missing tip tag means the publish did not land."
    echo "Check credentials (packages: read) and ghcr.io availability, then re-run."
    exit 1
fi
echo "control ok — ${REF}:latest serves ${LATEST_DIGEST}"

# ── THE QUESTION ──
TIP_DIGEST="$(digest_of "$TIP_TAG" || true)"
if [ -z "$TIP_DIGEST" ]; then
    echo "::error::main's tip ${SHORT} has NO published image."
    echo "  expected tag : ${TIP_TAG}"
    echo "  :latest      : ${LATEST_DIGEST} (a DIFFERENT, older build)"
    echo ""
    echo "Watchtower polls :latest, so production is running whatever that"
    echo "digest is — not ${SHORT}. Re-run 'Publish image to GHCR' for this"
    echo "commit, or push a new commit to main."
    exit 1
fi

echo "tip tag ${TIP_TAG} serves ${TIP_DIGEST}"

# ── The tip is published. Is it what :latest points at? ──
# Watchtower pulls :latest, so a tip that is published but NOT latest is
# still a stale production — a distinct failure from "never published",
# and one a tag-existence check alone would miss.
if [ "$TIP_DIGEST" != "$LATEST_DIGEST" ]; then
    echo "::error::main's tip is published but :latest points elsewhere."
    echo "  tip ${SHORT} : ${TIP_DIGEST}"
    echo "  :latest      : ${LATEST_DIGEST}"
    echo "Watchtower deploys :latest, so production is NOT running the tip."
    exit 1
fi

echo "✓ main's tip ${SHORT} is published and is what :latest serves (${TIP_DIGEST})"
