# Backup & restore — the production VMs

**Owner:** whoever is on call. **Last reviewed:** 2026-10-25 — both stacks' backup mechanisms were replaced on that date, and both are drilled.

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

**`agrent` is backed up by a nightly `pg_dump` to GCS.** Stood up 2026-10-25
to replace a snapshot schedule retired on 2026-10-12 — see
[the gap](#the-13-day-gap-2026-10-12-to-2026-10-25) below, which is the reason
the daily probe exists.

| Property | value |
|---|---|
| Unit | `agrent-db-backup.timer` → `agrent-db-backup.service` |
| Script | `/usr/local/sbin/agrent-db-backup` (root-only, 0755) — tracked at **`deploy/backup/`**, drift-checked by `deploy/check-drift.sh` |
| Cadence | daily **01:15 UTC**, `Persistent=true`, up to 300 s jitter |
| Destination | `gs://agrent-db-backups-hazel/agrent/YYYY/MM/DD/agrent-<UTC>.dump` **and** `…<UTC>.globals.sql` — see [why two](#why-two-objects-pg_dump-does-not-dump-roles) |
| Format | `pg_dump -Fc` (custom — `pg_restore` takes it directly) |
| Retention | **30 days**, by bucket lifecycle rule. Nothing else deletes. |
| Location | `eu` multi-region — survives the loss of `europe-west1-b` |
| Size | ~2.3 MB + ~900 B per night (54 MB database) |
| Identity | `agrent-db-backup@…` — `objectCreator` + `objectViewer` on this ONE bucket, **nothing at project level** |
| Key | `/etc/agrent-db-backup/sa-key.json`, root:root 0600 |

**Why 01:15 UTC.** An hour after the co-tenant's 00:15 dump, so two `pg_dump`s
never contend for this host's two vCPUs, and well before the 04:40 UTC
`Backup exists` probe — which must read a finished object rather than race the
writer creating it.

**Why a service-account key and not the metadata server.** This VM's default
service account carries the `devstorage.read_only` **scope**, and a scope caps
the token regardless of IAM, so no bucket binding would let it write. Changing
scopes requires the VM **stopped**, which is downtime for both products on this
host. The dedicated account holds neither role that can delete or overwrite, so
**nothing the backup script runs as** can destroy the history.

That is narrower than what stood here, which said a compromised box cannot
destroy the history. It does not follow: the box does not act as that account
for anything else it does. Measured 2026-10-25 —

| | |
| --- | --- |
| VM's own identity | `880736019978-compute@developer.gserviceaccount.com` |
| its project role | `roles/editor` |
| both buckets grant | `legacyObjectOwner` + `legacyBucketOwner` → `projectEditor` |
| what caps it today | the VM's OAuth scope, `devstorage.read_only` |

So the delete protection is a **VM attribute**, not a result of the role
separation: widen that scope for an unrelated reason and it is gone, with
nothing in the script and nothing in the bucket's IAM changing to say so.
#2361 tracks replacing it with a retention policy — the control that does not
depend on who is asking.

**It is application-consistent**, unlike the disk snapshot it replaces — see the
warning at line 69 of the old section below, which this mechanism resolves
rather than inherits.

```bash
# Is it armed, and when does it next run?
systemctl list-timers agrent-db-backup.timer

# Did the last run succeed, and what did it say?
systemctl show agrent-db-backup.service -p Result -p ExecMainStatus
journalctl -u agrent-db-backup.service -n 20

# What exists? (needs the key; the VM's own token cannot read this bucket)
sudo CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=/etc/agrent-db-backup/sa-key.json \
  gcloud storage ls -l 'gs://agrent-db-backups-hazel/**'
```

**Verified end to end on 2026-10-25.** A run is not "uploaded and hoped": it
checks the dump is non-empty, that `pg_restore --list` parses it, that the
uploaded object's size matches, that a re-download is **byte-identical**, and
that the downloaded copy still parses to the same TOC entry count.

```
[agrent-db-backup] OK gs://agrent-db-backups-hazel/agrent/2026/10/25/agrent-20261025T092310Z.dump
                      size=2321429B toc_entries=1833 (local 1833) db=agrent_production
```

### `inflect-compliance` has the same mechanism, since 2026-10-25

This section used to be a warning that the sibling stack had **no backup at
all** — its snapshot schedule went in the same 2026-10-12 sweep and nothing
replaced it. That is no longer true, and the warning is kept in outline only
because the 13-day gap is the reason the daily `Backup exists` probe exists.

| | |
| --- | --- |
| Bucket | `gs://inflect-db-backups-hazel` — `eu` multi-region, UBLA on, `publicAccessPrevention: enforced`, 30-day lifecycle |
| Objects | `inflect/YYYY/MM/DD/inflect-<stamp>.dump` + `.globals.sql` sibling |
| Schedule | `inflect-db-backup.timer`, 02:15 UTC nightly |
| Identity | `inflect-db-backup@…` — `objectCreator` + `objectViewer` on this ONE bucket, **nothing at project level** |
| Key | `/etc/inflect-db-backup/sa-key.json`, root:root 0600 |
| Mechanism in repo | `deploy/backup/inflect-db-backup{,.service,.timer}` |

The scope caveat above applies here identically: that VM runs as the same
project-editor default account and is capped by the same
`devstorage.read_only` scope.

**Its globals half matters more than agrent's.** `pg_dump` omits roles while
emitting every GRANT that needs them, and this database has far more of them:

```
agrent   142 GRANTs
inflect  1010 GRANTs
```

so a dump restored without its `.globals.sql` fails over a thousand times.
Both roles it needs — `app_user` and `postgres` — are the same two agrent's
needs, which is why one battery serves both.

It remains a **different product in a different repository**. The mechanism is
recorded here because the backup tooling lives here and the drill below targets
both — not because the code is shared.

### Why two objects: `pg_dump` does not dump roles

Roles are **cluster**-level, so `pg_dump` omits them while happily emitting
every GRANT that depends on them. Measured on this database:

```
142  GRANT ... TO app_user
  0  CREATE ROLE / ALTER ROLE
251  mentions of app_user in the restorable SQL
```

Restored into a clean cluster, all 142 fail with `42704 role "app_user" does
not exist` — the same error class as #2319, arriving far from its cause and
reading like a permissions bug. **The data would land and the application's own
role would not exist.** The first version of this backup had exactly that
defect: it uploaded cleanly, matched its own size, round-tripped
byte-identically and parsed its own TOC, and was not restorable. Every one of
those checks was about the object; none was about whether it restores.

`pg_dumpall --roles-only` captures the missing half, as a sibling object with
the same timestamp. `--roles-only` rather than `--globals-only` because
tablespaces are unused here and would reference host paths absent on any
restore target.

The check is **derived**: the script extracts every role named by the dump's
own GRANTs and requires the globals to CREATE each one, so a role added to the
schema later cannot be silently missed. A hard-coded `app_user` would pass
forever and miss the next one.

### Restoring — and the rehearsal that proves it works

Restore the globals FIRST. Nothing else creates the roles the GRANTs need.

```bash
# 1. newest dump and its globals (the key; the VM's own token cannot read this)
export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=/etc/agrent-db-backup/sa-key.json
NEW=$(sudo -E gcloud storage ls 'gs://agrent-db-backups-hazel/agrent/**.dump' | sort | tail -1)
sudo -E gcloud storage cp "$NEW" /tmp/d.dump
sudo -E gcloud storage cp "${NEW%.dump}.globals.sql" /tmp/g.sql

# 2. roles, then schema+data, into a throwaway on the SAME image production runs
sudo docker run -d --name restore-check -e POSTGRES_PASSWORD=x agrent-db:local
sudo docker cp /tmp/g.sql restore-check:/tmp/ && sudo docker cp /tmp/d.dump restore-check:/tmp/
sudo docker exec restore-check psql -U postgres -d postgres -f /tmp/g.sql
sudo docker exec restore-check psql -U postgres -c 'CREATE DATABASE restored'
sudo docker exec restore-check pg_restore -U postgres -d restored --no-owner /tmp/d.dump
```

Performed 2026-10-25. `pg_restore` reported **zero** errors, and the battery
against the restored database:

| check | result |
|---|---|
| `app_user` role exists | 1 |
| `tenant_isolation` policies | **93** |
| GRANTs to `app_user` | **554** |
| `Tenant` rows | 4 |
| `User` rows | 8 |
| migrations applied | 326 |
| `AuditLog` rows < 14 days | 283 |

RLS intact, role intact, grants intact, recent data present. That is a
disaster-recovery rehearsal rather than an assertion about an object, and it is
the first one this project has passed since 2026-10-02.

### The 13-day gap (2026-10-12 to 2026-10-25)

Worth keeping, because the failure was not in the backups — it was in the
monitoring, and the same shape can recur against the mechanism above.

The snapshot schedules were **deliberately** torn down on 2026-10-12. The audit
order proves intent rather than accident, since a policy delete fails while it
is still attached:

```
07:57:44–47  v1.compute.disks.removeResourcePolicies   detach from both disks
07:57:50–52  v1.compute.resourcePolicies.delete        delete both schedules
07:58:19+    v1.compute.snapshots.delete  × 60         delete the artefacts
```

Nothing replaced them, and nothing said so for 13 days. `restore-test.yml`
asserts exactly the right thing — schedule attached, newest snapshot under 26h
— and it was **never red**. It was *absent*: it last ran 2026-10-03, and its
next run was 2026-11-01.

```
2026-10-03  drill ran, passed
2026-10-12  teardown
2026-10-25  13 days, nothing reported — found by hand, chasing a different question
2026-11-01  the first run that would have failed
```

A correct check on a monthly cadence cannot see something that disappears
inside the month. That is why the daily **`Backup exists`** probe now asks the
cheap half of the question — "is there a recent backup" — and leaves the
expensive half — "does restoring it work" — to the drill. See #2329.

### What the mechanism was (retired 2026-10-12)

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
  full day of work. `docs/slos.md` SLO 6 states 24 hours as the
  objective too — the 1-hour target it used to carry was **retired** on
  2026-09-10 (#842), not met; SLO 6 keeps the history and the cost of
  tightening it.
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

`infra/scripts/restore-test-dump.sh`, monthly via
`.github/workflows/restore-test.yml` (04:00 UTC on the 1st) and runnable by
hand any time:

```bash
BACKUP_BUCKET=agrent-db-backups-hazel BACKUP_PREFIX=agrent/ \
PG_IMAGE=$(docker build -q deploy/postgres) \
  ./infra/scripts/restore-test-dump.sh
```

It fetches the newest `*.dump`, requires its `*.globals.sql` sibling, restores
**the globals first** into a clean Postgres built from `deploy/postgres/Dockerfile`
— the same image production runs, because the dump carries `postgis`, `vector`
and `pg_trgm` extension objects — and then runs the validation battery:
`SELECT 1`, `Tenant` and `User` readable, migrations applied,
`tenant_isolation` policies present, `app_user` present **and holding table
grants**.

### What it asserts, and what it deliberately does not

It answers **"does restoring work"**. It does **not** gate freshness — the
daily `Backup exists` workflow owns that question (#2329), because a monthly
cadence is what let a total absence of backups go unreported for 13 days. The
age the drill prints is information; a months-old dump can answer the
restorability question perfectly well, and the probe is what says it is old.

Two flags in it are load-bearing and should not be "tidied":

- **`pg_restore --exit-on-error`.** By default `pg_restore` continues past
  errors and exits **0**, reporting them as warnings on stderr. Without the
  flag a restore that failed 142 GRANTs still "succeeds".
- **globals before database.** The globals create the roles the dump's GRANTs
  name. Reversed, every GRANT fails.

### It no longer boots a VM, and that removed a failure family

The previous drill (`infra/scripts/restore-test-gcp.sh`, now **retired** —
see its header) created a disk from a snapshot, booted a throwaway VM, mounted
the disk and let Postgres perform WAL recovery, which was the crash-consistent
snapshot's whole correctness argument. A `pg_dump` has no WAL to recover and no
disk to boot.

So the drill needs no GCE resources at all, which retires the
`exit 75 — NOT TESTED` path: on **2026-09-01** both targets hit
`ZONE_RESOURCE_POOL_EXHAUSTED` for a `pd-balanced` disk and the drill could not
report on the backups at all. A drill that cannot get hardware cannot answer.

### Both stacks are drilled

One matrix, one script, one image; only the bucket and the object prefix differ
per leg:

| leg | bucket variable | prefix |
| --- | --- | --- |
| `agrent` | `BACKUP_BUCKET` | `agrent/` |
| `inflect-compliance` | `INFLECT_BACKUP_BUCKET` | `inflect/` |

`fail-fast: false` is load-bearing and `oi-3-backup-restore` asserts it: with
it unset, one product's restore failing cancels the other's leg mid-run, and a
cancelled leg reports *nothing* about that stack. A drill that turns one
failure into no information about either is worse than one that fails twice.

`inflect-compliance` was removed from this drill on 2026-10-25 because it had
no backup to restore, and added back the same day once it did —
`tests/guards/restore-drill-targets-what-exists.test.ts` is what forced the
second edit. It asserts every stack in the table at the top is either drilled
**or** declared unbacked here, never neither and never both, so recording the
new mechanism above without adding the matrix leg fails the guard. That is the
notification it exists to give, and it worked: this section is the result.

The CI identity `github-restore-test@` was granted `objectViewer` on the
inflect bucket for this, and holds nothing else there — it can read backups to
verify them and cannot write or delete.

## Drill history

`tests/guards/oi-3-backup-restore.test.ts` points readers here for the drill's
last-run record, so it lives here rather than only in the Actions tab.

| date | trigger | outcome |
|---|---|---|
| 2026-07-01 | schedule | **failed — different workflow.** The old AWS RDS drill, dead at `Configure AWS credentials (OIDC)`. It tested infrastructure neither product runs; replaced 2026-08-01. |
| 2026-08-01 | schedule | **failed — same old workflow**, same AWS credential step. |
| 2026-08-21 | manual ×3 | first two failed while the GCP drill was being brought up; **the third PASSED — the first genuine restore verification either stack has ever had.** |
| 2026-09-01 | schedule | **exit 75 — NOT TESTED.** Both targets hit `ZONE_RESOURCE_POOL_EXHAUSTED` for a pd-balanced disk in `europe-west1-b`. The backups were fine: schedule attached and newest snapshot 6h old on both, verified before it stopped. This was the FIRST scheduled run of the current drill, and it is what the zone fallback above exists for. |
| 2026-09-01 | manual | **PASSED on both targets** (run 33512186670), re-run the same afternoon once capacity came back — the correct response to an exit 75. |
| 2026-10-01 | schedule | **failed — a defect in the drill, not in the backup** (run 36851363940, issue #1179). Both targets died at step 4 with `PGDATA_HOST: unbound variable` after a pile of `command not found`. Cause: the remote script was built with an UNQUOTED heredoc, so backticks in its own COMMENTS were command substitutions evaluated on the runner. #990 added a comment with an odd number of them; the unterminated substitution swallowed the rest of the heredoc and ran it locally — `apt-get`, a real `docker build`, then `docker run -v "$PGDATA_HOST"` with the variable unset. No SSH connection was ever opened, so the restore was never attempted and the whole validation battery was unreachable. Fixed by #1212 (escape every backtick in the body) with `tests/guards/shell-heredoc-no-live-backticks.test.ts` to keep it that way, plus `tests/guards/restore-drill-remote-script.test.ts`, which EXECUTES the drill against a stubbed `gcloud` and asserts the payload that reaches the VM is complete and `bash -n`-clean. |

| 2026-10-02 | manual | **PASSED on both targets** (run 36979511033, `12f52f0d` — i.e. main WITH #1212 and #1226). The first green drill since #1179 broke it, and the evidence that the backup itself was never the problem: snapshot restored to a WAL-recovered Postgres with migrations, RLS policies and `app_user` intact. 4m07s (agrent) and 3m40s (inflect-compliance) against `timeout-minutes: 45`. Dispatched rather than scheduled, because `gh run rerun` replays the original commit and could never clear a drill broken by a code defect. **#1225's change to the heredoc landed after this run and has NOT been exercised against real GCP** — the next scheduled run is 2026-11-01. |

Three things that table is here to stop being misread:

- **Do not read the 07-01 and 08-01 rows as this drill failing.** They are a
  different workflow against different infrastructure. `gh run list --workflow
  restore-test.yml` returns both systems under one name, because the file was
  replaced rather than renamed — so a raw conclusion column reads as three
  consecutive failures of one thing when it is two failures of a dead thing and
  one of a new thing.
- **Exit 75 is not a failed restore.** It means every zone in the region was
  out of capacity, so the drill never got to test anything. The job still goes
  red — an unverified restore path deserves attention — but the summary says
  `NOT TESTED`, and the correct response is to re-run it, not to start an
  incident.
- **A drill that fails before step 4 finishes has told you nothing about the
  backup.** 2026-10-01 is the worked example: a red job, two red targets, and
  zero evidence either way, because the failure was in the drill's own string
  building. Read the step log for which of the five steps printed a `✓` before
  deciding whether to be worried. Steps 1 and 2 (schedule attached, snapshot
  fresh) passing is real information even when the rest never ran.
- **`gh run rerun` cannot clear this class.** A re-run replays the ORIGINAL
  commit, so a drill broken by a code defect fails identically forever. Push the
  fix and dispatch the workflow (`gh workflow run restore-test.yml`) once it is
  on `main`.

## Recovering for real

The procedure that stood here listed snapshots, built a disk from one and
swapped boot disks. **None of that is possible** — every snapshot and both
resource policies were deleted on 2026-10-12. Recovery is now restore-the-dump,
and the first step is not the database.

```bash
PROJ=hazel-design-419410

# 0. THE ENCRYPTION KEY, FIRST. Not because it is needed first, but because
#    discovering it is missing AFTER a restore is the worst moment to find out:
#    the rows come back and every encrypted column is unreadable.
gcloud secrets versions access latest \
  --secret=agrent-data-encryption-key --project "$PROJ"
#    (inflect-compliance-data-encryption-key for the other stack.)
#    This goes into the new host's env file as DATA_ENCRYPTION_KEY. It is NOT
#    in the dump and cannot be — a pg_dump carries no environment.

# 1. If the box is still reachable, salvage from the LIVE volume first.
#    The nightly dump is up to 24h stale and is the floor, not the ceiling.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker exec agrent-db pg_dump -Fc -U inflect agrent_production > /tmp/salvage.dump"

# 2. Otherwise take the newest nightly pair. BOTH objects, same timestamp.
gcloud storage ls -l 'gs://agrent-db-backups-hazel/agrent/**' | tail -5
gcloud storage cp gs://agrent-db-backups-hazel/agrent/YYYY/MM/DD/agrent-<TS>.dump        .
gcloud storage cp gs://agrent-db-backups-hazel/agrent/YYYY/MM/DD/agrent-<TS>.globals.sql .

# 3. GLOBALS FIRST, then the database. The other order fails every GRANT with
#    `42704 role "app_user" does not exist` — see the section above.
psql      -U postgres -f agrent-<TS>.globals.sql
pg_restore -U postgres -d agrent_production --exit-on-error agrent-<TS>.dump
```

Then verify the stack: `/api/readyz`, `/manifest.webmanifest`, `/sw.js` — the
same three checks `deploy/apply.sh` health-verifies. `readyz` exercises the
encryption key, so a wrong or missing key fails there rather than silently
serving unreadable columns.

`infra/scripts/restore-test-dump.sh` performs steps 2–3 unattended every month
against a clean Postgres, so the half of this procedure that can be rehearsed
is rehearsed. Step 0 is not covered by that drill — the drill restores schema
and rows, which need no key.

### The key is stored, and what that does and does not protect

| | |
| --- | --- |
| `agrent` | secret `agrent-data-encryption-key` |
| `inflect-compliance` | secret `inflect-compliance-data-encryption-key` |
| replication | user-managed, `europe-west1` + `europe-west4` (two EU regions) |
| source of truth | still the VM's env file — the secret is a DURABLE COPY, not the runtime source |

Each was verified on storage by comparing a SHA-256 of the stored version
against a SHA-256 of what the running container actually reports for
`DATA_ENCRYPTION_KEY` — equality, not presence, because a truncated or
banner-polluted payload stored as the recovery key would look like a backup
and fail only when it was needed.

**This is a durability control, not an access control.** `roles/editor`
includes 18 `secretmanager.*` permissions, and both VMs run as
`880736019978-compute@developer.gserviceaccount.com`, which holds
`roles/editor` project-wide. So the machines' own identity can read **both
products'** keys by IAM; what stops it today is that neither VM carries the
`cloud-platform` OAuth scope — the same class of control that blocks backup
deletion. Widening that scope for any reason, including to have the VM read
this secret at boot, grants a compromised box both keys. That is why the app
still reads its env file and this is only a copy.

### Rotation must update the secret, or the copy goes stale silently

The stored copy is a snapshot of a value that can change. `DATA_ENCRYPTION_KEY`
rotation is supported (`DATA_ENCRYPTION_KEY_PREVIOUS` plus the sweep job), and
a rotation that does not add a new secret version leaves a durable copy of a
key that no longer decrypts anything — the same failure shape as a backup that
quietly stopped, and just as invisible.

`deploy/check-drift.sh` compares the live key's hash against the stored
version's hash for both stacks and fails on mismatch. It is **operator-run, not
scheduled**, so it catches a forgotten rotation at the next drift check rather
than immediately; adding the version is therefore a step in the rotation
procedure, not something to rely on a checker to notice.

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

**Still open:** RPO is 24h, and since 2026-09-10 (#842) that is the
stated objective rather than a missed 1-hour target. Tightening it needs
continuous WAL archiving or a managed Postgres; neither is funded.
Detection is no longer the larger open item — a GCP uptime check and alert
policy have emailed an outage to one address since 2026-09-17 (#854). What
remains is that nobody is paged: response out of hours waits for someone to
read that inbox, accepted as the posture in #981 rather than tracked as a
gap.
