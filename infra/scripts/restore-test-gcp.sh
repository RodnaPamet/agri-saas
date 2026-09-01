#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
#  Restore drill — GCE snapshot → throwaway VM → real Postgres
#
#  Proves the production backup is RESTORABLE, not merely present.
#  A snapshot nobody has ever restored is a hypothesis, not a backup.
#
#  What production actually is (see CLAUDE.md → "Production VM"):
#  a GCE instance running a Docker Compose stack whose Postgres keeps
#  its data in a local Docker volume, i.e. on the instance's boot disk.
#  The backup is a daily GCE snapshot schedule attached to that disk.
#
#  The project runs TWO such stacks, and this drill targets either:
#
#    disk                 stack dir      pg volume        pg image
#    agrent               /opt/agrent    agrent-pgdata    (built: postgis+pgvector)
#    inflect-compliance   /opt/inflect   inflect_pgdata   postgres:16-alpine
#
#  `agrent` runs THIS repo's image (ghcr.io/…/agri-saas);
#  `inflect-compliance` runs a different product from a different repo.
#  They share this drill because they share the project and the backup
#  mechanism — not because they share code.
#
#  This script:
#    1. asserts the snapshot SCHEDULE is still attached to the disk
#       (a detached policy silently stops all backups);
#    2. asserts the newest snapshot is FRESH (default < 26h);
#    3. creates a disk from that snapshot;
#    4. boots a throwaway VM, attaches the disk, mounts it;
#    5. starts a real Postgres over the restored data directory —
#       the same image production runs — and lets it perform WAL
#       recovery, which is the crash-consistent snapshot's whole
#       correctness argument;
#    6. runs the validation battery over the recovered cluster;
#    7. deletes the VM and the disk from a trap, always.
#
#  It replaced infra/scripts/restore-test.sh, which drilled AWS RDS
#  point-in-time recovery — infrastructure this product does not run.
#  That script was never executed once: the workflow that called it
#  died at the AWS credential step every time, because the AWS
#  account it assumed does not exist.
#
#  REQUIRED ENV
#    GCP_PROJECT              e.g. hazel-design-419410
#    GCP_ZONE                 e.g. europe-west1-b
#    SOURCE_DISK              e.g. agrent
#  OPTIONAL ENV
#    SNAPSHOT_SCHEDULE        resource policy name  (default agrent-daily-snapshot)
#    MAX_SNAPSHOT_AGE_HOURS   freshness bound       (default 26)
#    PGDATA_VOLUME            Docker volume holding PGDATA (default agrent-pgdata)
#    STACK_DIR                compose + env dir     (default /opt/agrent)
#    PG_IMAGE                 image to run over the restored dir; empty
#                             builds agrent's postgis+pgvector image
#    DB_NAME / DB_USER        first candidates only — the drill asks the
#                             RESTORED CLUSTER which role and database
#                             actually exist and uses those
#    RESTORE_MACHINE_TYPE     (default e2-medium)
#
#  Run it from any authenticated shell:
#    # agrent (defaults)
#    GCP_PROJECT=hazel-design-419410 GCP_ZONE=europe-west1-b \
#    SOURCE_DISK=agrent ./infra/scripts/restore-test-gcp.sh
#
#    # inflect-compliance
#    GCP_PROJECT=hazel-design-419410 GCP_ZONE=europe-west1-b \
#    SOURCE_DISK=inflect-compliance SNAPSHOT_SCHEDULE=inflect-daily-snapshot \
#    PGDATA_VOLUME=inflect_pgdata STACK_DIR=/opt/inflect \
#    PG_IMAGE=postgres:16-alpine ./infra/scripts/restore-test-gcp.sh
# ───────────────────────────────────────────────────────────────
set -euo pipefail

: "${GCP_PROJECT:?GCP_PROJECT is required}"
: "${GCP_ZONE:?GCP_ZONE is required}"
: "${SOURCE_DISK:?SOURCE_DISK is required}"

SNAPSHOT_SCHEDULE="${SNAPSHOT_SCHEDULE:-agrent-daily-snapshot}"
MAX_SNAPSHOT_AGE_HOURS="${MAX_SNAPSHOT_AGE_HOURS:-26}"
PGDATA_VOLUME="${PGDATA_VOLUME:-agrent-pgdata}"
STACK_DIR="${STACK_DIR:-/opt/agrent}"
# Empty ⇒ build agrent's postgis+pgvector image, which the restored
# cluster's extensions need. Other stacks name a stock image to pull.
PG_IMAGE="${PG_IMAGE:-}"
# First candidates only. The drill asks the RESTORED CLUSTER which role
# and database exist and uses those — parsing them out of the stack's
# config is unreliable across stacks (env file vs compose keys, with
# ${VAR:-default} interpolation in the latter), and a mis-parsed role
# reports "role does not exist", which reads like a corrupt backup.
DB_NAME="${DB_NAME:-inflect_production}"
DB_USER="${DB_USER:-postgres}"
RESTORE_MACHINE_TYPE="${RESTORE_MACHINE_TYPE:-e2-medium}"

# Timestamped + collision-proof, so two concurrent runs cannot fight
# over a name and a leaked resource is traceable to its run.
TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
# The VM and the restored disk MUST NOT share a name: `instances
# create` implicitly names the new boot disk after the instance, so
# identical names collide with "the disk resource is already being
# used by instance ...". Found by running this drill, which is the
# point of running it.
RESTORE_DISK_ID="restore-test-disk-${TIMESTAMP}"
RESTORE_VM_ID="restore-test-vm-${TIMESTAMP}"

# ── Zone candidates ────────────────────────────────────────────
# A persistent disk is ZONAL, but a snapshot is not bound to a zone, so a
# restore can land in any zone of the same region. Pinning one zone is what
# made 2026-09-01 (run 33491345028) fail: BOTH targets got
# ZONE_RESOURCE_POOL_EXHAUSTED for a pd-balanced disk in europe-west1-b, on
# the FIRST scheduled run of this drill. Nothing was wrong with the backups —
# the drill had already proved the schedule was attached and the newest
# snapshot 6h old — and there was no second zone to try.
#
# Every candidate must share GCP_ZONE's region: snapshots here carry an `eu`
# storage location, and a cross-region restore would either fail or quietly
# cost egress. A wrong entry is a loud failure, not a silent one.
GCP_REGION="${GCP_ZONE%-*}"
if [ -z "${RESTORE_ZONES:-}" ]; then
    # Derive siblings only from a zone that actually looks like `region-x`.
    # A zone name without a suffix (tests pass a placeholder) yields itself and
    # nothing else, rather than three fabricated names.
    case "${GCP_ZONE}" in
        *-*) RESTORE_ZONES="${GCP_ZONE} ${GCP_REGION}-b ${GCP_REGION}-c ${GCP_REGION}-d" ;;
        *)   RESTORE_ZONES="${GCP_ZONE}" ;;
    esac
fi
_ZONES=""
for _z in ${RESTORE_ZONES}; do
    # The configured zone is authoritative — it is in its own region by
    # definition. Only ADDITIONAL candidates are checked, because a
    # cross-region restore would either fail on the snapshot's `eu` storage
    # location or quietly cost egress.
    if [ "${_z}" != "${GCP_ZONE}" ]; then
        case "${_z}" in
            "${GCP_REGION}"-*) ;;
            *)
                printf '\n\033[31m✗ RESTORE_ZONES entry %s is not in region %s\033[0m\n' \
                    "${_z}" "${GCP_REGION}" >&2
                exit 1
                ;;
        esac
    fi
    case " ${_ZONES} " in *" ${_z} "*) continue ;; esac
    _ZONES="${_ZONES}${_z} "
done
RESTORE_ZONES="${_ZONES% }"

# The zone the throwaway resources actually live in. Starts as the configured
# one and moves if a zone is exhausted; cleanup and every later step read THIS
# rather than GCP_ZONE, or a fallback would leak a disk holding production
# data in a zone nothing deletes from.
ACTIVE_ZONE="${GCP_ZONE}"

GC="gcloud --project=${GCP_PROJECT} --quiet"

log() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Cleanup, always ────────────────────────────────────────────
# Runs on success, on failure, and on interrupt. The VM must go first
# (it holds the disk). Failures here are reported but never mask the
# original exit code.
cleanup() {
    local rc=$?
    log "cleanup — removing throwaway VM + restored disk"
    ${GC} compute instances delete "${RESTORE_VM_ID}" --zone "${ACTIVE_ZONE}" 2>/dev/null \
        || echo "  (no VM ${RESTORE_VM_ID} to delete)"
    ${GC} compute disks delete "${RESTORE_DISK_ID}" --zone "${ACTIVE_ZONE}" 2>/dev/null \
        || echo "  (no disk ${RESTORE_DISK_ID} to delete)"
    exit $rc
}
trap cleanup EXIT INT TERM

# ── 1. The schedule is still attached ──────────────────────────
# A snapshot schedule is a resource POLICY attached to a disk. Detach
# it and backups stop with no error anywhere — the failure mode this
# whole drill exists to catch early.
log "1/5  asserting snapshot schedule '${SNAPSHOT_SCHEDULE}' is attached to disk '${SOURCE_DISK}'"
# A failed API call and a genuinely detached schedule are DIFFERENT
# ANSWERS and must not collapse into one. `2>/dev/null || true` used to
# turn a permission error, an IAM propagation delay or a wrong zone into
# an empty string, which failed the substring test below and printed
# "Production is running WITHOUT automated backups" — the single most
# alarming sentence in this script — on a stack whose backups were fine.
# That happened on 2026-08-21 (issue #663) and was one message away from
# being reported to an operator as fact. Ask first, and if the question
# itself fails, say THAT.
if ! ATTACHED_POLICIES="$(${GC} compute disks describe "${SOURCE_DISK}" --zone "${GCP_ZONE}" \
    --format='value(resourcePolicies)' 2>&1)"; then
    fail "could not read disk '${SOURCE_DISK}' in zone '${GCP_ZONE}', so the backup
     schedule could NOT be checked. This is not evidence that backups are
     missing — it is evidence the check could not run. gcloud said:
       ${ATTACHED_POLICIES}"
fi
if [[ "${ATTACHED_POLICIES}" != *"${SNAPSHOT_SCHEDULE}"* ]]; then
    fail "snapshot schedule '${SNAPSHOT_SCHEDULE}' is NOT attached to disk '${SOURCE_DISK}'.
     Production is running WITHOUT automated backups. Re-attach with:
       gcloud compute disks add-resource-policies ${SOURCE_DISK} \\
         --zone ${GCP_ZONE} --resource-policies ${SNAPSHOT_SCHEDULE}"
fi
echo "  ✓ attached"

# ── 2. The newest snapshot is fresh ────────────────────────────
log "2/5  finding newest READY snapshot of '${SOURCE_DISK}'"
# Same distinction as step 1: "the list came back empty" and "the list
# call failed" are different facts, and only the first one means there is
# nothing to restore.
if ! SNAPSHOT_JSON="$(${GC} compute snapshots list \
    --filter="sourceDisk~/${SOURCE_DISK}\$ AND status=READY" \
    --sort-by=~creationTimestamp --limit=1 \
    --format='value(name,creationTimestamp)' 2>&1)"; then
    fail "could not LIST snapshots for disk '${SOURCE_DISK}', so it is unknown
     whether a restore point exists. gcloud said:
       ${SNAPSHOT_JSON}"
fi
[[ -n "${SNAPSHOT_JSON}" ]] || fail "no READY snapshot found for disk '${SOURCE_DISK}' — there is nothing to restore."

SNAPSHOT_NAME="$(echo "${SNAPSHOT_JSON}" | awk '{print $1}')"
SNAPSHOT_CREATED="$(echo "${SNAPSHOT_JSON}" | awk '{print $2}')"
SNAPSHOT_AGE_HOURS=$(( ( $(date -u +%s) - $(date -u -d "${SNAPSHOT_CREATED}" +%s) ) / 3600 ))
echo "  newest: ${SNAPSHOT_NAME} (created ${SNAPSHOT_CREATED}, ${SNAPSHOT_AGE_HOURS}h old)"
if (( SNAPSHOT_AGE_HOURS > MAX_SNAPSHOT_AGE_HOURS )); then
    fail "newest snapshot is ${SNAPSHOT_AGE_HOURS}h old, over the ${MAX_SNAPSHOT_AGE_HOURS}h bound.
     The schedule is attached but not producing — check the policy's daily window."
fi
echo "  ✓ fresh"

# ── 3. Disk from snapshot ──────────────────────────────────────
# The 09-01 stderr is pasted verbatim into
# tests/unit/restore-drill-error-reporting.test.ts. Read these patterns
# against it rather than against a paraphrase: gcloud prints BOTH a machine
# `code:` line and a human `localizedMessage`, and only the first carries
# ZONE_RESOURCE_POOL_EXHAUSTED. A classifier matching only the code works
# until gcloud reformats — and the fall-through is the exact misreport this
# change exists to prevent: a capacity abort announced as "the production
# backup did not restore cleanly".
is_capacity_error() {
    case "$1" in
        *ZONE_RESOURCE_POOL_EXHAUSTED*|*RESOURCE_POOL_EXHAUSTED*) return 0 ;;
        *"does not have enough resources"*)                       return 0 ;;
        *"is currently unavailable in"*)                          return 0 ;;
        *"currently unavailable"*)                                return 0 ;;
        *)                                                        return 1 ;;
    esac
}

# Provision the restored disk AND the throwaway VM in one zone.
#
# They move together on purpose. `e2-medium` can be the exhausted half while
# pd-balanced is fine, and looping only the disk create would strand a
# restored disk — holding a copy of production data — in a zone the VM could
# not boot in.
#
# Returns 0 on success, 75 when THIS zone is out of capacity (try the next),
# and fails hard on anything else: an IAM error or a missing snapshot is a
# real problem and must not be retried into a confusing multi-zone trace.
provision_in_zone() {
    local zone="$1" err rc

    if ! err="$(${GC} compute disks create "${RESTORE_DISK_ID}" \
        --zone "${zone}" \
        --source-snapshot "${SNAPSHOT_NAME}" \
        --type pd-balanced 2>&1 >/dev/null)"; then
        if is_capacity_error "${err}"; then
            echo "  ○ ${zone}: no pd-balanced capacity"
            return 75
        fi
        printf '%s\n' "${err}" >&2
        fail "could not create the restore disk in ${zone}, and it is not a capacity problem."
    fi
    # The disk exists from here, so the cleanup trap must be able to find it.
    ACTIVE_ZONE="${zone}"

    if ! err="$(${GC} compute instances create "${RESTORE_VM_ID}" \
        --zone "${zone}" \
        --machine-type "${RESTORE_MACHINE_TYPE}" \
        --image-family ubuntu-2404-lts-amd64 \
        --image-project ubuntu-os-cloud \
        --boot-disk-size 20GB \
        --no-service-account --no-scopes \
        --disk "name=${RESTORE_DISK_ID},device-name=restored,mode=rw,auto-delete=no" \
        --metadata-from-file startup-script=/dev/stdin 2>&1 >/dev/null <<'STARTUP'
#!/usr/bin/env bash
# Install docker up-front so the SSH step below doesn't race apt.
set -eux
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io
touch /var/log/restore-drill-ready
STARTUP
    )"; then
        rc=1
        if is_capacity_error "${err}"; then rc=75; fi
        # The disk landed but the VM did not. Remove it before trying the next
        # zone, or every exhausted zone leaks one.
        ${GC} compute disks delete "${RESTORE_DISK_ID}" --zone "${zone}" 2>/dev/null || true
        ACTIVE_ZONE="${GCP_ZONE}"
        if [ "${rc}" -eq 75 ]; then
            echo "  ○ ${zone}: no ${RESTORE_MACHINE_TYPE} capacity"
            return 75
        fi
        printf '%s\n' "${err}" >&2
        fail "could not boot the drill VM in ${zone}, and it is not a capacity problem."
    fi
    return 0
}

# ── 3+4. Disk from snapshot + throwaway VM, in the first zone with room ──
# --no-service-account --no-scopes: the drill VM briefly holds a copy of
# production data, so it gets NO GCP identity — it cannot read a secret, write
# a bucket, or touch another instance even if something on it were
# compromised. It needs egress (image pulls) but nothing opens ingress to it,
# and the trap deletes it either way.
log "3/5  restoring '${SNAPSHOT_NAME}' into a throwaway disk + VM"
echo "  zones to try: ${RESTORE_ZONES}"
PROVISIONED=0
for zone in ${RESTORE_ZONES}; do
    set +e
    provision_in_zone "${zone}"
    prc=$?
    set -e
    if [ "${prc}" -eq 0 ]; then
        PROVISIONED=1
        echo "  ✓ provisioned in ${zone}"
        break
    fi
done

if [ "${PROVISIONED}" -ne 1 ]; then
    # EX_TEMPFAIL, and the distinction is the whole point: every zone in the
    # region was out of capacity, so the drill never got to test anything.
    # Calling that a broken backup is a false alarm that costs someone a
    # night. Calling it success would be worse.
    printf '\n\033[33m⚠ every zone in %s is out of capacity (%s)\033[0m\n' \
        "${GCP_REGION}" "${RESTORE_ZONES}" >&2
    printf '\033[33m  The backup was NOT tested. That is not evidence it is broken:\033[0m\n' >&2
    printf '\033[33m  the schedule and snapshot-freshness checks above both passed.\033[0m\n' >&2
    exit 75
fi
echo "  ✓ created — waiting for startup script"

# ── 5. Mount + boot Postgres over the restored data directory ──
log "4/5  mounting restored disk and starting Postgres over the recovered data dir"

# The restored disk is a byte copy of the production BOOT disk, so the
# Postgres data lives at the Docker volume path inside its filesystem.
REMOTE_SCRIPT=$(cat <<REMOTE
set -euo pipefail
for i in \$(seq 1 60); do [ -f /var/log/restore-drill-ready ] && break; sleep 5; done
[ -f /var/log/restore-drill-ready ] || { echo "startup script never finished"; exit 1; }

sudo mkdir -p /mnt/restored
# Partition 1 is the Ubuntu root filesystem on GCE images.
sudo mount -o rw /dev/disk/by-id/google-restored-part1 /mnt/restored
PGDATA_HOST=/mnt/restored/var/lib/docker/volumes/${PGDATA_VOLUME}/_data
# NOTE the sudo on both probes. /var/lib/docker is mode 0710, so an
# unprivileged \`test -d\` on anything beneath it returns FALSE for a
# path that exists — which reads identically to "the backup has no
# database in it". Found by running the drill.
sudo test -d "\$PGDATA_HOST" || { echo "restored disk has no ${PGDATA_VOLUME} volume at \$PGDATA_HOST"; exit 1; }
sudo test -f "\$PGDATA_HOST/PG_VERSION" || { echo "\$PGDATA_HOST is not a Postgres data directory"; exit 1; }
echo "  data directory found, PG_VERSION=\$(sudo cat \$PGDATA_HOST/PG_VERSION)"

# The encryption key must be in the backup too: a database restored
# WITHOUT it is a pile of unreadable ciphertext (docs/epic-b-encryption.md).
# SEARCH the stack dir rather than naming one file — the two stacks in
# this project keep it in different places (agrent: .env, inflect:
# .env.prod), and pinning a filename made this check fail on a disk
# where the key was in fact perfectly recoverable. Asserts PRESENCE
# ONLY and never prints a value.
STACK_HOST=/mnt/restored${STACK_DIR}
sudo test -d "\$STACK_HOST" || { echo "restored disk has no ${STACK_DIR} — wrong disk, or the stack moved"; exit 1; }
sudo grep -rlq 'DATA_ENCRYPTION_KEY=.\+' "\$STACK_HOST" 2>/dev/null \
    || { echo "no DATA_ENCRYPTION_KEY anywhere under ${STACK_DIR} — encrypted columns would be unrecoverable from this backup"; exit 1; }
echo "  ✓ ${STACK_DIR} present and carries DATA_ENCRYPTION_KEY"

# The Postgres image production runs. agrent needs postgis+pgvector so
# the restored cluster's extensions resolve, and builds it (two layers
# over the official image); other stacks name a stock image to pull.
if [ -n "${PG_IMAGE}" ]; then
    RESTORE_IMAGE="${PG_IMAGE}"
    sudo docker pull "\$RESTORE_IMAGE" >/dev/null
else
    RESTORE_IMAGE=agrent-db:local
    sudo docker build -t "\$RESTORE_IMAGE" - <<'DOCKERFILE'
FROM postgis/postgis:16-3.4
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-pgvector \
    && rm -rf /var/lib/apt/lists/*
DOCKERFILE
fi

# Start Postgres directly on the restored directory. A crash-consistent
# snapshot lands mid-transaction by design; Postgres replays WAL on
# start, and THAT is the property this drill proves.
sudo docker run -d --name restore-pg \\
    -v "\$PGDATA_HOST":/var/lib/postgresql/data \\
    -e POSTGRES_PASSWORD=drill-only-never-persisted \\
    "\$RESTORE_IMAGE" >/dev/null

for i in \$(seq 1 60); do
    if sudo docker exec restore-pg pg_isready >/dev/null 2>&1; then
        echo "  ✓ Postgres accepted connections after WAL recovery (\${i}s)"; break
    fi
    sleep 2
done
sudo docker exec restore-pg pg_isready >/dev/null 2>&1 || {
    echo "restored cluster never became ready — recovery log:"; sudo docker logs --tail 50 restore-pg; exit 1; }

# Discover the superuser and the application database FROM THE RESTORED
# CLUSTER, rather than parsing them out of the stack's config. The two
# stacks spell their config differently (env file vs compose keys, with
# \${VAR:-default} interpolation in the latter), and a drill that
# mis-parses the role reports "role does not exist" — which reads like a
# corrupt backup when the backup is fine. The cluster is the authority.
DB_USER=""
for cand in "${DB_USER}" postgres inflect; do
    [ -n "\$cand" ] || continue
    if sudo docker exec restore-pg psql -U "\$cand" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
        DB_USER="\$cand"; break
    fi
done
[ -n "\$DB_USER" ] || { echo "no usable superuser on the restored cluster (tried ${DB_USER}, postgres, inflect)"; exit 1; }

DB_NAME="${DB_NAME}"
if ! sudo docker exec restore-pg psql -U "\$DB_USER" -d "\$DB_NAME" -tAc 'SELECT 1' >/dev/null 2>&1; then
    DB_NAME="\$(sudo docker exec restore-pg psql -U "\$DB_USER" -d postgres -tAc \
        "SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1') ORDER BY datname LIMIT 1")"
fi
[ -n "\$DB_NAME" ] || { echo "restored cluster has no application database"; exit 1; }
echo "  ✓ restored cluster exposes database '\$DB_NAME'"

psql() { sudo docker exec restore-pg psql -U \${DB_USER} -d \${DB_NAME} -tAc "\$1"; }

echo "── validation battery ──"

# Schema reachable at all.
[ "\$(psql 'SELECT 1')" = "1" ] || { echo "SELECT 1 failed"; exit 1; }
echo "  ✓ SELECT 1"

# Core tables present and readable.
psql 'SELECT count(*) FROM "Tenant"'  >/dev/null && echo "  ✓ Tenant table reachable"
psql 'SELECT count(*) FROM "User"'    >/dev/null && echo "  ✓ User table reachable"

# Migrations applied — catches a restore of a half-migrated cluster.
MIGRATIONS=\$(psql 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL')
[ "\$MIGRATIONS" -gt 0 ] || { echo "_prisma_migrations is empty"; exit 1; }
echo "  ✓ _prisma_migrations: \$MIGRATIONS applied"

# Recent activity — catches a snapshot that is technically valid but
# stale, or restored from a long-dead disk.
RECENT=\$(psql 'SELECT count(*) FROM "AuditLog" WHERE "createdAt" > now() - INTERVAL '"'"'14 days'"'"'')
echo "  ℹ AuditLog rows in the last 14 days: \$RECENT"
[ "\$RECENT" -gt 0 ] || echo "  ⚠ no audit activity in 14 days — verify this matches expected usage"

# RLS survived the restore. Tenant isolation is the product's core
# security property; a restore that loses policies is a breach.
POLICIES=\$(psql "SELECT count(*) FROM pg_policies WHERE policyname = 'tenant_isolation'")
[ "\$POLICIES" -gt 0 ] || { echo "no tenant_isolation policies in pg_policies — RLS did NOT survive"; exit 1; }
echo "  ✓ pg_policies: \$POLICIES tenant_isolation policies"

# The role the policies GRANT to must exist, or RLS is inert.
APP_USER=\$(psql "SELECT count(*) FROM pg_roles WHERE rolname = 'app_user'")
[ "\$APP_USER" = "1" ] || { echo "role app_user missing — RLS policies would be inert"; exit 1; }
echo "  ✓ pg_roles: app_user present"
REMOTE
)

# `instances create` returns when the API call completes, NOT when the
# guest is up: sshd and the metadata-key propagation both land seconds
# to a minute later. Without this wait the first SSH fails with
# "Permission denied (publickey)", which looks exactly like a
# credentials problem and is really a race. (Found by running the
# drill — the AWS script it replaced had `aws rds wait` for the same
# reason and this needs its own equivalent.)
#
# IAP tunnel where the project allows it (no public path to the drill
# VM at all); plain SSH otherwise. The VM needs an external address
# either way — it pulls the Postgres base image — and the project's
# pre-existing default-allow-ssh rule is what makes the fallback work.
SSH_FLAGS=()
log "      waiting for sshd on '${RESTORE_VM_ID}'"
for attempt in $(seq 1 30); do
    if ${GC} compute ssh "${RESTORE_VM_ID}" --zone "${ACTIVE_ZONE}" --tunnel-through-iap \
            --command 'true' >/dev/null 2>&1; then
        SSH_FLAGS=(--tunnel-through-iap); echo "  ✓ reachable over IAP (${attempt} attempts)"; break
    fi
    if ${GC} compute ssh "${RESTORE_VM_ID}" --zone "${ACTIVE_ZONE}" \
            --command 'true' >/dev/null 2>&1; then
        SSH_FLAGS=(); echo "  ✓ reachable over direct SSH (${attempt} attempts)"; break
    fi
    [[ ${attempt} -eq 30 ]] && fail "VM '${RESTORE_VM_ID}' never became SSH-reachable."
    sleep 10
done

${GC} compute ssh "${RESTORE_VM_ID}" --zone "${ACTIVE_ZONE}" "${SSH_FLAGS[@]}" \
    --command "${REMOTE_SCRIPT}" \
    || fail "restore validation FAILED — the newest snapshot did not yield a working database."

# ── 6. Done (cleanup runs from the trap) ───────────────────────
log "5/5  restore drill PASSED"
echo "  snapshot ${SNAPSHOT_NAME} (${SNAPSHOT_AGE_HOURS}h old) restored to a working,"
echo "  WAL-recovered Postgres with migrations, RLS policies and app_user intact."
