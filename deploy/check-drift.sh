#!/usr/bin/env bash
#
# deploy/check-drift.sh — detect drift between the repo-canonical compose and
# the live prod VM.
#
# The repo is the source of truth for the prod Compose STRUCTURE. This script
# compares the sha256 of deploy/docker-compose.vm.yml against the live file on
# the VM and exits non-zero on any mismatch, with a readable hint. Run it on a
# WEEKLY cadence (cron / a scheduled Actions job once a GCP service-account
# secret exists) so silent hand-edits on the VM surface fast.
#
# Watchtower auto-updates only the app + worker IMAGES; it never rewrites the
# compose file, so a drift here always means a human edited the VM out of band
# (or forgot to run deploy/apply.sh after a repo change).
#
# Usage:  deploy/check-drift.sh
# Exit:   0 = in sync, 1 = drift detected, 2 = could not reach the VM.
set -euo pipefail

VM_NAME="${VM_NAME:-agrent}"
VM_ZONE="${VM_ZONE:-europe-west1-b}"
REMOTE_DIR="${REMOTE_DIR:-/opt/agrent}"
COMPOSE_BASENAME="${COMPOSE_BASENAME:-docker-compose.vm.yml}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_COMPOSE="${SCRIPT_DIR}/${COMPOSE_BASENAME}"
REMOTE_COMPOSE="${REMOTE_DIR}/${COMPOSE_BASENAME}"

err() { printf '\033[31m[drift]\033[0m %s\n' "$*" >&2; }
ok()  { printf '\033[32m[drift]\033[0m %s\n' "$*"; }

# ── COMPOSE_BASENAME is an allowlist, not a free variable ────────────────
#
# This script reports drift for one file: the repo-canonical prod compose. The override
# existed as a bare default, so `COMPOSE_BASENAME=docker-compose.prod.yml
# deploy/apply.sh` was a supported invocation — and that file hardcodes a
# database name this stack does not use. The sequence is copy-up, `docker
# compose config` (which validates SYNTAX, not that the database exists),
# `up -d`, and only THEN health-verify, so the outage lands before anything
# notices. check-drift.sh would never have warned either: it only ever reads
# whatever this variable points at, so drift stays green on a file it does not
# look at.
#
# Refuse by default. The escape hatch is deliberately awkward to type, because
# reaching for it should be a decision and not a reflex.
CANONICAL_COMPOSE="docker-compose.vm.yml"
if [ "$COMPOSE_BASENAME" != "$CANONICAL_COMPOSE" ] \
   && [ "${I_KNOW_THIS_IS_NOT_THE_CANONICAL_COMPOSE:-0}" != "1" ]; then
    err "refusing to act on '${COMPOSE_BASENAME}' — the canonical compose is '${CANONICAL_COMPOSE}'."
    err "  Every running container on the prod VM is labelled with that file."
    err "  If you genuinely mean another one, set"
    err "  I_KNOW_THIS_IS_NOT_THE_CANONICAL_COMPOSE=1 and say why in your notes."
    exit 2
fi

[ -f "$LOCAL_COMPOSE" ] || { err "missing $LOCAL_COMPOSE"; exit 2; }

LOCAL_SHA="$(sha256sum "$LOCAL_COMPOSE" | awk '{print $1}')"

REMOTE_SHA="$(gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" \
    --command "sudo sha256sum '${REMOTE_COMPOSE}'" 2>/dev/null | awk '{print $1}')" || {
    err "could not read ${REMOTE_COMPOSE} on ${VM_NAME} (${VM_ZONE}). Check gcloud auth / VM state."
    exit 2
}

if [ -z "$REMOTE_SHA" ]; then
    err "remote sha256 was empty — ${REMOTE_COMPOSE} may not exist on the VM."
    exit 2
fi

# The db build context, which decides what the production database image IS.
# Hashing only the compose file let the VM's Dockerfile sit three months behind
# the repo with this check green (measured 2026-09-17: repo dd44f03d… vs VM
# 4940b1d6…). A compose file that is in sync says nothing about the image the
# `db` service builds from it.
LOCAL_DF="${SCRIPT_DIR}/postgres/Dockerfile"
REMOTE_DF="${REMOTE_DIR}/deploy/postgres/Dockerfile"
DF_DRIFT=0
if [ -f "$LOCAL_DF" ]; then
    LOCAL_DF_SHA="$(sha256sum "$LOCAL_DF" | awk '{print $1}')"
    REMOTE_DF_SHA="$(gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" \
        --command "sudo sha256sum '${REMOTE_DF}'" 2>/dev/null | awk '{print $1}')" || REMOTE_DF_SHA=""
    if [ -z "$REMOTE_DF_SHA" ]; then
        err "could not read ${REMOTE_DF} on ${VM_NAME} — absent, or unreadable."
        DF_DRIFT=1
    elif [ "$LOCAL_DF_SHA" != "$REMOTE_DF_SHA" ]; then
        err "DRIFT — deploy/postgres/Dockerfile differs (local ${LOCAL_DF_SHA:0:12}, remote ${REMOTE_DF_SHA:0:12})."
        err "  The db service builds from it. Reconcile with deploy/apply.sh, and note that"
        err "  copying it does NOT rebuild the image — see docs/runbooks/postgis-trixie-cutover.md."
        DF_DRIFT=1
    else
        ok "in sync — deploy/postgres/Dockerfile matches (${LOCAL_DF_SHA:0:12})"
    fi
else
    err "missing $LOCAL_DF — the db build context is not where this script expects it."
    DF_DRIFT=1
fi

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
    if [ "$DF_DRIFT" -ne 0 ]; then
        err "compose file is in sync but the db build context is NOT."
        exit 1
    fi
    ok "in sync — ${COMPOSE_BASENAME} matches ${VM_NAME}:${REMOTE_COMPOSE} (${LOCAL_SHA:0:12})"
    exit 0
fi

err "DRIFT DETECTED"
err "  repo : ${LOCAL_SHA}  (${LOCAL_COMPOSE})"
err "  VM   : ${REMOTE_SHA}  (${VM_NAME}:${REMOTE_COMPOSE})"
err ""
err "The live compose no longer matches the repo. Either:"
err "  • the VM was hand-edited  → reconcile the change INTO the repo file,"
err "    commit it, then re-run this check; or"
err "  • the repo changed but wasn't applied → run deploy/apply.sh to push it."
err ""
err "See the exact diff with:"
err "  gcloud compute ssh ${VM_NAME} --zone ${VM_ZONE} --command \"sudo cat '${REMOTE_COMPOSE}'\" | diff ${LOCAL_COMPOSE} -"
exit 1
