# Backup & restore — the agrent production VM

**Owner:** whoever is on call. **Last reviewed:** 2026-08-01.

This is the operator runbook for the production database's backup and
its restore drill. It supersedes the AWS RDS story that
`docs/slos.md` and `docs/incident-response.md` used to describe —
see [What changed](#what-changed-on-2026-08-01) at the bottom.

---

## What production actually is

A single GCE instance, `agrent`, in `europe-west1-b` of project
`hazel-design-419410`, running the Docker Compose stack at
`/opt/agrent/`. Postgres keeps its data in the local Docker volume
`agrent-pgdata`, which lives on the instance's 80 GB `pd-balanced`
boot disk. Uploaded files are in `agrent-uploads` on the same disk.

There is no managed database. There is no replica. **Everything is on
one disk in one zone.**

## The backup

A GCE **snapshot schedule** attached to that disk:

| Property | Value |
|---|---|
| Resource policy | `agrent-daily-snapshot` (regional, `europe-west1`) |
| Cadence | Daily, 02:00 UTC |
| Retention | 14 days |
| Storage location | `eu` (multi-region — survives a zone loss) |
| On source-disk delete | `keep-auto-snapshots` — deleting the disk does **not** delete the backups |

```bash
# Is the schedule attached?
gcloud compute disks describe agrent --zone europe-west1-b \
  --format='value(resourcePolicies)'

# What snapshots exist?
gcloud compute snapshots list --filter='sourceDisk~/agrent$' \
  --sort-by=~creationTimestamp
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
- **The encryption key rides along.** `DATA_ENCRYPTION_KEY` lives in
  `/opt/agrent/.env`, on the same disk, so a whole-disk restore
  recovers key and ciphertext together. Restoring the *database* alone
  somewhere else without that key yields unreadable ciphertext. Never
  treat a pgdata copy as a complete backup.

---

## The restore drill

`infra/scripts/restore-test-gcp.sh`. Monthly via
`.github/workflows/restore-test.yml`, and runnable by hand any time:

```bash
GCP_PROJECT=hazel-design-419410 \
GCP_ZONE=europe-west1-b \
SOURCE_DISK=agrent \
  ./infra/scripts/restore-test-gcp.sh
```

It takes ~10 minutes and costs a few cents. What it does:

1. Asserts the snapshot **schedule is still attached** to the disk —
   a detached resource policy stops all backups with no error anywhere.
2. Asserts the newest snapshot is **< 26h old** (`MAX_SNAPSHOT_AGE_HOURS`).
3. Creates a disk from that snapshot.
4. Boots a throwaway VM with **no service account and no scopes** — it
   briefly holds a copy of production data, so it gets no GCP identity.
5. Mounts the disk, builds the production Postgres image
   (`postgis` + `pgvector`), and starts a real Postgres over the
   recovered data directory so WAL recovery actually runs.
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
  "sudo docker exec agrent-db pg_dump -U inflect inflect_production | gzip > /tmp/salvage.sql.gz"

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

Production had **no automated backup of any kind**: no cron, no systemd
timer, no snapshot schedule, zero snapshots. The only dumps on the box
were four ad-hoc pre-deploy `pg_dump`s from 1–4 July, sitting on the
same disk as the database they were backing up.

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
continuous WAL archiving or a managed Postgres. And the drill cannot
run from CI until Workload Identity Federation is configured.
