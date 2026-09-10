#!/usr/bin/env bash
#
# deploy/apply.sh — push the repo-canonical compose to the prod VM.
#
# The repo is the source of truth for the prod Compose STRUCTURE
# (deploy/docker-compose.vm.yml). Watchtower auto-updates only the app +
# worker *images*; every structural change — a new service, a resource limit,
# an env addition — lands here and is applied with this script. Drift between
# the repo and the VM is detected by deploy/check-drift.sh, never tolerated.
#
# What it does (idempotent):
#   1. Back up the remote compose ( <file>.bak.<timestamp> ).
#   2. Copy the repo compose up.
#   3. Validate with `docker compose config`.
#   4. `docker compose up -d`.
#   5. Health-verify: /api/readyz AND the installed-PWA lifelines
#      /manifest.webmanifest + /sw.js (a deploy that 404s the service worker
#      strands offline-installed mobile clients until their caches expire).
#   6. Print the rollback command.
#
# It does NOT edit .env.prod / .env and never echoes its contents.
#
# Usage:  deploy/apply.sh            # apply to the default VM
#         DRY_RUN=1 deploy/apply.sh  # validate locally, don't touch the VM
#
set -euo pipefail

# ── Config (override via env) ────────────────────────────────────────────
VM_NAME="${VM_NAME:-agrent}"
VM_ZONE="${VM_ZONE:-europe-west1-b}"
REMOTE_DIR="${REMOTE_DIR:-/opt/agrent}"
COMPOSE_BASENAME="${COMPOSE_BASENAME:-docker-compose.vm.yml}"
# Public origin used for post-deploy health checks (no trailing slash).
HEALTH_ORIGIN="${HEALTH_ORIGIN:-https://35-187-80-26.sslip.io}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_COMPOSE="${SCRIPT_DIR}/${COMPOSE_BASENAME}"
REMOTE_COMPOSE="${REMOTE_DIR}/${COMPOSE_BASENAME}"
TS="$(date +%Y%m%d-%H%M%S)"

log() { printf '\033[36m[apply]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[apply] ERROR:\033[0m %s\n' "$*" >&2; }

[ -f "$LOCAL_COMPOSE" ] || { err "missing $LOCAL_COMPOSE"; exit 1; }

# Helper: run a command on the VM.
ssh_vm() { gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --command "$1"; }

if [ "${DRY_RUN:-0}" = "1" ]; then
    log "DRY_RUN — validating $LOCAL_COMPOSE locally with docker compose config"
    docker compose -f "$LOCAL_COMPOSE" config -q && log "compose config OK" || { err "compose config failed"; exit 1; }
    log "DRY_RUN complete — no VM changes made."
    exit 0
fi

# ── 1. Back up the remote file ───────────────────────────────────────────
log "backing up remote ${REMOTE_COMPOSE} → ${REMOTE_COMPOSE}.bak.${TS}"
ssh_vm "sudo cp -a '${REMOTE_COMPOSE}' '${REMOTE_COMPOSE}.bak.${TS}'"

# ── 2. Copy the repo compose up (staged in home, then sudo-moved) ────────
log "copying ${LOCAL_COMPOSE} → VM"
gcloud compute scp "$LOCAL_COMPOSE" "${VM_NAME}:/tmp/${COMPOSE_BASENAME}.new" --zone "$VM_ZONE"
ssh_vm "sudo mv '/tmp/${COMPOSE_BASENAME}.new' '${REMOTE_COMPOSE}' && sudo chown root:root '${REMOTE_COMPOSE}'"

# ── 3. Validate ──────────────────────────────────────────────────────────
log "validating on VM: docker compose config"
if ! ssh_vm "cd '${REMOTE_DIR}' && sudo docker compose -f '${COMPOSE_BASENAME}' config -q"; then
    err "docker compose config FAILED on the VM — restoring backup"
    ssh_vm "sudo cp -a '${REMOTE_COMPOSE}.bak.${TS}' '${REMOTE_COMPOSE}'"
    exit 1
fi

# ── 4. Apply ─────────────────────────────────────────────────────────────
log "docker compose up -d"
ssh_vm "cd '${REMOTE_DIR}' && sudo docker compose -f '${COMPOSE_BASENAME}' up -d"

# ── 5. Health-verify (readyz + PWA lifelines) ────────────────────────────
log "health-verifying ${HEALTH_ORIGIN}"
HEALTH_FAILED=0
for path in /api/readyz /manifest.webmanifest /sw.js; do
    # Retry a few times — containers may still be settling.
    code=""
    for attempt in 1 2 3 4 5 6; do
        # shell-check-ok: 000 is a sentinel OUTSIDE the healthy range and the
        # comparison below fails closed on it — unlike `|| echo 0`, it cannot
        # be mistaken for a healthy answer.
        code="$(curl -fsS -o /dev/null -w '%{http_code}' "${HEALTH_ORIGIN}${path}" 2>/dev/null || echo 000)"
        [ "$code" = "200" ] && break
        sleep 5
    done
    if [ "$code" = "200" ]; then
        log "  OK   ${path} → 200"
    else
        err "  FAIL ${path} → ${code}"
        HEALTH_FAILED=1
    fi
done

# ── 6. Rollback hint ─────────────────────────────────────────────────────
ROLLBACK="gcloud compute ssh ${VM_NAME} --zone ${VM_ZONE} --command \"sudo cp -a '${REMOTE_COMPOSE}.bak.${TS}' '${REMOTE_COMPOSE}' && cd '${REMOTE_DIR}' && sudo docker compose -f '${COMPOSE_BASENAME}' up -d\""

if [ "$HEALTH_FAILED" = "1" ]; then
    err "deploy applied but health checks FAILED. Roll back with:"
    printf '  %s\n' "$ROLLBACK" >&2
    exit 1
fi

log "deploy OK. Rollback command (if needed later):"
printf '  %s\n' "$ROLLBACK"
