# Incident Response Runbook

> Epic OI-3 — written 2026-04-27 against an intended Kubernetes/EKS +
> AWS deployment. Most of that infrastructure was never provisioned.

> ## ⚠ READ THIS FIRST — most of this document describes a deployment that does not exist
>
> **Production is one GCE VM running Docker Compose** — instance
> `agrent`, zone `europe-west1-b`, project `hazel-design-419410`,
> served at `https://app.agrent.bg`. There is no Kubernetes cluster, no
> Helm release, no RDS, no ElastiCache, no cert-manager, and (verified
> 2026-09-10) no Prometheus, Grafana, Alertmanager or PagerDuty running
> anywhere — `infra/alerts/` and `infra/dashboards/` are files in this
> repo that nothing scrapes or serves. **Nothing pages anyone.**
>
> | section | status |
> |---|---|
> | [1. App Down](#1-app-down) | **corrected (#842)** — VM commands, verified against the running instance |
> | [6. Rollback](#6-rollback) | **corrected (#842)** — VM procedure, verified |
> | Quick reference, Severity, Dashboards, Common first steps | describe PagerDuty / Grafana / Alertmanager that are **not deployed** |
> | 2. Database, 3. Redis, 4. Queue Backlog, 5. Certificate Expiry | `kubectl` / `aws` / `cert-manager` commands against infrastructure that **does not exist** — treat as unverified |
> | [7. Data Breach Response](#7-data-breach-response) | partially corrected in #808; the `AuditLog` and KEK-rotation halves are real, the AWS commands are not |
>
> **The production runbook is `docs/runbooks/production-vm.md`** —
> deploy, rollback, scaling and backup/restore with commands verified
> against the running VM. Backup and restore detail:
> `docs/backup-restore.md`. Migration rollback detail:
> `deploy/rollback/README.md`.
>
> The remaining sections are being corrected rather than deleted: the
> symptom-to-playbook structure is sound and someone who read the old
> version needs to find out it was wrong, not find silence. Correcting
> them is tracked separately, because it also invalidates the alerting
> and dashboard layer this document is built on.

---

## Quick reference

| You see... | Page severity | First-look dashboard | Playbook |
|---|---|---|---|
| External uptime monitor 503 | **CRITICAL** (PagerDuty) | [App Overview](#dashboards) | [App Down](#1-app-down) |
| `ApiP95LatencyCritical` (>2s) | **CRITICAL** | App Overview + Database | [Database Unavailable / Slow](#2-database-unavailable--slow) |
| `DatabaseConnectionPoolExhausted` | **CRITICAL** | Database | [Database Unavailable / Slow](#2-database-unavailable--slow) |
| `RedisMemoryHighCritical` (>95%) | **CRITICAL** | Redis | [Redis OOM / Degraded Queueing](#3-redis-oom--degraded-queueing) |
| `RedisMemoryHighWarning` (>80%) | warning (Slack) | Redis | [Redis OOM / Degraded Queueing](#3-redis-oom--degraded-queueing) |
| `QueueDepthBacklogCritical` (>1000) | **CRITICAL** | BullMQ | [Queue Backlog](#4-queue-backlog) |
| `CertificateExpiryCritical` (<3d) | **CRITICAL** | App Overview | [Certificate Expiry](#5-certificate-expiry) |
| Bad deploy detected (smoke fail / 5xx spike post-merge) | varies | App Overview | [Rollback](#6-rollback) |
| Suspected unauthorised data access | **CRITICAL** + escalate | n/a | [Data Breach Response](#7-data-breach-response) |

**On-call channel**: PagerDuty service `inflect-compliance-prod`. The integration key + Slack webhook live in the cluster's Alertmanager Secret (env-var-substituted via `${PAGERDUTY_SERVICE_KEY}` and `${SLACK_WEBHOOK_URL}` in `infra/alerts/receivers.yml`).

---

## Severity definitions

| Severity | Routing | Response time (acknowledge) | Resolution time budget |
|---|---|---|---|
| **CRITICAL** | PagerDuty page → on-call | 15 minutes | 4 hours (SLO 7 — RTO) |
| **WARNING** | Slack `#alerts-warnings` | Next business day | One sprint |

**Severity is set by the alert rule's `labels.severity` field, not by the responder.** If you need to escalate a warning to critical, file a manual PagerDuty incident referencing the alert.

> **⚠ This table is intended policy, not current behaviour — see #854.**
> The routing column is not deployed: there is no PagerDuty service, no
> Alertmanager, no Slack alert webhook and no rota, so no alert rule
> sets a severity and nothing pages anyone. The 15-minute acknowledge
> budget therefore measures nothing today — **detection is a human
> noticing**, and the interval before that is unbounded. The 4-hour
> resolution budget is real, but it runs from the moment a person
> starts, which is why `docs/slos.md` SLO 7 reads its RTO as
> time-to-restore rather than time-to-recover.

---

## Dashboards

All four are shipped under `infra/dashboards/` and importable via Grafana JSON UI:

| Dashboard | UID | Used for |
|---|---|---|
| API SLOs (pre-OI-3) | `inflect-compliance-slos` | Long-term SLO burn-down — availability + latency + error budget |
| App Overview | `inflect-app-overview` | API health: rate, P95, error rate, top-N slow/failing routes |
| Database (repository layer) | `inflect-database` | Repo-method P95, calls/s, errors by method, result-count distribution |
| Redis / ElastiCache | `inflect-redis` | Queue depth, ElastiCache CPU + memory, hit rate, evictions |
| BullMQ | `inflect-bullmq` | Job throughput, failure rate, queue depth by state, P95 duration |

Every alert annotation carries a `dashboard:` field linking straight to the right one.

---

## Common first steps (every incident)

1. **Acknowledge in PagerDuty** within 15 minutes (silences re-pages, signals to the team that someone owns it).
2. **Open the dashboard** linked from the alert annotation.
3. **Check the deploy timeline**: `gh run list --workflow=Deploy --limit=5`. A new incident immediately after a deploy almost always points at the deploy as cause.
4. **Decide between** mitigation (rollback / scale) vs investigation (debug live):
   - If the issue is **clearly correlated with a deploy** → rollback first, investigate after.
   - If the issue is **not clearly deploy-correlated** → start investigation, keep rollback as a parallel option.
5. **Open an incident channel** in Slack (`#incident-YYYYMMDD-<short-name>`) and post running commentary.

---

## 1. App Down

**Trigger**: the site is unreachable, or a user reports 5xx / connection refused.

> **How this incident actually starts: a human notices.** There is no
> external uptime monitor, no alert and no pager — verified 2026-09-10,
> tracked as **#854**. Nothing in this document detects an outage; every
> minute between the app dying and someone opening the site is
> unmeasured and uncapped, and the 4-hour RTO in `docs/slos.md` SLO 7
> is time-to-restore *from the moment you start*, not from the moment
> it broke. Read any "page severity" or "acknowledge within 15 minutes"
> below as the intended policy, not as a description of today.

**What it means**: `/api/livez` cannot be reached. Either the `agrent-app` container is dead or restart-looping, Caddy is not proxying, or the VM itself is down.

> **Corrected 2026-09-10 (#842).** The EKS triage that stood here —
> pods, Ingress, in-cluster DNS, Helm release values — addressed a
> cluster that does not exist. Replaced with the VM equivalents, verified
> against the running instance. Full context:
> `docs/runbooks/production-vm.md`.

### Triage

```bash
# 1. Is it the app, or the path to it? Ask from outside first.
curl -sS -o /dev/null -w '%{http_code}\n' https://app.agrent.bg/api/livez
curl -s https://app.agrent.bg/api/readyz | jq '{status, version, checks, failed}'
# 200 + status "ready"            → app is fine; the report is something else
# 200 livez but readyz not ready  → a dependency is down; `failed` names it
# connection refused / TLS error  → Caddy or the VM  (steps 2-4)
```

```bash
# 2. What is running? Seven containers: app, worker, db, pgbouncer,
#    redis, caddy, watchtower. Docker on the VM needs sudo.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker compose -f /opt/agrent/docker-compose.vm.yml ps"
# Look for: Exit, Restarting, or (unhealthy) on agrent-app.
```

```bash
# 3. The app container's own account of why.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker logs --tail 200 agrent-app"
# The entrypoint prints its migration step BEFORE Next.js starts. A loop
# that never reaches "Starting Next.js server" is a failing migration.
```

```bash
# 4. Is the VM itself up, and does it have disk? Postgres, uploads, Redis
#    AOF and every image share one 80 GB boot disk; at 100% everything
#    fails at once and it looks like an app fault.
gcloud compute instances describe agrent --zone europe-west1-b --format='value(status)'
gcloud compute ssh agrent --zone europe-west1-b --command "df -h /; free -h"
```

### Decide

| Symptom | Next action |
|---|---|
| `agrent-app` restarting in a loop, logs never reach "Starting Next.js server" | The entrypoint's `prisma migrate deploy` is failing — a bad migration shipped with the image. → [Rollback](#6-rollback) |
| `agrent-app` healthy, `agrent-caddy` down or erroring | TLS / proxy fault. `sudo docker logs --tail 100 agrent-caddy`; restart caddy. Certs are Let's Encrypt via Caddy → [Certificate Expiry](#5-certificate-expiry) |
| Container up, `/api/readyz` reports `database` failed | → [Database Unavailable / Slow](#2-database-unavailable--slow) |
| Container up, `/api/readyz` reports `redis` failed | → [Redis OOM / Degraded Queueing](#3-redis-oom--degraded-queueing) |
| Disk at or near 100% | `sudo docker image prune -a` buys room immediately; then resize the disk (`docs/runbooks/production-vm.md` § 3) |
| Instance `status` is not `RUNNING` | Start it: `gcloud compute instances start agrent --zone europe-west1-b`. If it will not boot, the recovery path is the disk snapshot — `docs/backup-restore.md` |
| App version is not the commit you expect | Watchtower did not roll, or rolled something else. `sudo docker logs --tail 50 agrent-watchtower`, and check `Image tip check` |

### Mitigate

- **App container up but the site is unreachable** → Caddy terminates
  TLS and reverse-proxies to `app:3000`. Check it, not the app:
  ```bash
  gcloud compute ssh agrent --zone europe-west1-b --command \
    "sudo docker logs --tail 100 agrent-caddy"
  ```

- **App container restart-looping after a deploy** → almost always the
  entrypoint's `prisma migrate deploy` failing, since it runs before
  Next.js starts. → [Rollback](#6-rollback).

- **Nothing conclusive after 30 minutes** → restart the app + worker.
  This is safe; it is what Watchtower does on every deploy:
  ```bash
  gcloud compute ssh agrent --zone europe-west1-b --command \
    "cd /opt/agrent && sudo docker compose -f docker-compose.vm.yml restart app worker"
  ```

### Verify recovery

- `curl https://app.agrent.bg/api/livez` returns 200 from your machine.
- `curl -s https://app.agrent.bg/api/readyz | jq '{status, version, checks}'` — `status: "ready"`, database and redis `ok`, and `version` is the commit SHA you expect.
- `SMOKE_URL=https://app.agrent.bg node scripts/smoke-prod.mjs` passes.
- There is no external uptime monitor to go green, and no PagerDuty incident to auto-resolve. Confirm by hand.

---

## 2. Database Unavailable / Slow

**Trigger**: `DatabaseConnectionPoolExhausted` (>20% Prisma errors for 3m), `ApiP95LatencyCritical`, or the Database dashboard's `repo_method_duration` P95 spike.

**What it means**: queries are timing out, the connection pool is saturated, OR the upstream RDS instance is unhealthy.

### Triage

```bash
# 1. Is the RDS instance healthy?
aws rds describe-db-instances \
  --db-instance-identifier inflect-compliance-production-db \
  --query 'DBInstances[0].{Status:DBInstanceStatus,MultiAZ:MultiAZ,Endpoint:Endpoint.Address}'
# Want: Status=available, MultiAZ=true
```

```bash
# 2. Check the Database dashboard
# /d/inflect-database — look at:
#   - "Top slow repo methods (P95)" table  → which method is slow?
#   - "Repo errors by method"               → all-methods spike or one?
#   - "Result-count P95 by repo method"    → caller forgot pagination?
```

```bash
# 3. PgBouncer pool stats — what's actually happening at the pool layer?
APP_POD=$(kubectl --namespace inflect-production get pod \
  -l "app.kubernetes.io/component=app" \
  -o jsonpath='{.items[0].metadata.name}')

kubectl --namespace inflect-production exec "$APP_POD" -c pgbouncer -- \
  psql "host=127.0.0.1 port=5432 dbname=pgbouncer user=postgres" \
  -c "SHOW POOLS;"
# Look at: cl_waiting (clients waiting for a connection — high = pool saturated)
#          sv_active  (server connections currently busy)
#          sv_idle    (server connections idle, available)
```

```bash
# 4. RDS connection count via CloudWatch
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value=inflect-compliance-production-db \
  --statistics Maximum \
  --start-time $(date -u -d '15 minutes ago' +%FT%TZ) \
  --end-time $(date -u +%FT%TZ) \
  --period 60
```

### Decide

| Symptom | Mitigate |
|---|---|
| RDS Status != `available` (failing-over, modifying, etc.) | Wait. Multi-AZ failover takes 60-180s. Customer impact is bounded. |
| RDS available; PgBouncer `cl_waiting > 0` sustained | Pool saturated. Scale app DOWN (back-pressure) OR increase PgBouncer `default_pool_size` in `values-production.yaml` and `helm upgrade`. |
| RDS available; PgBouncer healthy; `repo_method_duration` P95 spike on ONE method | A specific query is slow. Investigate via `pg_stat_statements`: `SELECT query, mean_exec_time, calls FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;` (use the read-only `inflect_readonly` user). Likely missing index. |
| RDS available; ALL repo methods slow simultaneously | RDS underlying performance issue (CPU, IOPS exhaustion). Check CloudWatch RDS dashboard. Scale instance class up via Terraform. |
| RDS instance unrecoverable | → [DB recovery from PITR](#db-recovery-from-pitr) below. |

### DB recovery from PITR

Last resort. Used when the live RDS instance is corrupt or unrecoverable.

```bash
# 1. Find the latest restorable time
aws rds describe-db-instances \
  --db-instance-identifier inflect-compliance-production-db \
  --query 'DBInstances[0].LatestRestorableTime'

# 2. Restore to a NEW instance (don't overwrite the source)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier inflect-compliance-production-db \
  --target-db-instance-identifier inflect-compliance-production-db-restored-$(date +%s) \
  --restore-time <latest-restorable-time-from-step-1> \
  --db-instance-class db.m6g.large \
  --multi-az \
  --no-publicly-accessible \
  --vpc-security-group-ids <prod-db-sg> \
  --db-subnet-group-name inflect-compliance-production-db-subnet-group

# 3. Wait for the new instance to be available (~30-60 minutes)
aws rds wait db-instance-available \
  --db-instance-identifier inflect-compliance-production-db-restored-...

# 4. Update the chart values to point at the new endpoint
# Edit values-production.yaml: pgbouncer.config.POSTGRESQL_HOST → new endpoint
# Then: gh workflow run Deploy --field environment=production --field ref=main

# 5. Verify via /api/readyz
curl https://app.example.com/api/readyz | jq .

# 6. Once verified, schedule the OLD instance for deletion (after retention)
```

The monthly `infra/scripts/restore-test-gcp.sh` exercises the restore
path end-to-end (without the swap-the-app step): newest GCE snapshot →
disk → throwaway VM → real Postgres over the recovered data directory →
validation battery → teardown. If the monthly drill has been failing,
**assume the backup is not restorable** and treat any recovery attempt
as unproven.

> **This is a DAILY snapshot, not point-in-time recovery.** Recovering
> loses everything written since the last 02:00 UTC snapshot — up to 24
> hours. There is no transaction-log archive to replay. Before
> restoring, capture whatever is still readable from the live volume;
> the snapshot is the floor, not the ceiling.

---

## 3. Redis OOM / Degraded Queueing

**Trigger**: `RedisMemoryHighWarning` (>80%), `RedisMemoryHighCritical` (>95%).

**What it means**: ElastiCache memory is filling up. The chart enforces `maxmemory-policy=noeviction` (BullMQ requirement — jobs cannot be evicted). Reaching 100% memory means **writes will be REJECTED** — workers fail to enqueue new jobs.

### Triage

```bash
# 1. Confirm via CloudWatch (alert is CW-derived)
aws cloudwatch get-metric-statistics \
  --namespace AWS/ElastiCache \
  --metric-name DatabaseMemoryUsagePercentage \
  --dimensions Name=ReplicationGroupId,Value=inflect-compliance-production-redis \
  --statistics Average \
  --start-time $(date -u -d '15 minutes ago' +%FT%TZ) \
  --end-time $(date -u +%FT%TZ) \
  --period 60
```

```bash
# 2. What's actually in Redis?
APP_POD=$(kubectl --namespace inflect-production get pod \
  -l "app.kubernetes.io/component=app" \
  -o jsonpath='{.items[0].metadata.name}')

# Need a redis-cli with TLS. Easiest: exec into the pgbouncer container
# (it's based on bitnami which has redis-cli) OR run a debug pod:
kubectl --namespace inflect-production run --rm -it --image=redis:7-alpine debug -- \
  redis-cli -h <redis-primary-endpoint> --tls -a "$REDIS_AUTH_TOKEN" INFO memory

# Look at: used_memory_human, maxmemory_human, used_memory_peak_human
# Then: redis-cli ... MEMORY DOCTOR
```

### Mitigate

| Stage | Action |
|---|---|
| First (warning, 80%) | Identify largest BullMQ jobs in the queue and clean completed/failed: `await queue.clean(0, 'completed')` + `await queue.clean(0, 'failed')`. Run via `kubectl exec` in a worker pod. |
| Second (sustained warning) | Scale up the cache node class: edit `values-production.yaml`'s `redis_node_type` (it's a chart input that maps to the OI-1 redis module's `node_type`). Run a fresh terraform apply for the OI-1 stack. |
| Third (critical, 95%) | Scale node UP IMMEDIATELY via Terraform — don't wait for the next maintenance window. ElastiCache scaling is online (rolling node replacement). Expect ~30 minutes. |

### Verify recovery

- CloudWatch metric returns below 80%.
- `RedisMemoryHighWarning` resolves (Slack notification).
- BullMQ worker logs show successful enqueues.

---

## 4. Queue Backlog

**Trigger**: `QueueDepthBacklogWarning` (>100 waiting for 10m), `QueueDepthBacklogCritical` (>1000 for 5m).

**What it means**: BullMQ workers can't keep up with the rate of new jobs. At >100 the system is bottlenecked but recoverable; at >1000 the operator must intervene.

### Triage

Open the [BullMQ dashboard](#dashboards). Key panels:
- **Backlog (waiting)** stat — current depth
- **Jobs/sec by name + status** — which job type is slow / failing?
- **Job duration percentiles** — has P95 spiked?
- **Top failing jobs** — same job type repeatedly retrying?

```bash
# Worker logs — grep for the slow job name
kubectl --namespace inflect-production logs \
  -l "app.kubernetes.io/component=worker" \
  --tail=500 \
  | grep -E "<slow-job-name>"
```

### Mitigate

| Cause | Action |
|---|---|
| Single job type backed up | Scale workers: `helm upgrade --reuse-values --set worker.replicaCount=N inflect-production`. Worker autoscaling isn't wired (per OI-2 spec); manual. |
| Poison-pill job (retrying forever) | Identify via top-failing-jobs panel. Kill via BullMQ admin API or directly via Redis: `redis-cli LPOP bull:<queue>:wait` (DON'T do this without a quick recovery plan; jobs may be load-bearing). |
| Underlying dependency slow (Redis OOM, DB slow) | → [Redis OOM](#3-redis-oom--degraded-queueing) or [DB slow](#2-database-unavailable--slow) first; queue drains naturally once the dep recovers. |

### Verify recovery

- Backlog depth trending down on the BullMQ dashboard.
- `QueueDepthBacklogCritical` resolves.
- Job throughput (jobs/sec stat) returns to normal range.

---

## 5. Certificate Expiry

**Trigger**: `CertificateExpiryWarning` (<14d), `CertificateExpiryCritical` (<3d).

**What it means**: cert-manager (or equivalent) hasn't renewed the cert. By default cert-manager renews at 30 days remaining; <14 days means automation has failed; <3 days means imminent service-down (browsers refuse).

### Triage

```bash
# 1. Check cert-manager state
kubectl get certificate -A
kubectl describe certificate <name> -n <namespace>

# 2. Check ACME order/challenge state (look for stuck or failing)
kubectl describe order -A
kubectl describe challenge -A

# 3. What's the actual cert serving?
echo | openssl s_client -showcerts -servername app.example.com -connect app.example.com:443 2>/dev/null \
  | openssl x509 -noout -dates -subject -issuer
```

### Mitigate

| Cause | Action |
|---|---|
| ACME challenge failing (DNS / HTTP-01) | Fix the underlying DNS or HTTP routing. Manually trigger renewal: `kubectl annotate certificate <name> cert-manager.io/issue-temporary-certificate="$(date +%s)" --overwrite` |
| cert-manager pod down | Check `kubectl get pods -n cert-manager`. Restart if needed. |
| Issuer rate-limited (Let's Encrypt 5 certs/week per FQDN) | Wait, OR cut over to a different ACME issuer (Buypass, ZeroSSL). |
| <3d remaining and cert-manager is stuck | **EMERGENCY**: issue a manual cert via `acme.sh` or equivalent, drop it into the K8s Secret directly. The Ingress's `tls.secretName` is operator-managed; replace the Secret content + the Ingress picks it up automatically. |

### Verify recovery

- `kubectl get certificate <name>` shows `READY: True`.
- `openssl s_client` against the production hostname shows the new cert dates.
- `CertificateExpiryWarning` (or Critical) resolves.

---

## 6. Rollback

**Trigger**: smoke test failure post-deploy, error spike post-deploy, or operator decision after another runbook recommends it.

**What it means**: put production back on the previous app image — and, if the bad deploy carried a destructive migration, put the SCHEMA back too. Those are two different operations and only one of them is fast.

> **Corrected 2026-09-10 (#842).** This playbook used to instruct
> on-call to inspect a Helm release's revision history and roll it back,
> and `tests/guards/oi-3-runbook-and-slos.test.ts` REQUIRED those exact
> command strings — a green guardrail holding an impossible instruction
> in place in the one document that gets read under time pressure. There
> is no chart (deleted in #848), no Helm release and no cluster. The
> strings are deliberately not reproduced here: the guard now asserts
> their ABSENCE, so quoting them would re-arm the trap. The full
> procedure, with the scaling and drift context around it, is
> **`docs/runbooks/production-vm.md` § 2**; the essentials are below so
> this page stands alone at 03:00.

### The one fact that decides the procedure

`scripts/entrypoint.sh` runs `prisma migrate deploy` before Next.js
starts, so **shipping an image is what applies a migration**. Pointing
the app back at the previous image reverts the CODE and leaves the
SCHEMA migrated. After a rename or a drop, the previous image queries
objects that no longer exist — an image-only rollback there does not
degrade gracefully, it **fails outright**.

| the bad deploy… | procedure |
|---|---|
| no migration, or a purely additive one | image pin (below). Old code ignores a new column. |
| renamed / dropped / narrowed, or rewrote persisted data | down-migration FIRST, then the image pin |
| data destroyed with no `.down.sql` | snapshot restore — up to **24 h** of loss. `docs/backup-restore.md`. |

```bash
# Which migrations did the running image apply, and when?
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker exec -i agrent-db sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \
   \"SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 10;\"'"
```

Cross-check those names against `ls deploy/rollback/`.

### Procedure — image pin

```bash
# 1. What is running now? `version` is the full commit SHA (BUILD_SHA).
curl -s https://app.agrent.bg/api/readyz | jq -r .version

# 2. Choose the last good commit; the image tag is sha-<7-char short SHA>.
git log --oneline -10 origin/main

# 3. Confirm the tag exists in GHCR before pinning to it. Watchtower runs
#    with --cleanup, so the previous image is NOT still on the VM — every
#    rollback goes through a registry pull.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker buildx imagetools inspect ghcr.io/rodnapamet/agri-saas:sha-<short> \
     --format '{{println .Manifest.Digest}}'"

# 4. Pin BOTH `app` and `worker` in deploy/docker-compose.vm.yml from
#    `:latest` to `:sha-<short>`, then push the compose file up. An
#    immutable sha- tag is also what stops Watchtower (--interval 300)
#    rolling you forward again within five minutes.
deploy/apply.sh

# 5. Pull explicitly and recreate WITHOUT building — both services carry a
#    `build:` block, and an absent image is exactly when compose would
#    choose to build one.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "cd /opt/agrent && sudo docker compose -f docker-compose.vm.yml pull app worker && \
   sudo docker compose -f docker-compose.vm.yml up -d --no-build app worker"

# 6. Verify + smoke.
curl -s https://app.agrent.bg/api/readyz | jq '{status, version}'
SMOKE_URL=https://app.agrent.bg node scripts/smoke-prod.mjs
```

A `sha-` pin left in the repo means Watchtower ships nothing ever again
and nobody is told. File an issue when you pin, and return the compose
file to `:latest` in the PR that fixes the defect.

### Procedure — down-migration (destructive migrations only)

`deploy/rollback/<migration_directory_name>.down.sql`. Read
`deploy/rollback/README.md` first: its "Current scripts" table records
which scripts have actually been executed against a database and which
have only been written, and two of them have an ordering constraint
between them.

```bash
# 1. Stop app + worker. DDL under a live app means in-flight queries hit
#    tables mid-rename.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "cd /opt/agrent && sudo docker compose -f docker-compose.vm.yml stop app worker"

# 2. Apply against the DIRECT connection, never PgBouncer — this is DDL in
#    one transaction and PgBouncer pools per-transaction. Running it inside
#    the db container IS the direct connection.
gcloud compute ssh agrent --zone europe-west1-b --command \
  "sudo docker exec -i agrent-db sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" \
     -v ON_ERROR_STOP=1'" < deploy/rollback/<name>.down.sql

# 3. NOW do the image pin above. Starting the NEW image instead re-applies
#    the forward migration from its entrypoint and puts you back where you
#    started.
```

`-v ON_ERROR_STOP=1` is load-bearing: without it `psql` continues past a
failed statement and, combined with the script's `BEGIN;`/`COMMIT;`
wrapper, a rolled-back transaction is reported as a successful run. Each
script also deletes its own `_prisma_migrations` row on purpose — leave
it and a later roll-forward *skips* the migration as already-applied,
putting new code on an old schema.

### What an image pin re-applies — and what it doesn't

| ✅ Reverted | ❌ NOT reverted |
|---|---|
| App + worker code, and anything baked into the image | **Schema migrations** — `migrate deploy` is one-way and is not re-run in reverse |
| The `BUILD_SHA` reported by `/api/readyz` | Rows written or rewritten by a data migration |
| | `/opt/agrent/.env` (hand-managed, never touched by `apply.sh`) |
| | Anything outside the VM (GHCR tags, DNS, OAuth app config) |

### Migration safety — design for the rollback you will need

**Mitigation pattern: expand-and-contract migrations.**

| PR | Schema | App code |
|---|---|---|
| PR1 (Expand) | Add new column / table | Both versions of app work |
| PR2 (Migrate) | (no schema change) | Use the new shape |
| PR3 (Contract) | Drop old shape | Use the new shape exclusively |

A rollback after PR2 (Migrate) is safe — the schema accommodates both. A rollback after PR3 (Contract) is where you need the `.down.sql`; **flag it in PR descriptions so reviewers see the constraint explicitly**.

`tests/guards/destructive-migration-has-inverse.test.ts` derives the
destructive set by scanning every `migration.sql` for `DROP TABLE` /
`DROP COLUMN` / `DROP TYPE` / `RENAME TO` / `RENAME COLUMN` and requires
each one to have an inverse, so a new drop is covered the moment it
lands. It cannot tell you the inverse is *correct* — only that one
exists.

If you rolled back past a Contract-style migration and there is no usable inverse:
1. Stop app + worker (step 1 above).
2. Restore the disk from the latest snapshot taken before the migration applied (`docs/backup-restore.md` § "Recovering for real") — accepting up to 24 h of loss.
3. Bring the previous image up against the restored disk.
4. Communicate the data-loss window to customers.

---

## 7. Data Breach Response

**Trigger**: log audit reveals unauthorised access, suspicious access patterns, leaked credentials, third-party security disclosure, or anomaly in the audit log.

**What it means**: confidentiality of customer data may be compromised. Speed + traceability matter equally.

### Phase 1 — Contain (within 30 minutes)

```bash
# 1. STOP THE BLEED. If a credential is the root cause, rotate immediately.
#    The blast radius depends on which credential.

# Compromised AWS account credential:
#    HISTORICAL (#808): there is no AWS account and no Secrets Manager in
#    this deployment. Production is a GCP VM; secrets live in its env files,
#    rotated via deploy/apply.sh. The block below is kept only so an old
#    incident record referring to it still parses.
#    Disable the IAM role/user via AWS console.
#    Rotate every secret in AWS Secrets Manager for the affected env.
aws secretsmanager update-secret \
  --secret-id inflect-compliance-production-data-encryption-key \
  --description "ROTATING - incident #..."

# Compromised app session token:
#    Bump AUTH_SECRET — invalidates all active sessions.
#    Edit infra/terraform/modules/secrets/main.tf, change `keepers` on
#    random_id.auth_secret, terraform apply, kubectl rollout restart.
```

```bash
# 2. Preserve evidence. The audit log is hash-chained (Epic A.4) — do
#    NOT manipulate it. Take a snapshot of the live AuditLog table for
#    forensics:
kubectl --namespace inflect-production exec <app-pod> -c inflect -- \
  pg_dump -t '"AuditLog"' --data-only --column-inserts \
  -h <db-host> -U postgres inflect_compliance \
  > audit-log-incident-$(date +%s).sql
```

```bash
# 3. Take an out-of-band snapshot of the database for forensics
aws rds create-db-snapshot \
  --db-instance-identifier inflect-compliance-production-db \
  --db-snapshot-identifier inflect-prod-incident-$(date +%s)
```

### Phase 2 — Assess (within 4 hours)

| Question | How to answer |
|---|---|
| Which tenants are affected? | Query `AuditLog` for the suspect actor's `userId` / `tenantId` over the relevant window. |
| Which records were accessed? | `AuditLog` records every read+write with `entityType` + `entityId`. Cross-reference. |
| When did access start? | `AuditLog.createdAt` minimum timestamp for the actor. |
| Is the breach ongoing? | If credential rotated in Phase 1: no. Verify by failed-auth logs since the rotation. |

### Phase 3 — Notify (per regulatory requirement)

| Audience | Channel | Timing |
|---|---|---|
| Internal: leadership + legal | Slack `#incident-secrets` + email to `legal@` | Within 4 hours |
| Affected customers | Email + status page | Per contract (typically within 72h for GDPR-eligible customers) |
| Regulator (if required) | Per jurisdiction (GDPR Art. 33: 72h to supervisory authority) | Per regulatory clock |

Use the [communication templates](#communication-templates) below.

### Phase 4 — Recover

- Rotate ALL secrets (cascading: app, OAuth, database master, Redis AUTH, encryption keys).
- For DATA_ENCRYPTION_KEY rotation specifically: follow the Epic B v1→v2 sweep procedure in `docs/epic-b-encryption.md`. **Do NOT regenerate the KEK without the sweep** — encrypted data becomes unrecoverable.
- Audit access to the breach-vector before re-enabling.

### Phase 5 — Post-mortem

Within 7 days:
- Root cause narrative (5 whys)
- Timeline (detection → containment → recovery)
- Customer-impact assessment
- Remediation tracker (each finding → ticket → owner → due date)
- Filed in `docs/post-mortems/<YYYY-MM-DD>-<short-title>.md`

---

## Communication templates

### PagerDuty incident (auto-generated by the alerting pipeline)

The PagerDuty incident description is auto-populated by the alert
annotation. **Do not edit the alert annotation in flight** — that
would cause every future fire of the same alert to inherit your
in-incident notes. Use the PagerDuty incident's own `Notes` field
for the running commentary.

### Status page update — initial

```
[INVESTIGATING] We are investigating reports of <symptom> affecting
<service / endpoint>. Customers may experience <observable impact>.
We will provide an update within 30 minutes.

Posted at <UTC time>.
```

### Status page update — mitigation in progress

```
[IDENTIFIED] We have identified the cause as <root cause description>
and are <action taken>. We expect resolution within <time>.

Posted at <UTC time>.
```

### Status page update — resolved

```
[RESOLVED] At <UTC time>, the issue affecting <service> was
resolved. Cause: <one-line summary>. We will publish a detailed
post-mortem within 7 days.

Total customer-visible impact window: <start UTC> to <end UTC>
(<duration> total).
```

### Internal Slack — incident channel kickoff

```
🚨 INCIDENT: <short-title>

- Severity: <CRITICAL | WARNING>
- Started: <UTC time> (per <alert name>)
- IC: <name>     SME: <name>     Comms: <name>
- Affected service: <service>
- Initial symptom: <one-liner>
- Dashboard: <URL>
- Runbook: docs/incident-response.md#<section>

Posting commentary every 15 minutes here.
```

### Customer email — service degradation

```
Subject: [Inflect Compliance] Service incident notification — <date>

Dear <Customer>,

We are writing to inform you of a service incident that began at
<UTC time> and was resolved at <UTC time>. During this window:

- Affected functionality: <description>
- Customer-visible impact: <description>
- Data integrity: <Confirmed unaffected | Under investigation>
- Remediation taken: <one-line summary>

A detailed post-mortem will be available at <link> within 7 days.

We apologise for the disruption. Please reach out to
support@inflect-compliance.example.com if you have questions.

— The Inflect Compliance team
```

### Customer email — confirmed data breach

(For data-breach incidents only. Coordinate with legal before
sending — wording may need to be adjusted for the specific
regulatory regime.)

```
Subject: [Inflect Compliance] Important: Security incident affecting your data

Dear <Customer>,

We are writing to inform you of a security incident that has
affected data associated with your Inflect Compliance account.

What happened:
  <Brief factual summary of the incident, no speculation.>

When it happened:
  <UTC start> to <UTC end>.

What information was involved:
  <Specific data types — be precise. Don't say "personal data";
   say "user names, email addresses, and audit log entries from
   period X to Y".>

What we have done:
  - <Containment action>
  - <Affected credentials rotated>
  - <Forensic preservation>

What you should do:
  - <Specific recommendation, e.g. "rotate any passwords reused
     across services">
  - <Watch for suspicious activity>

Regulatory notifications:
  Per <GDPR Art. 33 / state breach notification law / etc.>, we
  have notified <regulator>. <Other notification details.>

For questions, please contact security@inflect-compliance.example.com
or your account manager.

— The Inflect Compliance team
```

---

## Operational alignment summary

This runbook is the **handle** by which an operator drives the
underlying machinery shipped across OI-1 / OI-2 / OI-3:

| Runbook section uses... | ...which is shipped by |
|---|---|
| ~~`helm rollback`, `kubectl rollout restart`~~ → image pin + `deploy/apply.sh` | Epic OI-2 shipped a Helm chart and a `deploy.yml` that **never ran once**; both deleted (#808, #848). The real path is `deploy/apply.sh` + `deploy/docker-compose.vm.yml` + Watchtower, documented in `docs/runbooks/production-vm.md` |
| disk-from-snapshot restore | GCE snapshot schedule `agrent-daily-snapshot` + `infra/scripts/restore-test-gcp.sh` (validates the path monthly) |
| Secrets Manager rotation (KEK, AUTH, DB) | Epic OI-1 (secrets module, `manage_master_user_password=true` for RDS) |
| Database / Redis / BullMQ dashboards | Epic OI-3 part 2 (`infra/dashboards/`) |
| Alert annotations link to dashboards | Epic OI-3 part 3 (`infra/alerts/rules.yml`) |
| External uptime monitor on `/api/livez` | Epic OI-3 part 3 (`infra/alerts/external-uptime.yml`) |
| `/api/readyz` dep-aware probe | Epic OI-3 part 1 (the route + tests) |
| Audit log integrity (hash-chained) | Epic A.4 (pre-OI-3) — referenced from the breach response |

Each runbook section names the **specific alert** that fires it and
the **specific dashboard** that diagnoses it, so an operator
landing on this doc cold can act without prior context.

---

## Revision history

| Date | Change |
|---|---|
| 2026-04-27 | Initial runbook (Epic OI-3 final layer). 7 playbooks + 5 communication templates. Tied to OI-1 (Terraform/RDS), OI-2 (Helm/deploy), and the rest of OI-3 (readyz, observability, alerting, backup/restore). |
| 2026-09-10 | **#842** — replaced the Helm rollback playbook (§6) with the VM procedure and rewrote §1 App Down for the VM; added the READ-THIS-FIRST banner marking which sections still describe undeployed EKS/AWS infrastructure; re-pointed `tests/guards/oi-3-runbook-and-slos.test.ts`, which had been REQUIRING the two Helm release-history/rollback command strings by exact match and so was holding an impossible instruction green — it now asserts their absence. Companion: `docs/runbooks/production-vm.md`. |
