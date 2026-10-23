#!/usr/bin/env bash
#
# Prune accumulated `<file>.bak*` snapshots on the VM — #2082.
#
# ## Why this exists
#
# `/opt/agrent/` held **34 copies of `.env`** when #2082 was filed, the oldest
# from 30 June, each a full set of production credentials unencrypted beside the
# live file with no expiry. Three different naming styles, so at least three
# things had created them — and nothing in this repository writes them at all
# (`grep -rn "env\.bak"` finds nothing). They come from ad-hoc operator commands
# and from agent sessions, each sensibly backing up before an edit and none
# cleaning up after.
#
# The VM is single-tenant and behind IAP, so this is not an open door. What it is
# is a quiet widening of what ONE COMPROMISED HOST costs: dozens of historical
# credential sets instead of one live one, several predating rotations, with no
# record of which values in them are still current.
#
# Owner ruling 2026-10-20: keep the last three and file the pattern.
#
# ## It computes the DELETE list and prints it BEFORE acting
#
# That shape is not a style preference; it is #2082's own post-mortem. The
# earlier ad-hoc prune built its keep-list two ways — three newest from `ls -1t`
# (NEWLINE-separated) and two by name (SPACE-separated) — then matched with a
# space-delimited `case`. The newline list silently matched nothing, so it
# deleted 32 files instead of 29, and the three it deleted were the three it
# meant to keep. The two most worth keeping survived by accident of the same bug.
#
# So: one delimiter throughout (newline, via `while read`), the DELETE list is
# what gets computed and printed, and nothing is removed without `--apply`.
#
# ## Backups holding a key name the live file lacks are PROTECTED
#
# Checked for `.env` only, because it is the only family whose contents are
# key=value. Two such files existed and the reason to check is what one of them
# was: `DATA_ENCRYPTION_KEY_PREVIOUS`, a previous master KEK present nowhere
# else. It turned out to be retired — `GET /api/admin/key-rotation` answers
# exactly that question and reported `previousKeyRetirable: true`, `remaining: 0`
# — but it was not knowable from the filename, and the NEXT unique key this
# finds may not be retired. So such a file is never deleted; it is named and
# kept, and removing it is a human decision.
#
# Usage:
#   deploy/prune-backups.sh [--apply] [--keep N] [--dir DIR] [--family NAME]
#
# Default is a DRY RUN against /opt/agrent keeping 3 per family.
# `Caddyfile` is excluded by default — see FAMILIES below for why.
set -euo pipefail

KEEP=3
DIR=/opt/agrent
APPLY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --apply) APPLY=1; shift ;;
        --keep) KEEP="${2:?--keep needs a number}"; shift 2 ;;
        --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
        --family) EXTRA_FAMILIES="${EXTRA_FAMILIES:-} ${2:?--family needs a name}"; shift 2 ;;
        -h|--help) sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

case "$KEEP" in
    ''|*[!0-9]*) echo "--keep must be a non-negative integer, got '$KEEP'" >&2; exit 2 ;;
esac
[ -d "$DIR" ] || { echo "no such directory: $DIR" >&2; exit 2; }

# The families, as the base filename whose snapshots accumulate. Each is matched
# as `<base>.bak*` AND `<base>-bak*`: #2082 recorded three naming styles for
# `.env` and the live box has a fourth (`.env.bak-vapid-<stamp>`), so the glob
# has to be looser than any one convention.
# The families whose snapshots accumulate, matched as `<base>.bak*` AND
# `<base>-bak*`: #2082 recorded three naming styles for `.env` and the live box
# has a fourth (`.env.bak-vapid-<stamp>`), so the glob has to be looser than any
# one convention.
#
# `Caddyfile` is DELIBERATELY ABSENT, and this is the one exclusion that matters.
# Every other file here is in the repository, so its snapshots are a convenience
# and git holds the history: `docker-compose.vm.yml` is kept byte-identical to
# `deploy/docker-compose.vm.yml` (verified by `deploy/check-drift.sh`), and the
# Dockerfile likewise. The live `/opt/agrent/Caddyfile` is the exception —
# CLAUDE.md records that `deploy/apply.sh` does not copy it and
# `check-drift.sh` does not hash it, so it is hand-edited on the box and nothing
# tracks it. Its 13 snapshots are therefore the ONLY record of those edits, and
# pruning them destroys history that exists nowhere else. Pass it explicitly
# with `--family Caddyfile` if you have decided otherwise.
FAMILIES=".env docker-compose.vm.yml Dockerfile"

total_delete=0
total_keep=0
total_protected=0

for base in $FAMILIES ${EXTRA_FAMILIES:-}; do
    # Newest first. `-t` sorts by mtime, which is what "the last three" means to
    # an operator — not the timestamp embedded in the name, because the three
    # naming styles do not sort consistently against each other.
    snapshots=$(ls -1t "$DIR/$base".bak* "$DIR/$base"-bak* 2>/dev/null || true)
    [ -z "$snapshots" ] && continue

    count=$(printf '%s\n' "$snapshots" | grep -c .)
    echo "── $base: $count snapshot(s)"

    live="$DIR/$base"
    live_keys=""
    if [ "$base" = ".env" ] && [ -f "$live" ]; then
        live_keys=$(grep -oE '^[A-Z][A-Z0-9_]*' "$live" 2>/dev/null | sort -u || true)
    fi

    i=0
    # ONE delimiter the whole way down. No space-separated second list.
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        i=$((i + 1))
        reason=""

        if [ -n "$live_keys" ]; then
            # Key NAMES only. Never the values: a comparison that reads values
            # is a read of every secret in the file, and PRESENT/ABSENT is all
            # this decision needs.
            extra=$(grep -oE '^[A-Z][A-Z0-9_]*' "$f" 2>/dev/null | sort -u \
                | comm -23 - <(printf '%s\n' "$live_keys") | tr '\n' ' ' || true)
            if [ -n "${extra// /}" ]; then
                reason="PROTECTED — holds key name(s) the live file lacks: ${extra% }"
            fi
        fi

        if [ -n "$reason" ]; then
            echo "   keep  $(basename "$f")  [$reason]"
            total_protected=$((total_protected + 1))
        elif [ "$i" -le "$KEEP" ]; then
            echo "   keep  $(basename "$f")  [newest $i of $KEEP]"
            total_keep=$((total_keep + 1))
        else
            echo "   DELETE $(basename "$f")"
            total_delete=$((total_delete + 1))
            if [ "$APPLY" = "1" ]; then
                rm -f -- "$f"
            fi
        fi
    done <<EOF
$snapshots
EOF
done

echo
echo "[prune-backups] keep $total_keep · protected $total_protected · delete $total_delete"
if [ "$APPLY" = "1" ]; then
    echo "[prune-backups] APPLIED — $total_delete file(s) removed from $DIR"
else
    echo "[prune-backups] DRY RUN — nothing removed. Re-run with --apply."
fi
