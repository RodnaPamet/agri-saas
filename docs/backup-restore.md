# Backup & restore — the production VMs

**Owner:** whoever is on call. **Last reviewed:** 2026-08-01.

This is the operator runbook for the production database's backup and
its restore drill. It supersedes the AWS RDS story that
`docs/slos.md` and `docs/incident-response.md` used to describe —
see [What changed](#what-changed-on-2026-08-01) at the bottom.

---

## What production actually is

**Two independent stacks**, both in `europe-west1-b` of project
`hazel-design-419410`, each a single GCE instance running Docker
Compose with Postgres in a local Docker volume on the instance's boot
disk:

| | `agrent` | `inflect-compliance` |
|---|---|---|
| Image | `ghcr.io/inflect-compliance/**agri-saas**` | `ghcr.io/inflect-compliance/**inflect-compliance**` |
| Built by | **this repo** | a different repo |
| Host | `35-187-80-26.sslip.io` | `inflect.34-140-180-255.sslip.io` |
| Stack dir | `/opt/agrent` | `/opt/inflect` |
| PG volume | `agrent-pgdata` | `inflect_pgdata` |
| PG image | `agrent-db:local` (postgis+pgvector) | `postgres:16-alpine` |
| Encryption key in | `/opt/agrent/.env` | `/opt/inflect/.env.prod` |
| Disk | 80 GB `pd-balanced` | 50 GB `pd-balanced` |

They are **separate products that happen to share a GCP project**, not
two deployments of one codebase. This repo cannot affect the
`inflect-compliance` stack — its Watchtower watches an image this repo
never pushes to. It is documented and drilled here only because the
backup tooling lives here.

Neither has a managed database or a replica. For each, **everything is
on one disk in one zone.**

## The backups

A GCE **snapshot schedule** attached to each disk:

| Property | `agrent` | `inflect-compliance` |
|---|---|---|
| Resource policy | `agrent-daily-snapshot` | `inflect-daily-snapshot` |
| Cadence | Daily, 02:00 UTC | Daily, 02:30 UTC (staggered) |
| Retention | 14 days | 14 days |
| Storage location | `eu` (multi-region — survives a zone loss) | same |
| On source-disk delete | `keep-auto-snapshots` — deleting the disk does **not** delete the backups | same |

```bash
# Is the schedule attached? (repeat for inflect-compliance)
gcloud compute disks describe agrent --zone europe-west1-b \
  --format='value(resourcePolicies)'

# What snapshots exist?
gcloud compute snapshots list --sort-by=~creationTimestamp \
  --format='table(name,status,storageBytes,sourceDisk.basename())'
```

### What this buys, and what it does not

- **RPO is up to 24 hours.** The snapshot is daily and there is no
  transaction-log archive, so a failure at 01:59 UTC loses nearly a
  full day of work. `docs/slos.md` states a 1-hour RPO target; that
  target is **not met** and is retained as something to build toward.
- **The snapshot is crash-consistent, not application-consistent.** It
  captures the volume mid-transaction; Postgres replays WAL when it
  starts. This is a supported recovery mode, and the drill below
  exercises it deliberately rather than assuming it.
- **The encryption key rides along.** `DATA_ENCRYPTION_KEY` lives on
  the same disk as the data — `/opt/agrent/.env` for agrent,
  `/opt/inflect/.env.prod` for inflect-compliance — so a whole-disk
  restore recovers key and ciphertext together. Restoring the
  *database* alone somewhere else without that key yields unreadable
  ciphertext. Never treat a pgdata copy as a complete backup. The
  drill asserts the key is present on the restored disk, searching the
  stack directory rather than naming one file, precisely because the
  two stacks put it in differently-named files.

---

## The restore drill

`infra/scripts/restore-test-gcp.sh`. Monthly via
`.github/workflows/restore-test.yml` — which runs it **once per target
from a job matrix** — and runnable by hand any time:

```bash
# agrent (the defaults)
GCP_PROJECT=hazel-design-419410 GCP_ZONE=europe-west1-b \
SOURCE_DISK=agrent \
  ./infra/scripts/restore-test-gcp.sh

# inflect-compliance
GCP_PROJECT=hazel-design-419410 GCP_ZONE=europe-west1-b \
SOURCE_DISK=inflect-compliance SNAPSHOT_SCHEDULE=inflect-daily-snapshot \
PGDATA_VOLUME=inflect_pgdata STACK_DIR=/opt/inflect \
PG_IMAGE=postgres:16-alpine \
  ./infra/scripts/restore-test-gcp.sh
```

The drill deliberately does **not** parse credentials out of the
stack's config — the two stacks spell them differently (env file vs
compose keys with `${VAR:-default}` interpolation). It asks the
restored cluster which role and database actually exist. A mis-parsed
role reports `role does not exist`, which reads like a corrupt backup
when the backup is fine.

It takes ~10 minutes and costs a few cents. What it does:

1. Asserts the snapshot **schedule is still attached** to the disk —
   a detached resource policy stops all backups with no error anywhere.
2. Asserts the newest snapshot is **< 26h old** (`MAX_SNAPSHOT_AGE_HOURS`).
3. Creates a disk from that snapshot.
4. Boots a throwaway VM with **no service account and no scopes** — it
   briefly holds a copy of production data, so it gets no GCP identity.
5. Mounts the disk and starts a real Postgres over the recovered data
   directory so WAL recovery actually runs — building agrent's
   `postgis` + `pgvector` image, or pulling whatever `PG_IMAGE` names,
   so the restored cluster's extensions resolve.
6. Runs the validation battery: `SELECT 1`; `Tenant` and `User`
   readable; `_prisma_migrations` non-empty; recent `AuditLog` rows;
   `tenant_isolation` policies present in `pg_policies`; `app_user`
   role present.
7. Deletes the VM and the disk **from a trap**, on every exit path.

If it is killed hard, check for leaks:

```bash
gcloud compute instances list --filter='name~restore-test-'
gcloud compute disks list --filter='name~restore-test-'
```

### Running it from CI

CI needs credentials for the production project. Configure Workload
Identity Federation and set two secrets on the `production`
environment — `GCP_WORKLOAD_IDENTITY_PROVIDER` and
`GCP_SERVICE_ACCOUNT` (see the header of `restore-test.yml`).

**Until those exist the monthly workflow fails on purpose**, with a
step summary saying the drill did not run. That is deliberate: a
skipped restore test is indistinguishable from a passing one, and this
repo has been bitten by exactly that (see `CLAUDE.md` → "Green is not
the same as executed"). A red that says *nobody checked the backup* is
correct; a green that means the same thing is not.

---

## Recovering for real

```bash
# 1. Pick the snapshot.
gcloud compute snapshots list --filter='sourceDisk~/agrent$' \
  --sort-by=~creationTimestamp

# 2. FIRST: salvage anything still readable from the live volume —
#    the snapshot is up to 24h stale and is the floor, not the ceiling.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker exec agrent-db pg_dump -U inflect agrent_production | gzip > /tmp/salvage.sql.gz"

# 3. Build a new disk from the snapshot.
gcloud compute disks create agrent-restored-$(date -u +%Y%m%d%H%M%S) \
  --zone europe-west1-b --source-snapshot <SNAPSHOT> --type pd-balanced

# 4. Stop the instance, detach the bad disk, attach the restored one
#    as the boot disk, start. (Or boot a new instance from the disk
#    and re-point DNS.)
```

Then verify the stack: `/api/readyz`, `/manifest.webmanifest`, `/sw.js`
— the same three checks `deploy/apply.sh` health-verifies.

---

## What changed on 2026-08-01

**Neither** production stack had an automated backup of any kind: no
cron, no systemd timer, no snapshot schedule, zero snapshots. The only
dumps anywhere were four ad-hoc pre-deploy `pg_dump`s on agrent from
1–4 July, sitting on the same disk as the database they were backing
up. `inflect-compliance` — 7 tenants, 18 users, audit rows written
that same day — had nothing at all.

It was nearly missed a second time: `CLAUDE.md` describes the
`inflect-compliance` VM as "being retired", and that was read as a
statement of fact rather than of intent. It is a live, separate
product still receiving auto-deploys. **Check what a VM is running
before believing a doc that says it is on its way out.**

Meanwhile a monthly "Restore Test" workflow had been failing since it
was written, and a guard test (`tests/guards/oi-3-backup-restore.test.ts`)
had ~25 green assertions about the shape of an AWS RDS restore script.
Both described infrastructure the product does not run: the workflow
died at the AWS credential step in 12 seconds every time, so the script
it existed to run had **never executed once**.

Fixed by: creating the snapshot schedule, taking an immediate first
snapshot, replacing the AWS drill with `restore-test-gcp.sh`,
re-pointing the workflow at it, and rewriting the guard to describe the
posture actually deployed. The AWS scripts (`restore-test.sh`,
`pg-dump-to-s3.sh`) were retired.

**Still open:** RPO is 24h against a 1h target — closing it needs
continuous WAL archiving or a managed Postgres.
