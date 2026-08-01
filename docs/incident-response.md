# Incident Response Runbook

> Production operational playbook for inflect-compliance.
>
> Epic OI-3 — final operational layer. Tied directly to the
> alerts (`infra/alerts/rules.yml`), dashboards (`infra/dashboards/`),
> deployment workflow (`.github/workflows/deploy.yml`), and recovery
> scripts (`infra/scripts/`) shipped earlier in OI-3.

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

**Trigger**: external uptime monitor alarm (UptimeRobot/Pingdom 503 from multi-region) → PagerDuty critical. The internal `LivezProbeFailure` alert may also fire.

**What it means**: external probes can't reach `/api/livez`. Either the app process is dead across all pods, OR the network path (DNS, ALB, Ingress) is broken.

### Triage

```bash
# 1. Are pods running?
kubectl --namespace inflect-production get pods \
  -l "app.kubernetes.io/instance=inflect-production"

# Look for: 0/N Ready, CrashLoopBackOff, Pending
```

```bash
# 2. Is the Ingress healthy?
kubectl --namespace inflect-production get ingress
kubectl --namespace ingress-nginx get pods
# Check the controller's logs for cert / upstream errors:
kubectl --namespace ingress-nginx logs -l app.kubernetes.io/name=ingress-nginx --tail=200
```

```bash
# 3. Can YOU reach /api/livez from inside the cluster?
kubectl --namespace inflect-production run --rm -it --image=curlimages/curl debug -- \
  curl -v http://inflect-production.inflect-production.svc.cluster.local/api/livez
# 200 with body {"status":"alive",...} → app is up; problem is INGRESS or DNS
# 503 / timeout → app process is down
```

```bash
# 4. Recent events?
kubectl --namespace inflect-production get events \
  --sort-by='.lastTimestamp' | tail -20
```

### Decide

| Symptom | Next action |
|---|---|
| All pods CrashLoopBackOff | Likely bad image / config. → [Rollback](#6-rollback) |
| 0 pods, ReplicaSet has 0 desired | HPA scaled to 0 or Deployment misconfigured. Check `helm get values inflect-production -n inflect-production` for `autoscaling.minReplicas` |
| Pods Ready, in-cluster /livez returns 200, but external 503 | Ingress / DNS issue. Check ingress controller logs + DNS records. |
| Cert error in browser/curl | → [Certificate Expiry](#5-certificate-expiry) |

### Mitigate

- **If clearly a bad deploy** (CrashLoopBackOff after a recent rollout):
  ```bash
  helm rollback inflect-production --namespace inflect-production --wait --timeout 5m
  ```
  See [Rollback](#6-rollback) for full procedure.

- **If image puller fails** (e.g. GHCR credentials rotated, image pruned):
  Restore the image pull secret + restart pods:
  ```bash
  kubectl --namespace inflect-production rollout restart deployment/inflect-production
  ```

- **If completely opaque** and time-to-mitigate is exceeding 30 minutes:
  Restart the Deployment AND scale to known-good replica count manually:
  ```bash
  kubectl --namespace inflect-production scale deployment/inflect-production --replicas=3
  kubectl --namespace inflect-production rollout restart deployment/inflect-production
  kubectl --namespace inflect-production rollout status deployment/inflect-production --timeout=5m
  ```

### Verify recovery

- External uptime monitor returns to healthy (PagerDuty incident auto-resolves via `send_resolved: true`).
- `kubectl get pods` shows N/N Ready.
- `curl https://app.example.com/api/livez` returns 200 from your machine.

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

**What it means**: undo the most recent (or chosen) Helm release.

### Procedure

```bash
# 1. Confirm namespace + release
helm list --namespace inflect-production

# 2. Show the revision history
helm history inflect-production --namespace inflect-production --max 10
# Output: REVISION  STATUS      CHART          APP VERSION  DESCRIPTION
#         5         deployed    inflect-0.1.0  1.36.0       Upgrade complete  ← current
#         4         superseded  inflect-0.1.0  1.35.1       Upgrade complete  ← target

# 3. Roll back to the immediately prior revision
helm rollback inflect-production --namespace inflect-production --wait --timeout 5m

# OR roll back to a specific revision
helm rollback inflect-production 4 --namespace inflect-production --wait --timeout 5m

# 4. Verify
kubectl --namespace inflect-production rollout status deployment/inflect-production
curl https://app.example.com/api/readyz | jq .

# 5. Run smoke against the rolled-back service
SMOKE_URL=https://app.example.com node scripts/smoke-prod.mjs
```

### What rollback re-applies — and what it doesn't

| ✅ Re-applied | ❌ NOT re-applied |
|---|---|
| Deployment image tag, replicas, env, resources | Pre-install/upgrade hooks (the migration Job is **NOT** re-run on rollback) |
| ConfigMap / Secret content (chart-managed) | Externally-managed resources (RDS state, S3 bucket contents, Secrets Manager) |
| HPA bounds + metrics | Schema migrations |
| Ingress + NetworkPolicy + Service | |

### Migration safety on rollback

The migration Job is one-way. Rolling back the app image to a revision that **pre-dates** a schema migration leaves the OLD app code reading the NEW schema — broken (missing columns, wrong types).

**Mitigation pattern: expand-and-contract migrations.**

| PR | Schema | App code |
|---|---|---|
| PR1 (Expand) | Add new column / table | Both versions of app work |
| PR2 (Migrate) | (no schema change) | Use the new shape |
| PR3 (Contract) | Drop old shape | Use the new shape exclusively |

A rollback after PR2 (Migrate) is safe — the schema accommodates both. A rollback after PR3 (Contract) is a data-loss event; **flag it in PR descriptions so reviewers see the constraint explicitly**.

If you rollback past a Contract-style PR by accident:
1. Stop the pods (`kubectl scale deployment/... --replicas=0`).
2. Restore the database from the latest snapshot taken before the Contract migration applied.
3. Cut over the app to the restored DB endpoint.
4. Communicate data loss window to customers.

---

## 7. Data Breach Response

**Trigger**: log audit reveals unauthorised access, suspicious access patterns, leaked credentials, third-party security disclosure, or anomaly in the audit log.

**What it means**: confidentiality of customer data may be compromised. Speed + traceability matter equally.

### Phase 1 — Contain (within 30 minutes)

```bash
# 1. STOP THE BLEED. If a credential is the root cause, rotate immediately.
#    The blast radius depends on which credential.

# Compromised AWS account credential:
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
| `helm rollback`, `kubectl rollout restart` | Epic OI-2 (Helm chart, deploy workflow) |
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
