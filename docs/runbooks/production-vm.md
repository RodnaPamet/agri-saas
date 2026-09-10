# Runbook — Production VM (`agrent`)

> **This is the production runbook.** Four axes — deploy, rollback,
> scaling, backup/restore — with the commands, not a summary of them.
>
> Production is **one GCE VM running Docker Compose**. There is no
> cluster, no Helm release, no managed database and no autoscaler. If a
> document tells you to run `helm`, `kubectl` or `aws`, it is describing
> a deployment this product has never had — see
> [What this deployment does not have](#what-this-deployment-does-not-have).
>
> **How you found out about this incident: a human noticed.** Nothing
> here detects an outage. There is no uptime check, no alert, no pager
> and no rota — verified 2026-09-10 and tracked as **#854**. If you are
> reading this because a monitor fired, the monitor is not one of ours.
> Every procedure below starts its clock the moment you start; the
> interval before that is unmeasured, and `docs/slos.md` SLO 7's
> 4 hours is time-to-restore, not time-to-recover.
>
> Summary table: `docs/deployment.md` §
> "Kubernetes (Helm) — NOT the production path". Backup/restore detail:
> `docs/backup-restore.md`. Migration rollback detail:
> `deploy/rollback/README.md`.

---

## 0. What production is, and how to confirm it in 60 seconds

| | value |
|---|---|
| GCP project | `hazel-design-419410` |
| Instance | `agrent`, zone `europe-west1-b` |
| Machine type | `e2-standard-4` — 4 vCPU, 15 GiB RAM |
| Boot disk | 80 GB `pd-balanced` — **the database lives on it** |
| Stack dir | `/opt/agrent` (`docker-compose.vm.yml`, `.env`, `Caddyfile`) |
| Public origins | `https://app.agrent.bg` and `https://35-187-80-26.sslip.io` (same Caddy site block, same app) |
| Images | `ghcr.io/rodnapamet/agri-saas` — tags `:latest` and `:sha-<short>` |
| Containers | `agrent-app`, `agrent-worker`, `agrent-db`, `agrent-pgbouncer`, `agrent-redis`, `agrent-caddy`, `agrent-watchtower` |

Docker commands on the VM need `sudo`. `/opt/agrent/.env` and the Redis
`--requirepass` value are real secrets — **never echo them**.

```bash
# What is actually running, and which commit is it?
curl -s https://app.agrent.bg/api/readyz | jq '{status, version, checks}'
# `version` is the full commit SHA, baked in as BUILD_SHA by the
# `Publish image to GHCR` workflow. `"dev"` means the image was NOT built
# by that workflow (a local `docker compose build`), which is itself a finding.
```

```bash
# Container-level view.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker compose -f /opt/agrent/docker-compose.vm.yml ps"
```

```bash
# Full smoke (livez, readyz, health, /login, auth session).
SMOKE_URL=https://app.agrent.bg node scripts/smoke-prod.mjs
```

---

## 1. Deploy

Two things ship independently, and confusing them is the usual reason a
deploy "did not take".

| what changed | who applies it | how long |
|---|---|---|
| **App / worker CODE** (any merge to `main`) | `Publish image to GHCR` builds and pushes `:latest`; **Watchtower** on the VM polls it and recreates `agrent-app` + `agrent-worker` | publish 7–21 min, then ≤ 5 min for the Watchtower poll |
| **Compose STRUCTURE** (a new service, a resource limit, an env key) | **you**, with `deploy/apply.sh` | ~2 min |

Watchtower runs `--label-enable --cleanup --interval 300`. Only `app`
and `worker` carry `com.centurylinklabs.watchtower.enable=true`, so it
never touches `db`, `redis`, `pgbouncer`, `caddy` or itself, and it
never rewrites the compose file.

### 1a. Code deploy (the normal case — nothing to run)

Merge to `main`. Then:

```bash
# Did the image publish? (workflow, then the state question)
gh run list --workflow "Publish image to GHCR" --limit 5
gh run list --workflow "Image tip check" --limit 3
```

`Image tip check` is the one that matters: `Publish image to GHCR` uses
`cancel-in-progress: true`, so GitHub reports a superseded run and a
timed-out run with the same word, `cancelled`. `Image tip check` asks
the registry whether `main`'s tip has an image at all.

```bash
# Has the VM picked it up yet?
curl -s https://app.agrent.bg/api/readyz | jq -r .version   # → commit SHA
git log -1 --format=%H origin/main                          # → should match
```

```bash
# Watchtower's own account of the last poll.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker logs --tail 50 agrent-watchtower"
```

**Every code deploy runs `prisma migrate deploy`** from
`scripts/entrypoint.sh` before Next.js starts. Shipping an image is what
applies a migration. This is the single most important fact in this
runbook and it is why [Rollback](#2-rollback) is a section and not a row.

### 1b. Structural deploy

```bash
# 1. Validate locally first — no VM contact.
DRY_RUN=1 deploy/apply.sh

# 2. Apply. Backs up the remote compose to <file>.bak.<timestamp>, scps
#    the repo file up, `docker compose config`-validates ON THE VM
#    (restoring the backup if that fails), `up -d`, then health-verifies
#    /api/readyz + /manifest.webmanifest + /sw.js and prints a
#    ready-to-paste rollback command.
deploy/apply.sh
```

`/manifest.webmanifest` and `/sw.js` are checked because a deploy that
404s the service worker strands offline-installed mobile clients until
their caches expire.

Overridable: `VM_NAME`, `VM_ZONE`, `REMOTE_DIR`, `COMPOSE_BASENAME`,
`HEALTH_ORIGIN` (defaults to `https://35-187-80-26.sslip.io`, not
`app.agrent.bg` — both resolve to the same app).

`apply.sh` never edits `/opt/agrent/.env` and never echoes it. Env
changes are made on the VM by hand, backed up first
(`<file>.bak.<timestamp>`); `deploy/env.prod.example` lists the required
keys and `tests/guardrails/deploy-env-parity.test.ts` holds it in parity
with `src/env.ts`.

### 1c. Drift

`apply.sh` synchronises **`docker-compose.vm.yml` only**. `Caddyfile`
and `.env` live on the VM and are not copied by it.

```bash
deploy/check-drift.sh    # 0 = in sync, 1 = drift, 2 = could not reach the VM
```

Exit 2 is **not** a pass — it means the question was not answered. On
exit 1, reconcile the VM's change back INTO the repo file and commit it;
do not hand-edit the VM to match.

**Nothing checks the Caddyfile.** `check-drift.sh` sha256-compares
`docker-compose.vm.yml` and only that, and `apply.sh` copies only that,
so a hand-edit to `/opt/agrent/Caddyfile` is invisible to every check in
this repo. Diff it by hand whenever you touch either copy:

```bash
gcloud compute ssh agrent --zone europe-west1-b \
  --command "sudo cat /opt/agrent/Caddyfile" | diff - deploy/Caddyfile
```

One difference is known and intentional as of 2026-09-10: the live ACME
contact defaults to a personal address and `deploy/Caddyfile` records the
role address `admin@agrent.bg` instead. **This repository is public — the
fix is to change the VM, never to copy the live value into the repo.**
Every other directive matches. `deploy/Caddyfile`'s header carries the
full note.

---

## 2. Rollback

**Read this before you roll anything back.** Note first that you are
here because a person noticed, not because anything paged (#854) — so
the deploy that caused this may be hours old, not minutes. Check
`gh run list --workflow='Publish image to GHCR' --limit=10` before
assuming the newest build is the guilty one.

A deploy here has two halves that roll back at different speeds:

- **Code** — reverted by pointing the app + worker at the previous
  image. Minutes.
- **Schema** — `prisma migrate deploy` ran from `scripts/entrypoint.sh`
  when the new image started, before Next.js. Pinning the image back
  does **not** un-run it.

So the shape of the incident decides the lever:

| the bad deploy… | rollback |
|---|---|
| shipped no migration, or an **additive** one (new nullable column, new table) | [2a — pin the image back](#2a-pin-the-image-back). The old code ignores the new column. |
| **renamed** a table / column / enum value, **dropped** or narrowed a column, or rewrote persisted data | [2b — apply the down-migration, then pin back](#2b-down-migration-then-pin-back). A pin alone puts the old image in front of a schema it cannot query — it does not degrade, it fails outright. |
| corrupted or destroyed data, and no down-migration exists | [2c — snapshot restore](#2c-snapshot-restore-last-resort). Costs up to 24 h of farm data. Last resort. |

```bash
# Which migrations did the current image apply, and when?
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker exec -i agrent-db sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \
   \"SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 10;\"'"
```

Cross-check those names against `ls deploy/rollback/` — a `.down.sql`
whose name matches a migration in that list is a signal the migration
was destructive enough that someone wrote an inverse for it.

### 2a. Pin the image back

The image tag is `sha-<7-char short SHA>` of the commit that built it
(`docker/metadata-action`, `type=sha,prefix=sha-,format=short`). Pick
the last commit you trust:

```bash
git log --oneline -10 origin/main       # → e.g. 25889f6
```

Verify that tag really exists in the registry **before** you pin to it —
from the VM, which holds the GHCR credentials:

```bash
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker buildx imagetools inspect ghcr.io/rodnapamet/agri-saas:sha-25889f6 \
     --format '{{println .Manifest.Digest}}'"
```

> **The previous image is not on the box.** Watchtower runs with
> `--cleanup`, which deletes the superseded image after each update.
> `sudo docker images` will show `:latest` and nothing else to fall back
> to. The rollback always goes through a registry pull.

Then pin, in the repo, and apply — the compose file is canonical and a
hand-edit on the VM is drift the next `apply.sh` silently reverts:

```bash
# 1. In deploy/docker-compose.vm.yml, change BOTH the app and worker
#    services from:
#        image: ghcr.io/rodnapamet/agri-saas:latest
#    to:
#        image: ghcr.io/rodnapamet/agri-saas:sha-25889f6
#
# 2. Push it up.
deploy/apply.sh
```

Pinning to an immutable `sha-` tag is also what stops Watchtower rolling
you straight back forward: it re-checks the tag the container was created
from, and that digest never changes. On `:latest` you would be re-rolled
within 5 minutes.

```bash
# 3. Pull explicitly, then recreate WITHOUT building. Both services
#    carry a `build:` block as a manual escape hatch, and an absent
#    image is exactly the condition under which compose would choose to
#    build one — a ~20 minute rebuild, mid-incident, is not the outcome
#    you want.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "cd /opt/agrent && sudo docker compose -f docker-compose.vm.yml pull app worker && \
   sudo docker compose -f docker-compose.vm.yml up -d --no-build app worker"
```

```bash
# 4. Verify you are on the intended commit, then smoke.
curl -s https://app.agrent.bg/api/readyz | jq -r .version
SMOKE_URL=https://app.agrent.bg node scripts/smoke-prod.mjs
```

**Un-pin deliberately.** A `sha-` pin left in the repo means Watchtower
never ships anything again and nobody is told. Open an issue when you
pin, and revert the compose file to `:latest` in the same PR that fixes
the defect.

### 2b. Down-migration, then pin back

`deploy/rollback/<migration_directory_name>.down.sql` holds hand-written
inverses for the migrations that break the previous image. Read
`deploy/rollback/README.md` before running one — the "Current scripts"
table there records which have actually been **executed** against a
database and which have only been written, and two of them have an
ordering constraint between them.

```bash
# 1. STOP app + worker. DDL under a live app means in-flight queries hit
#    tables mid-rename.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "cd /opt/agrent && sudo docker compose -f docker-compose.vm.yml stop app worker"

# 2. Apply the script against the DIRECT connection, never PgBouncer:
#    this is DDL in one transaction and PgBouncer pools per-transaction.
#    Running it inside the db container IS the direct connection.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker exec -i agrent-db sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" \
     -v ON_ERROR_STOP=1'" < deploy/rollback/<name>.down.sql

# 3. NOW pin the image back — section 2a. Starting the NEW image instead
#    re-applies the forward migration from its entrypoint and puts you
#    exactly where you started.
```

`-v ON_ERROR_STOP=1` is load-bearing: without it `psql` keeps going past
a failed statement, and combined with the script's `BEGIN;`/`COMMIT;`
wrapper you get a rolled-back transaction reported as a successful run.

Each script deletes its own `_prisma_migrations` row on purpose. Leave
that row and a later roll-forward *skips* the migration as
already-applied, putting new code on an old schema — the same outage in
the other direction.

If the migration you need to undo has **no** `.down.sql`, you are in
2c. Writing one under incident pressure, against a production database,
untested, is a worse option than a 24-hour restore.

### 2c. Snapshot restore (last resort)

Full procedure: `docs/backup-restore.md` § "Recovering for real". The
short version and its cost:

- The backup is a **daily GCE disk snapshot** (`agrent-daily-snapshot`,
  02:00 UTC, 14-day retention). There is no transaction-log archive.
- **Restoring loses everything written since the last snapshot — up to
  24 hours.** Before restoring, salvage whatever is still readable from
  the live volume; the snapshot is the floor, not the ceiling.
- The whole disk comes back, `DATA_ENCRYPTION_KEY` included (it is in
  `/opt/agrent/.env`, on the same disk). A pgdata-only copy is **not** a
  complete backup — restored ciphertext without that key is unreadable.

### 2d. Rolling back a structural compose change

Not a code rollback at all. `deploy/apply.sh` backed the remote file up
first and printed the exact command; it looks like:

```bash
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo cp -a '/opt/agrent/docker-compose.vm.yml.bak.<timestamp>' '/opt/agrent/docker-compose.vm.yml' && \
   cd /opt/agrent && sudo docker compose -f docker-compose.vm.yml up -d"
```

That restores the VM but leaves the repo ahead of it — `check-drift.sh`
will now report drift, correctly. Revert the repo file too.

---

## 3. Scaling

**There is nothing to scale horizontally.** One VM, one app container,
one worker container. No HPA, no autoscaler, no replica count. Capacity
is the machine type: `e2-standard-4`, 4 vCPU / 15 GiB.

The levers that exist, cheapest first:

```bash
# 1. Is it actually resource-bound? Look before resizing.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker stats --no-stream; echo; free -h; df -h /"
```

| pressure | lever |
|---|---|
| **Disk** (80 GB, shared by Postgres, uploads, Redis AOF and images) | `sudo docker image prune -a` first — a stale build cache is the usual culprit. Then grow the disk: `gcloud compute disks resize agrent --zone europe-west1-b --size <GB>` followed by an in-VM filesystem grow. Disks grow only; they never shrink. |
| **CPU / RAM** | Resize the machine type. It requires a **stop → change → start**, i.e. real downtime, and Postgres is on the boot disk so the database goes with it: `gcloud compute instances stop agrent --zone europe-west1-b`, `gcloud compute instances set-machine-type agrent --zone europe-west1-b --machine-type <type>`, `gcloud compute instances start agrent --zone europe-west1-b`. Take a snapshot first. |
| **DB connections** | PgBouncer is already in transaction-pooling mode: `DEFAULT_POOL_SIZE: 25`, `MAX_CLIENT_CONN: 200`, `MAX_DB_CONNECTIONS: 50` in `deploy/docker-compose.vm.yml`. Raising them is a structural change → §1b. |
| **Redis memory** | `--maxmemory 512mb --maxmemory-policy noeviction`. `noeviction` is a **BullMQ requirement** — jobs must not be evicted — so at 100% Redis starts *rejecting writes* and enqueues fail. Raise `--maxmemory` in the compose file (§1b) rather than changing the policy. |
| **Queue throughput** | One worker container runs both the scheduler and the worker (`node dist/scheduler.mjs && node dist/worker.mjs`). A second worker replica is not currently a supported shape — the scheduler would run twice. Treat "add workers" as a change that needs design, not a runbook step. |

---

## 4. Backup & restore

**Owner runbook: `docs/backup-restore.md`.** It covers both stacks in
the project, the drill, and the drill's history. What an on-call
engineer needs to hold in their head:

- One disk, one zone, no replica, no managed database. Everything —
  Postgres, uploads, Redis AOF, `.env` — is on the `agrent` boot disk.
- Backup is a **GCE snapshot schedule** on that disk:
  `agrent-daily-snapshot`, daily 02:00 UTC, 14-day retention, `eu`
  multi-region storage, `keep-auto-snapshots` (deleting the disk does
  not delete the backups).
- **RPO is up to 24 hours — target and achieved.** `docs/slos.md`
  SLO 6 states 24 hours as the objective; the 1-hour target it used to
  carry was retired on 2026-09-10 (#842) because nothing was funded to
  meet it. Tightening it needs continuous WAL archiving or a managed
  Postgres, neither of which is deployed. Know the real number before
  an incident, not during one.
- Snapshots are **crash-consistent**, not application-consistent —
  Postgres replays WAL on start. That is a supported recovery mode and
  the drill exercises it on purpose.

```bash
# Is the schedule still attached? A detached resource policy stops all
# backups with no error anywhere.
gcloud compute disks describe agrent --zone europe-west1-b \
  --format='value(resourcePolicies)'

# What snapshots exist?
gcloud compute snapshots list --filter='sourceDisk~/agrent$' \
  --sort-by=~creationTimestamp \
  --format='table(name,status,creationTimestamp,storageBytes)'
```

The restore path is drilled monthly by
`infra/scripts/restore-test-gcp.sh` via
`.github/workflows/restore-test.yml` — it boots a real Postgres over the
recovered data directory rather than checking that a snapshot exists.
**Exit 75 means NOT TESTED** (every zone out of capacity), not "restore
failed"; re-run it rather than opening an incident.

---

## What this deployment does not have

Reach for one of these in an incident and you lose the window. Named
here because other documents in this repo still describe them, and
because a runbook that only says what to do leaves the reader to
discover what does not exist at the worst moment.

| not deployed | what to use instead |
|---|---|
| Kubernetes / EKS, Helm releases, `helm rollback`, `kubectl` | [§2 Rollback](#2-rollback) — pin the image, then `deploy/apply.sh` |
| AWS anything — RDS, PITR, ElastiCache, S3, Secrets Manager | one Postgres container on the VM disk; [§4](#4-backup--restore) |
| Point-in-time recovery / transaction-log archive | daily disk snapshot only — RPO up to 24 h |
| Prometheus, Grafana, Alertmanager, PagerDuty **running anywhere** | `infra/alerts/` and `infra/dashboards/` are files in this repo. Verified 2026-09-10: the VM runs seven containers and none of them is an observability component; `/opt/agrent/.env` carries no OTLP, Sentry or PagerDuty key, so the OTel metrics the app emits have nowhere to go; and the GCP project has zero Cloud Monitoring uptime checks. **Nothing pages anyone. Detection today is a human noticing** — or `Image tip check` / `restore-test.yml` going red, neither of which watches production. Tracked as **#854**; until it closes, no document in this repo may describe a detection time. |
| A staging environment | there is none; `main` goes to production |
| Horizontal scaling of any kind | [§3 Scaling](#3-scaling) |

`docs/incident-response.md` carries seven per-symptom playbooks. Its
**App Down** and **Rollback** playbooks and its correction banner are
current; its other triage sections still describe the EKS/AWS stack and
are being corrected — treat their commands as unverified until that
banner says otherwise.

---

## Revision history

| Date | Change |
|---|---|
| 2026-09-10 | Initial VM runbook (#842). Four axes with the actual commands, rollback split into image-only vs schema-affecting vs snapshot, and an explicit inventory of what is not deployed. Values verified against the running VM and the repo, not copied from the EKS runbook this replaces. |
