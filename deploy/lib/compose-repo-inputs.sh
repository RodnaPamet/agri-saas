# shellcheck shell=bash
#
# compose_repo_inputs <compose-file> <repo-root>
#
# Prints, one per line and sorted, every REPO file the production compose file
# depends on beyond itself (#3191):
#
#   - every regular file under a `build: context: ./deploy/…` directory, and
#   - every `./deploy/…` bind-mount source.
#
# Paths are repo-relative (`deploy/postgres/Dockerfile`), which is also their
# path under the VM's stack directory, because the compose file resolves
# `./…` against that directory and the repo root mirrors it.
#
# DERIVED rather than listed, which is the whole point. `apply.sh` and
# `check-drift.sh` named `deploy/postgres/Dockerfile` by hand, so when the
# `zarnoborsa` service arrived with `context: ./deploy/zarnoborsa` neither
# script shipped or hashed it, and `init-roles.sh` (a bind mount) was never
# hashed either — the same class as the 2026-09-17 postgres drift those two
# scripts had been extended to cover. A new context or mount is covered the
# moment the compose file names it.
#
# Only paths under `./deploy/` are inputs. `./Caddyfile` is VM-PROVIDED and
# serves a co-tenant product; shipping the repo's partial copy over it is an
# outage (see deploy/caddy-foreign-sites.txt). `context: .` (app, worker) is
# the image's own build and is pulled from GHCR, not built on the VM.
#
# Fails (non-zero) if a named input does not exist in the repo, so a missing
# file is a refusal rather than a silently shorter list.
compose_repo_inputs() {
    local compose="$1" repo_root="$2" ctx rel missing=0
    local contexts mounts
    contexts="$(sed -nE 's#^[[:space:]]+context:[[:space:]]*\./(deploy/[^[:space:]]+)[[:space:]]*$#\1#p' "$compose")"
    mounts="$(sed -nE 's#^[[:space:]]+-[[:space:]]*\./(deploy/[^:[:space:]]+):.*#\1#p' "$compose")"
    {
        while IFS= read -r ctx; do
            [ -n "$ctx" ] || continue
            if [ ! -d "${repo_root}/${ctx}" ]; then
                printf 'compose_repo_inputs: build context %s is not in the repo\n' "$ctx" >&2
                missing=1
                continue
            fi
            (cd "$repo_root" && find "$ctx" -type f ! -name '*.bak.*')
        done <<<"$contexts"
        while IFS= read -r rel; do
            [ -n "$rel" ] || continue
            if [ ! -f "${repo_root}/${rel}" ]; then
                printf 'compose_repo_inputs: bind-mount source %s is not in the repo\n' "$rel" >&2
                missing=1
                continue
            fi
            printf '%s\n' "$rel"
        done <<<"$mounts"
        [ "$missing" -eq 0 ]
    } | LC_ALL=C sort -u
    # The brace group's status is lost to the pipe; re-derive it.
    return "${PIPESTATUS[0]}"
}
