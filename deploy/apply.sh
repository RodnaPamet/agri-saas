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

# The `db` service has `build: context: ./deploy/postgres`, so the compose file
# alone is NOT the deployable unit — the Dockerfile beside it decides what the
# production database image IS. This script copied only the compose file until
# 2026-09-17, and `check-drift.sh` hashed only the compose file, so the VM's
# copy drifted undetected: measured that day, the VM held a 2026-06-27 version
# that predated the `Acquire::Check-Valid-Until` flags entirely, three months
# behind the repo, with drift green throughout.
LOCAL_DB_CTX="${SCRIPT_DIR}/postgres"
REMOTE_DB_CTX="${REMOTE_DIR}/deploy/postgres"
TS="$(date +%Y%m%d-%H%M%S)"

log() { printf '\033[36m[apply]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[apply] ERROR:\033[0m %s\n' "$*" >&2; }

# ── COMPOSE_BASENAME is an allowlist, not a free variable ────────────────
#
# This script's job is one file: the repo-canonical prod compose. The override
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

[ -f "$LOCAL_COMPOSE" ] || { err "missing $LOCAL_COMPOSE"; exit 1; }

# Helper: one HTTP probe, answering a CLEAN status code or the sentinel 000.
#
# NO `-f`. That flag makes curl exit non-zero on an HTTP error WHILE `-w` still
# writes the code and without a trailing newline, so the old
# `… || echo 000` concatenated the two: a 503 was captured as `503000` and the
# rollback message read `FAIL /api/readyz → 503000`. The comparison still
# failed closed, so the check was right and only its REPORT was wrong — but the
# report is the whole interface of a step whose next line is a destructive
# command, and a garbled code is the kind of thing an operator stops reading.
#
# Measured 2026-11-01 against a known 404: capture `404000`, curl exit 22.
#
# Without `-f`, curl exits 0 for any completed request and `%{http_code}` is
# the true code; an unfinished request (DNS, refused, timeout) writes nothing,
# which the empty check below turns into 000. Nothing compares against
# anything but `200`, so dropping `-f` narrows nothing.
probe() {
    local code
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)" || code=""
    # shell-check-ok: 000 is a sentinel OUTSIDE the healthy range and every
    # comparison fails closed on it — unlike `|| echo 0`, it cannot be
    # mistaken for a healthy answer.
    [ -n "$code" ] || code="000"
    printf '%s' "$code"
}

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

# …and the db build context, for the reason above. Backed up the same way the
# compose file is, so the rollback command at the end restores a matched pair.
log "backing up remote ${REMOTE_DB_CTX}/Dockerfile → .bak.${TS}"
ssh_vm "sudo cp -a '${REMOTE_DB_CTX}/Dockerfile' '${REMOTE_DB_CTX}/Dockerfile.bak.${TS}' 2>/dev/null || true"
log "copying ${LOCAL_DB_CTX}/Dockerfile → ${VM_NAME}:${REMOTE_DB_CTX}/Dockerfile"
gcloud compute scp "${LOCAL_DB_CTX}/Dockerfile" "${VM_NAME}:/tmp/Dockerfile.db.new" --zone "$VM_ZONE"
ssh_vm "sudo mkdir -p '${REMOTE_DB_CTX}' && sudo mv '/tmp/Dockerfile.db.new' '${REMOTE_DB_CTX}/Dockerfile' && sudo chown root:root '${REMOTE_DB_CTX}/Dockerfile'"

# NOTE: copying the Dockerfile does NOT rebuild the image. `docker compose up -d`
# below reuses `agrent-db:local` if it exists, so a base-image change needs an
# explicit `docker compose -f <compose> build db` and a database cutover — see
# docs/runbooks/postgis-trixie-cutover.md. That is deliberate: rebuilding a
# production database image as a side effect of a compose apply is exactly the
# surprise this script should not spring.

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

# ── 5. Health-verify (readyz, THEN the PWA lifelines) ────────────────────
#
# READINESS FIRST, WITH THE CONTAINER'S OWN GRACE (#2692). This step reported
# FAIL on a healthy deploy and printed the rollback command directly
# underneath: six attempts five seconds apart is ~30s, while
# `docker-compose.vm.yml` gives the app `start_period: 60s` precisely because
# `next start` takes tens of seconds to answer `readyz`. The compose
# healthcheck knew; this script did not, and the obvious response to "health
# checks FAILED" at 9pm is to paste the rollback — undoing a working deploy and
# re-opening whatever it fixed.
#
# THE DEADLINE IS DERIVED FROM THE COMPOSE FILE rather than written here, so
# the two cannot drift apart again. That drift IS the defect; a second
# hardcoded number would be the same bug with a bigger constant. `+30` is grace
# ABOVE the container's own grace: the container is allowed to be unhealthy for
# `start_period`, so failing at exactly that moment would still be a race.
#
# THE ORDER IS WHAT MAKES THE SINGLE-SHOT CHECKS SAFE, and #2692's own
# suggestion to "keep the single-shot behaviour for /manifest.webmanifest and
# /sw.js" is only correct once they run AFTER readyz. All three paths are served
# by the same Next process behind the same Caddy, so during boot they fail
# together — a single-shot manifest check would have been the identical race
# with a different name. Run once readyz has answered, a 404 there is a REAL
# 404, which is the case that strands offline-installed mobile clients and the
# one worth failing on immediately.
READY_GRACE="$(sed -n '/^  app:/,/^  [a-z]/p' "${LOCAL_COMPOSE}" | sed -n 's/^[[:space:]]*start_period:[[:space:]]*\([0-9]\+\)s[[:space:]]*$/\1/p' | head -1)"
if [ -z "${READY_GRACE}" ]; then
    # Fail LOUD rather than silently substituting a default. An empty
    # substitution here would mean the deadline became `0 + 30`, which is
    # tighter than the behaviour this change replaces — the failure mode would
    # be a stricter check wearing the comment of a laxer one.
    err "could not read the app service's start_period from ${LOCAL_COMPOSE}"
    err "the readyz deadline is derived from it; fix the compose file or this parser"
    exit 1
fi
READY_DEADLINE=$(( READY_GRACE + 30 ))
log "health-verifying ${HEALTH_ORIGIN} (readyz deadline ${READY_DEADLINE}s, from start_period ${READY_GRACE}s)"

HEALTH_FAILED=0
READY_CODE=""
READY_WAITED=0
while [ "${READY_WAITED}" -le "${READY_DEADLINE}" ]; do
    READY_CODE="$(probe "${HEALTH_ORIGIN}/api/readyz")"
    [ "${READY_CODE}" = "200" ] && break
    sleep 5
    READY_WAITED=$(( READY_WAITED + 5 ))
done

if [ "${READY_CODE}" = "200" ]; then
    # The elapsed time is REPORTED, not just tolerated. A deploy that needed
    # 75s is working and worth knowing about — it is the signal that the
    # derived deadline is close to binding, which a bare OK would hide until
    # the day it failed.
    log "  OK   /api/readyz → 200 after ${READY_WAITED}s"
else
    err "  FAIL /api/readyz → ${READY_CODE} after ${READY_DEADLINE}s"
    HEALTH_FAILED=1
fi

# Single-shot, and only meaningful because readyz has answered above.
for path in /manifest.webmanifest /sw.js; do
    code="$(probe "${HEALTH_ORIGIN}${path}")"
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
