#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Restore drill — GCS dump → a real Postgres → the validation battery
#
#  Proves the production backup is RESTORABLE, not merely present. A dump
#  nobody has ever restored is a hypothesis, not a backup, and #2337 is the
#  proof that the distinction is not academic: the first version of this
#  backup passed every check it had — non-empty, uploaded size matched,
#  byte-identical round trip, its own TOC parsed — and could not be restored,
#  because `pg_dump` omits the roles its 142 GRANTs name.
#
#  It REPLACES infra/scripts/restore-test-gcp.sh, which drilled a GCE snapshot
#  schedule. That mechanism was deliberately deleted on 2026-10-12 (#2329), so
#  the old drill's first two assertions — schedule attached, newest snapshot
#  fresh — now fail on a mechanism that no longer exists. A monthly drill that
#  is red for a stale reason is worse than no drill: it teaches everyone to
#  ignore the one job whose whole value is being believed.
#
#  ═══ WHY THIS IS SHORTER THAN WHAT IT REPLACES ═══
#
#  The old script created a disk from the snapshot, booted a throwaway VM,
#  attached and mounted the disk, and started Postgres over the recovered data
#  directory so it would perform WAL recovery — which was the crash-consistent
#  snapshot's whole correctness argument.
#
#  A `pg_dump` has no WAL to recover and no disk to boot. It is already
#  application-consistent, which is why it was chosen. So those steps have no
#  analogue, and with them goes a failure family the drill's own history
#  records: the 2026-09-01 run reported `exit 75 — NOT TESTED` because BOTH
#  targets hit `ZONE_RESOURCE_POOL_EXHAUSTED` for a pd-balanced disk. A drill
#  that cannot get hardware cannot report on backups. This one needs none.
#
#  ═══ WHAT IT DOES NOT ASSERT, AND WHO DOES ═══
#
#  FRESHNESS. The old script hard-failed on `MAX_SNAPSHOT_AGE_HOURS`, and the
#  `Backup exists` workflow (#2329) now asks that question DAILY — which is
#  the point of it, because the old monthly cadence was longer than the time
#  the backups took to vanish entirely.
#
#  This matters for one line of the battery below. The AuditLog count is
#  informational, and the reason recorded in the old script was that staleness
#  "is already hard-failed upstream". That justification does not survive the
#  move, so it is restated here honestly: freshness is the daily probe's gate,
#  not this drill's, and the age printed below is information rather than an
#  assertion. The drill answers "does restoring work", which a months-old dump
#  can answer perfectly well.
set -euo pipefail

BUCKET="${BACKUP_BUCKET:?BACKUP_BUCKET is required — see deploy/backup/README.md}"
PREFIX="${BACKUP_PREFIX:-agrent/}"
CONTAINER="${RESTORE_CONTAINER:-restore-drill-pg}"
PG_IMAGE="${PG_IMAGE:?PG_IMAGE is required — built from deploy/postgres/Dockerfile}"
WORK="$(mktemp -d)"

cleanup() {
    # shell-check-ok: a cleanup trap must be best-effort. `docker rm` fails
    # when the container was never created — which is every path that dies
    # before the `docker run` below — and a trap that propagates that failure
    # would overwrite the real exit code with the teardown's, hiding the
    # diagnosis the drill just produced. The fallback here cannot be mistaken
    # for success of anything: nothing downstream reads it, and the drill's
    # verdict has already been decided by the time this runs.
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

say() { echo "  $*"; }
die() { echo "::error::$1"; exit 1; }

echo "── locating the newest dump in gs://${BUCKET}/${PREFIX} ──"

# `*.dump` specifically, not "the newest object". Since #2337 each night
# writes TWO objects with the SAME timestamp, and `.globals.sql` sorts after
# `.dump` — so "newest object" selects the 888-byte roles file. #2338 is that
# same mistake in the daily probe.
if ! LISTING="$(gcloud storage ls "gs://${BUCKET}/${PREFIX}**.dump" 2>"$WORK/err")"; then
    die "could not list dumps in gs://${BUCKET}/${PREFIX}: $(tr '\n' ' ' < "$WORK/err" | cut -c1-200)"
fi
DUMP="$(printf '%s\n' "$LISTING" | grep -E '\.dump$' | sort | tail -1)"
[ -n "$DUMP" ] || die "no *.dump under gs://${BUCKET}/${PREFIX} — there is nothing to restore, which is a BACKUP failure and not a drill failure. See #2329."
GLOBALS="${DUMP%.dump}.globals.sql"
say "dump    : $DUMP"
say "globals : $GLOBALS"

# The load-bearing precondition. A dump without its globals is the #2337
# defect exactly: present, verifiable, and unrestorable. Checked BEFORE
# downloading so the diagnosis names the cause rather than surfacing as 142
# failed GRANTs three steps later.
if ! gcloud storage objects describe "$GLOBALS" --format='value(size)' >/dev/null 2>"$WORK/err"; then
    die "the newest dump has NO globals sibling at ${GLOBALS}. pg_dump omits roles while emitting every GRANT that needs them, so this backup cannot be restored into a clean cluster — it would fail with 42704 role \"app_user\" does not exist. See #2337."
fi

gcloud storage cp --quiet "$DUMP" "$WORK/db.dump"
gcloud storage cp --quiet "$GLOBALS" "$WORK/globals.sql"
DUMP_BYTES="$(stat -c %s "$WORK/db.dump")"
[ "$DUMP_BYTES" -gt 0 ] || die "downloaded dump is zero bytes"

# Age is REPORTED, not gated — see the header. Derived from the object name's
# UTC stamp rather than its GCS mtime, so a re-upload cannot make a stale
# backup look fresh.
STAMP="$(basename "$DUMP" | grep -oE '[0-9]{8}T[0-9]{6}Z' || true)"
if [ -n "$STAMP" ]; then
    ISO="${STAMP:0:4}-${STAMP:4:2}-${STAMP:6:2}T${STAMP:9:2}:${STAMP:11:2}:${STAMP:13:2}Z"
    if AGE_EPOCH="$(date -u -d "$ISO" +%s 2>/dev/null)"; then
        say "age     : $(( ( $(date -u +%s) - AGE_EPOCH ) / 3600 ))h (informational — freshness is the daily Backup exists probe)"
    fi
fi
say "size    : ${DUMP_BYTES} bytes"

echo "── booting a throwaway Postgres on the image production runs ──"
docker run -d --name "$CONTAINER" \
    -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=postgres "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 2
done
docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 || {
    echo "throwaway cluster never became ready — log:"; docker logs --tail 50 "$CONTAINER"; exit 1; }

echo "── restoring: GLOBALS FIRST, then the database ──"
# Order is not a preference. The globals create the roles the dump's GRANTs
# name; reversed, every GRANT fails.
docker cp "$WORK/globals.sql" "$CONTAINER":/tmp/globals.sql
docker cp "$WORK/db.dump" "$CONTAINER":/tmp/db.dump
docker exec "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -f /tmp/globals.sql
docker exec "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -c 'CREATE DATABASE restored'

# `--exit-on-error` is load-bearing. By DEFAULT pg_restore continues past
# errors and exits 0, reporting them only as warnings on stderr — so a restore
# that failed 142 GRANTs would still "succeed". Counting stderr lines is the
# weaker version of this check and it is what I used by hand before writing
# the drill; the flag is what makes the shell's own exit status mean something.
docker exec "$CONTAINER" pg_restore -U postgres -d restored --no-owner --exit-on-error /tmp/db.dump

echo "── validation battery ──"

# Discover the application database FROM THE RESTORED CLUSTER rather than
# assuming a name. Carried over from the old drill, whose comment is still
# the reason: a drill that mis-parses the database reports "does not exist",
# which reads like a corrupt backup when the backup is fine.
q() { docker exec "$CONTAINER" psql -U postgres -d restored -tAc "$1"; }

ONE="$(q 'SELECT 1')"
[ "$ONE" = "1" ] || die "SELECT 1 failed on the restored database"
say "✓ SELECT 1"

# Assigned from the substitution, never `cmd && echo "✓"`. The old script
# carries the scar: `cmd && echo` is not an assertion — under `set -euo
# pipefail` a failing left side short-circuits, prints nothing, and does NOT
# trip errexit, so a missing core table sailed through the drill.
TENANTS="$(q 'SELECT count(*) FROM "Tenant"')"
[ -n "$TENANTS" ] || die "Tenant table unreadable on the restored database"
say "✓ Tenant table reachable (${TENANTS} rows)"
USERS="$(q 'SELECT count(*) FROM "User"')"
[ -n "$USERS" ] || die "User table unreadable on the restored database"
say "✓ User table reachable (${USERS} rows)"

MIGRATIONS="$(q 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL')"
[ "$MIGRATIONS" -gt 0 ] || die "_prisma_migrations is empty — this is a restore of a half-migrated cluster"
say "✓ _prisma_migrations: ${MIGRATIONS} applied"

# RLS survived. Tenant isolation is the product's core security property, so a
# restore that silently loses policies is a breach wearing a green tick.
POLICIES="$(q "SELECT count(*) FROM pg_policies WHERE policyname = 'tenant_isolation'")"
[ "$POLICIES" -gt 0 ] || die "no tenant_isolation policies in pg_policies — RLS did NOT survive the restore"
say "✓ pg_policies: ${POLICIES} tenant_isolation policies"

# The role the policies GRANT to, which is the whole reason the globals object
# exists. Without it the policies are inert and the restore is a false pass.
APP_USER="$(q "SELECT count(*) FROM pg_roles WHERE rolname = 'app_user'")"
[ "$APP_USER" = "1" ] || die "role app_user missing — the globals did not restore, and every RLS policy is inert"
say "✓ pg_roles: app_user present"

# The GRANTs themselves, not just the role. A role can exist while its
# privileges did not land, and that is indistinguishable from a healthy
# restore until an application connects and reads nothing.
GRANTS="$(q "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'app_user'")"
[ "$GRANTS" -gt 0 ] || die "app_user exists but holds ZERO table grants — the restore dropped privileges"
say "✓ role_table_grants: ${GRANTS} grants to app_user"

# Informational. See the header: freshness is the daily probe's gate, not
# this drill's, so a low number here is not a failure — a fresh dump of an
# idle database is not a restore defect.
RECENT="$(q "SELECT count(*) FROM \"AuditLog\" WHERE \"createdAt\" > now() - INTERVAL '14 days'")"
say "ℹ AuditLog rows in the last 14 days: ${RECENT} (informational)"

echo "── RESTORE DRILL PASSED ──"
say "restored $(basename "$DUMP") into a clean cluster: ${MIGRATIONS} migrations, ${POLICIES} policies, ${GRANTS} grants, ${TENANTS} tenants"
