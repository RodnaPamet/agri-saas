#!/usr/bin/env bash
#
# Post-deploy: can each producer/consumer pair actually do its work? (#3099)
#
# ## Why this exists, and what it is NOT
#
# `scripts/verify-image-artefacts.mjs` asserts the bundles are IN the image.
# `tests/guards/zarnoborsa-fetch-deployment.test.ts` asserts the pieces are
# DECLARED. Both are necessary, and between them they caught ONE of the four
# defects in the #3081 chain:
#
#   #3096  the Dockerfile never built the bundle      <- the image check
#   #3113  the volume was root:root, app is uid 1001  <- NEITHER
#   #3117  ESM cannot resolve a bare import from the
#          published path; the compose `cd` is inert  <- NEITHER
#   #3120  the worker did not mount the handoff at all <- NEITHER
#
# Three of four. Every one of those three had a correct image and a correct
# compose file, and failed in the gap between "the artefact is there" and "the
# consumer can use it": POSIX ownership, module resolution, and whether the
# reader is even mounted on the writer's volume.
#
# They are the same shape — TWO CONTAINERS AGREEING ABOUT A PATH, WHERE ONLY
# ONE OF THEM WAS EVER ASKED. A guard asks the compose file. An in-image check
# asks the image. Neither asks the process that has to do the work. This does.
#
# ## It must NOT roll back a deploy, and must not be quiet either
#
# A dead price feed is not an outage: the app serves perfectly with the whole
# chain broken. So a finding here must never read as "roll back" — that is
# #2692's mistake, where a health check failing on a race had people pasting
# the rollback and undoing a working deploy.
#
# But "logged and nothing read it" is exactly how #3113 survived: the app wrote
# `… could not publish zarnoborsa-fetch.mjs (continuing)` at every recreate for
# hours and nobody looked. A warning is not enough.
#
# So: a distinct exit code. 0 = chain healthy. 2 = DEPLOYED AND DEGRADED, with
# the word "degraded" and an explicit DO NOT ROLL BACK. 1 is reserved for this
# script failing to look, which is a third thing again and must not read as
# either.
#
# ## Three questions per pair, each one measured rather than inferred
#
#   1. Did the PRODUCER publish? The target is non-empty, the bytes match the
#      image's copy, and the entrypoint logged success rather than its
#      best-effort failure line.
#   2. Can the CONSUMER run it? An import-resolution probe from a FILE inside
#      the consumer's own mount. `node -e 'import("x")'` resolves from the CWD
#      and printed RESOLVED in the very container where the real run failed —
#      so the probe has to be a file, in the mount, at the depth the real
#      bundle sits.
#   3. Can the READER see the writer's output? The consumer's declared handoff
#      path, readable from the container that reads it.
#
# And a rule for every count: `ls <dir> | wc -l` returns 0 for an empty
# directory AND an absent one AND a failed `ls`. Use `[ -d ]` and `[ -w ]`
# separately; a count cannot tell those apart.
#
# Usage:  deploy/verify-chain.sh                 (reads VM_NAME/VM_ZONE like apply.sh)
#         CHAIN_DOCKER="docker compose -f x.yml" deploy/verify-chain.sh --local
set -uo pipefail

VM_NAME="${VM_NAME:-agrent}"
VM_ZONE="${VM_ZONE:-europe-west1-b}"
REMOTE_COMPOSE="${REMOTE_COMPOSE:-/opt/agrent/docker-compose.vm.yml}"

log() { printf '\033[36m[chain]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[chain]\033[0m %s\n' "$*" >&2; }

DEGRADED=0
CHECKS=0

# Run a shell snippet on the VM. One indirection so `--local` can replace it
# for the test harness, which has no VM.
run_remote() {
    if [ "${CHAIN_LOCAL:-0}" = "1" ]; then
        bash -c "$1"
    else
        gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --command "$1" 2>/dev/null
    fi
}

DC="${CHAIN_DOCKER:-sudo docker compose -f ${REMOTE_COMPOSE}}"

# ── pair 1: the ZarnoBorsa fetch bundle (#3081) ───────────────────────────
#
# app  --writes--> appdist   --read-only--> zarnoborsa   (the SCRIPT)
# zarnoborsa --writes--> zarnoborsa vol --read-only--> worker  (the OUTPUT)

# The real paths, overridable ONLY so the test can execute this script's own
# embedded shell against a temp filesystem rather than mocking its output.
# That matters: the bugs in a script like this live in the quoting, and a test
# that stubs the output would grade the decision logic and leave the shell
# unexercised. Defaults are the production values; nothing sets these in
# `apply.sh`.
BUNDLE="${CHAIN_BUNDLE:-zarnoborsa-fetch.mjs}"
APP_DIST="${CHAIN_APP_DIST:-dist}"
APP_SHARE="${CHAIN_APP_SHARE:-/opt/share/dist}"
FETCH_MOUNT="${CHAIN_FETCH_MOUNT:-/opt/zarnoborsa/dist}"
FETCH_PKG_ROOT="${CHAIN_FETCH_PKG_ROOT:-/opt/zarnoborsa}"
HANDOFF_DIR="${CHAIN_HANDOFF_DIR:-/var/lib/agrent/zarnoborsa}"
# Where Q2 writes its probe: a SIBLING of the mount, i.e. the same directory
# depth under the package root (#3192). Not inside the mount — the canonical
# compose file mounts it `:ro`, so a probe written there could never be
# created and Q2 skipped on every run.
PROBE_PARENT="${CHAIN_PROBE_PARENT:-$(dirname "$FETCH_MOUNT")}"

log "pair: zarnoborsa fetch bundle"

# Q1 — did the producer publish, and do the bytes match the image's copy?
CHECKS=$((CHECKS + 1))
Q1="$(run_remote "$DC exec -T app sh -c '
  IMG=\$(wc -c < ${APP_DIST}/${BUNDLE} 2>/dev/null || echo 0)
  PUB=\$(wc -c < ${APP_SHARE}/${BUNDLE} 2>/dev/null || echo 0)
  [ -d ${APP_SHARE} ] && D=yes || D=no
  [ -w ${APP_SHARE} ] && W=yes || W=no
  echo \"dir=\$D writable=\$W image=\$IMG published=\$PUB\"
'" | grep -E '^dir=' | head -1)"
if [ -z "$Q1" ]; then
    err "  Q1 UNREADABLE — could not ask the app container. Not a pass."
    exit 1
fi
IMG_B="$(sed -n 's/.*image=\([0-9]*\).*/\1/p' <<<"$Q1")"
PUB_B="$(sed -n 's/.*published=\([0-9]*\).*/\1/p' <<<"$Q1")"
if [ "${PUB_B:-0}" -eq 0 ]; then
    err "  Q1 FAIL — ${APP_SHARE}/${BUNDLE} is absent or empty (${Q1})."
    err "         A root-owned share is #3113: 'rw=true' in docker inspect is a"
    err "         MOUNT flag and says nothing about POSIX ownership."
    DEGRADED=1
elif [ "${PUB_B}" != "${IMG_B}" ]; then
    err "  Q1 FAIL — published ${PUB_B} bytes, image has ${IMG_B}. Stale publish."
    DEGRADED=1
else
    log "  Q1 OK   published ${PUB_B} bytes, matching the image"
fi

# Q2 — can the consumer RESOLVE the bundle's imports? A FILE, because `-e`
# resolves from the cwd and would print RESOLVED in the container where the
# real run fails (#3117). The file sits in a fresh directory BESIDE the mount
# rather than inside it (#3192): resolution of a bare specifier walks
# `<dir>/node_modules` and then the parents, so a sibling of the mount walks
# exactly the parents the bundle does — `<pkg root>/node_modules` included —
# without needing the read-only mount to be writable.
CHECKS=$((CHECKS + 1))
Q2="$(run_remote "$DC exec -T zarnoborsa sh -c '
  D=${PROBE_PARENT}/.chain-probe-\$\$
  P=\$D/probe.mjs
  SPEC=\$(sed -n \"s/.*from \\\"\\([a-z@][a-z0-9@/-]*\\)\\\".*/\\1/p\" ${FETCH_MOUNT}/${BUNDLE} 2>/dev/null | grep -v \"^node:\" | head -1)
  [ -z \"\$SPEC\" ] && { echo probe=no-bare-import; exit 0; }
  mkdir -p \$D 2>/dev/null && printf \"import x from \\\"%s\\\";\nconsole.log(\\\"RESOLVED\\\");\n\" \"\$SPEC\" > \$P 2>/dev/null || { echo probe=unwritable spec=\$SPEC dir=\$D; exit 0; }
  OUT=\$(cd ${FETCH_PKG_ROOT} && node \$P 2>&1 | tail -1)
  rm -rf \$D
  case \"\$OUT\" in *RESOLVED*) echo probe=ok spec=\$SPEC ;; *) echo probe=failed spec=\$SPEC detail=\"\$OUT\" ;; esac
'" | grep -E '^probe=' | head -1)"
if [ -z "$Q2" ]; then
    err "  Q2 UNREADABLE — could not ask the fetch container. Not a pass."
    exit 1
fi
case "$Q2" in
    probe=ok*)
        log "  Q2 OK   the bundle's bare import resolves from its own mount (${Q2#probe=ok })"
        ;;
    probe=no-bare-import*)
        # Not a failure and not a pass: the bundle may legitimately have no
        # external import, and then there is nothing to resolve. Reported so a
        # silently-empty probe is not read as a clean result.
        log "  Q2 SKIP the bundle declares no bare import — nothing to resolve"
        ;;
    probe=unwritable*)
        # A FAILURE, not a skip (#3192). Skipping here is how this check came to
        # report nothing on every run: the probe used to go inside the `:ro`
        # mount, so it was never written and the import was never resolved.
        err "  Q2 FAIL — could not write the resolution probe (${Q2#probe=unwritable })."
        err "         The import was NOT checked; this is not a pass."
        DEGRADED=1
        ;;
    *)
        err "  Q2 FAIL — the bundle's import does NOT resolve from its mount: ${Q2}"
        err "         This is #3117: ESM resolves a bare specifier from the"
        err "         importing FILE's URL and ignores the cwd, so a 'cd' in the"
        err "         compose command is inert."
        DEGRADED=1
        ;;
esac

# Q3 — can the READER see the writer's output? (#3120)
CHECKS=$((CHECKS + 1))
Q3="$(run_remote "$DC exec -T worker sh -c '
  [ -d ${HANDOFF_DIR} ] && D=yes || D=no
  [ -r ${HANDOFF_DIR} ] && R=yes || R=no
  echo \"handoffdir=\$D readable=\$R\"
'" | grep -E '^handoffdir=' | head -1)"
if [ -z "$Q3" ]; then
    err "  Q3 UNREADABLE — could not ask the worker container. Not a pass."
    exit 1
fi
case "$Q3" in
    *handoffdir=yes*readable=yes*)
        log "  Q3 OK   the worker can read ${HANDOFF_DIR}"
        ;;
    *)
        err "  Q3 FAIL — the worker cannot read ${HANDOFF_DIR} (${Q3})."
        err "         This is #3120: the producer wrote into a volume the"
        err "         consumer does not mount, and the ingest reported"
        err "         'unaudited / no-file' for a file that existed."
        DEGRADED=1
        ;;
esac

# ── verdict ──────────────────────────────────────────────────────────────
if [ "$DEGRADED" = "1" ]; then
    err ""
    err "DEPLOYED AND DEGRADED — ${CHECKS} check(s) run, at least one failed."
    err "DO NOT ROLL BACK. The application is serving; a broken producer/consumer"
    err "chain is a dead background feature, not an outage, and rolling back"
    err "would undo a working deploy to fix something a rollback does not fix."
    err "Exit 2 means exactly this, and is distinct from exit 1 (could not look)."
    exit 2
fi

log "chain OK — ${CHECKS} check(s), every producer/consumer pair can do its work"
