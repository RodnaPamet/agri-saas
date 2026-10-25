#!/usr/bin/env bash
#
# Does a backup of the production database exist AT ALL? — #2329
#
# ## Why this is separate from the monthly restore drill
#
# `restore-test.yml` already asserts the right things — that the snapshot
# schedule is attached, that the newest snapshot is under 26h old, and that a
# disk made from it boots a working Postgres. It is a good drill. It is also
# monthly, and monthly is longer than it takes for a backup mechanism to
# disappear completely:
#
#   2026-10-03  the drill ran, and passed
#   2026-10-12  the snapshot schedules were detached and deleted, and 60
#               snapshots with them — deliberately, by the project owner
#   2026-10-25  13 days later, nothing had reported anything
#   2026-11-01  the first run that would have failed
#
# Four weeks of no backup, with no red anywhere, because the check that would
# have caught it was not due. The drill was never wrong; it was ABSENT, and
# absent is what aggregates score as fine. So this probe asks the cheap half of
# the question — "is there a recent backup" — every day, and leaves the
# expensive half — "does restoring it work" — to the drill.
#
# ## It enumerates mechanisms instead of assuming one
#
# When this was filed, which mechanism would replace the snapshot schedule was
# an open question, and a probe hard-coded to the wrong one is worse than no
# probe: it would report ABSENT forever against a mechanism nobody chose, and
# get muted. So the mechanisms are a LIST, each read independently, each
# reporting PRESENT or ABSENT with its newest artefact. The verdict is OK if any
# one of them has something fresh.
#
# That also means a new mechanism needs a new entry here and nothing else, and
# that the verdict cannot silently narrow to a single mechanism's fortunes.
#
# ## The three states, and why MISSING is not a failure of this script
#
#   OK            at least one mechanism has an artefact newer than MAX_AGE_HOURS
#   MISSING       every mechanism answered, and none has anything fresh
#   UNANSWERABLE  a mechanism could not be read — no credentials, an API error
#
# MISSING exits 0 and files an issue, for the reason `dependabot-updater-health.sh`
# documents: the ISSUE is the signal, and a red run here would make
# `ci-failure-issue.yml` file a second one about the same outage. UNANSWERABLE
# exits non-zero, because a probe that cannot read its subject must not be
# mistaken for one that read it and found things well — that confusion is the
# entire defect this file exists for.
set -euo pipefail

MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"
TARGET_DISK="${TARGET_DISK:-agrent}"
TITLE="No recent backup of the production database"

# Indirection so the suite can drive this script against stubs, the same way
# `ci-failure-issue.sh` takes `$GH`. Without it the only reachable verdict is
# whichever one the live project happens to be in — and the whole point of
# this probe is the verdict nobody had seen.
GCLOUD="${GCLOUD:-gcloud}"
GH="${GH:-gh}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

# Pinnable so a test can place "now" on either side of the threshold. Without
# this the suite could only ever exercise whichever verdict the wall clock
# happened to produce, which is no test at all.
NOW_EPOCH="${NOW_OVERRIDE_EPOCH:-$(date -u +%s)}"
CUTOFF=$(( NOW_EPOCH - MAX_AGE_HOURS * 3600 ))

ERR="$(mktemp)"
trap 'rm -f "$ERR"' EXIT

die() {
    echo "::error::$1"
    echo "BACKUP_RESULT=UNANSWERABLE $1"
    exit 1
}

FRESH_FOUND=0
# A third state, between fresh and absent: an artefact exists and is recent but
# the set is incomplete, so it cannot be restored. Reported as a problem rather
# than as OK, and named differently in the issue because the fix differs — the
# nightly job is running and dropping half its output, which is not the same
# failure as a job that has stopped.
INCOMPLETE=0
DETAILS=""

note() { DETAILS="${DETAILS}${DETAILS:+; }$1"; }

# Record a mechanism's newest artefact and fold it into the verdict. Takes an
# already-read timestamp so the reading and the judging stay separable.
judge() {
    local mech="$1" newest_iso="$2" label="$3" epoch age_h
    if [ -z "$newest_iso" ]; then
        echo "[backup-exists] ${mech}: ABSENT (no artefact at all)"
        note "${mech} ABSENT"
        return 0
    fi
    # Parsed HERE rather than in a helper reached through `$( )`. A `die`
    # inside a command substitution exits the SUBSHELL: the script then
    # continued with an empty epoch, printed its UNANSWERABLE line INTO the
    # variable instead of to stdout, and went on to emit a second verdict. The
    # suite caught it; `set -e` cannot, because a substitution's exit status is
    # discarded when it is only being assigned.
    #
    # An unparseable stamp is never silently treated as old — that would turn a
    # format change into a permanent, plausible-looking MISSING.
    if ! epoch="$(date -u -d "$newest_iso" +%s 2>/dev/null)"; then
        die "could not parse the timestamp '${newest_iso}' from mechanism '${mech}' — its output format changed, so freshness cannot be judged"
    fi
    age_h=$(( (NOW_EPOCH - epoch) / 3600 ))
    if [ "$epoch" -ge "$CUTOFF" ]; then
        echo "[backup-exists] ${mech}: PRESENT and fresh — ${label} at ${newest_iso} (${age_h}h old)"
        note "${mech} fresh (${age_h}h)"
        FRESH_FOUND=1
    else
        echo "[backup-exists] ${mech}: STALE — newest is ${label} at ${newest_iso} (${age_h}h old, limit ${MAX_AGE_HOURS}h)"
        note "${mech} stale (${age_h}h)"
    fi
}

# ── Mechanism 1: a GCE disk snapshot of the target disk ──────────────────────
#
# What `docs/backup-restore.md` specified until 2026-10-12. Filtered on the
# source disk rather than the name, because the name is a schedule's convention
# and the disk is the thing being backed up.
if ! SNAP="$("$GCLOUD" compute snapshots list \
        --filter="sourceDisk~/${TARGET_DISK}\$" \
        --sort-by=~creationTimestamp --limit=1 \
        --format="value(name,creationTimestamp)" 2>"$ERR")"; then
    die "could not list snapshots for disk '${TARGET_DISK}': $(tr '\n' ' ' < "$ERR" | cut -c1-200)"
fi
# An empty list here is a real answer (no snapshots exist) and must be told
# apart from the error above — which is why the exit status is checked
# separately from the emptiness.
judge "snapshot" "$(printf '%s' "$SNAP" | awk 'NF{print $NF; exit}')" \
      "$(printf '%s' "$SNAP" | awk 'NF{print $1; exit}')"

# ── Mechanism 2: a pg_dump object in a backup bucket ─────────────────────────
#
# The application-consistent route, and the one a co-tenant product already
# runs on this very host. `BACKUP_BUCKET` pins it; absent that, buckets are
# discovered by name so that standing up the mechanism does not also require
# editing this file. Discovery is matched against the TARGET DISK's name, so it
# cannot accidentally credit another product's bucket for this one's backups.
if [ -n "${BACKUP_BUCKET:-}" ]; then
    BUCKETS="$BACKUP_BUCKET"
else
    if ! ALL="$("$GCLOUD" storage buckets list --format="value(name)" 2>"$ERR")"; then
        die "could not list storage buckets: $(tr '\n' ' ' < "$ERR" | cut -c1-200)"
    fi
    BUCKETS="$(printf '%s\n' "$ALL" | grep -E "${TARGET_DISK}.*(backup|dump)|(backup|dump).*${TARGET_DISK}" || true)"
fi

if [ -z "$BUCKETS" ]; then
    echo "[backup-exists] bucket: ABSENT (no bucket named for '${TARGET_DISK}' backups, and BACKUP_BUCKET is unset)"
    note "bucket ABSENT"
else
    BEST_ISO=""
    BEST_OBJ=""
    BEST_HAS_GLOBALS=""
    for b in $BUCKETS; do
        if ! OBJS="$("$GCLOUD" storage ls -l "gs://${b}/**" 2>"$ERR")"; then
            die "could not list objects in gs://${b}: $(tr '\n' ' ' < "$ERR" | cut -c1-200)"
        fi
        # `ls -l` emits `size  ISO-8601  gs://path`, then a TOTAL line that has
        # no date and must not be read as an object.
        # The newest `*.dump`, NOT the newest object. Each night writes TWO
        # objects with the SAME timestamp — the dump and its
        # `pg_dumpall --roles-only` sibling — and `.globals.sql` sorts after
        # `.dump`, so "newest object" selects the 888-byte roles file and the
        # verdict is reached on the smaller half. #2338.
        line="$(printf '%s\n' "$OBJS" \
            | awk '$2 ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/ && $3 ~ /\.dump$/ {print $2" "$3}' \
            | sort | tail -1)"
        iso="$(printf '%s' "$line" | awk '{print $1}')"
        if [ -n "$iso" ] && { [ -z "$BEST_ISO" ] || [[ "$iso" > "$BEST_ISO" ]]; }; then
            BEST_ISO="$iso"
            BEST_OBJ="$(printf '%s' "$line" | awk '{print $2}')"
            # A dump WITHOUT its globals is present and unrestorable: pg_dump
            # omits roles while emitting every GRANT that needs them, so it
            # fails 42704 on every one. That is a state the old probe could not
            # express — it is neither "fresh" nor "absent" — and it is the
            # exact defect #2337 found in the backup it watches.
            if printf '%s\n' "$OBJS" | grep -qF "${BEST_OBJ%.dump}.globals.sql"; then
                BEST_HAS_GLOBALS=yes
            else
                BEST_HAS_GLOBALS=no
            fi
        fi
    done
    judge "bucket" "$BEST_ISO" "${BEST_OBJ:-none}"
    # Checked AFTER judge, so a stale dump reports staleness rather than being
    # masked by a missing sibling — two faults, two messages.
    if [ -n "$BEST_ISO" ] && [ "$BEST_HAS_GLOBALS" = "no" ]; then
        echo "[backup-exists] bucket: the newest dump has NO globals sibling — present but UNRESTORABLE"
        note "bucket dump has no globals (unrestorable)"
        FRESH_FOUND=0
        INCOMPLETE=1
    fi
fi

# ── Verdict ─────────────────────────────────────────────────────────────────
if ! EXISTING="$("$GH" issue list --repo "$REPO" --state open --limit 50 \
        --search "\"$TITLE\" in:title" --json number --jq '.[0].number // ""' 2>"$ERR")"; then
    die "could not search existing issues, so refusing to file a possible duplicate: $(tr '\n' ' ' < "$ERR" | cut -c1-200)"
fi

if [ "$FRESH_FOUND" = "1" ]; then
    echo "BACKUP_RESULT=OK ${DETAILS}"
    if [ -n "$EXISTING" ]; then
        "$GH" issue close "$EXISTING" --repo "$REPO" --comment \
"A backup newer than ${MAX_AGE_HOURS}h now exists — ${DETAILS}. Closing automatically.

This says a backup EXISTS and is recent. Whether restoring it works is the monthly \`Restore Test\` drill's question, not this probe's."
    fi
    exit 0
fi

if [ "$INCOMPLETE" = "1" ]; then
    echo "BACKUP_RESULT=INCOMPLETE ${DETAILS}"
else
    echo "BACKUP_RESULT=MISSING ${DETAILS}"
fi

if [ "$INCOMPLETE" = "1" ]; then
    BODY="A recent backup of \`${TARGET_DISK}\` exists but is **not restorable**: the newest \`*.dump\` has no \`*.globals.sql\` sibling.

Mechanisms read: ${DETAILS}.

\`pg_dump\` does not dump roles — they are cluster-level — while emitting every GRANT that depends on them. Restored into a clean cluster the dump fails each of those GRANTs with \`42704 role "app_user" does not exist\`, so the data lands and the application's own role does not exist. See #2337, where the backup had exactly this defect, and #2338.

**This is a different failure from a missing backup and wants a different fix.** The nightly job is RUNNING and dropping half its output, so look at \`/usr/local/sbin/agrent-db-backup\` and its journal rather than at whether the timer fired.

This issue closes itself once a complete, recent backup exists."
else
    BODY="No backup of the production database (\`${TARGET_DISK}\`) newer than **${MAX_AGE_HOURS}h** could be found by any mechanism this probe knows about.

Mechanisms read: ${DETAILS}.

**Why this is filed by a daily probe and not the restore drill.** \`restore-test.yml\` asserts the same freshness correctly, but monthly — and in October 2026 the schedules were deleted on the 12th while the drill's last run was the 3rd, so a total absence of backups went unreported for 13 days and would have reached 29. See #2329. This probe exists to make that interval a day.

**What it does NOT claim.** Nothing about whether a backup, once found, actually restores. That is the drill's job and this probe deliberately does not duplicate it.

This issue closes itself once a recent backup exists."
fi

if [ -n "$EXISTING" ]; then
    echo "[backup-exists] commenting on existing issue #${EXISTING}"
    "$GH" issue comment "$EXISTING" --repo "$REPO" --body "$BODY"
else
    echo "[backup-exists] filing a new issue"
    "$GH" issue create --repo "$REPO" --title "$TITLE" --body "$BODY"
fi

# Deliberately 0 — the issue is the signal. See the header.
exit 0
