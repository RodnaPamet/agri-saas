# Service Level Objectives (SLOs)

> inflect-compliance — Production Operational Standards
>
> Epic 19: Observability & Operational Readiness

---

## Overview

This document defines measurable Service Level Objectives (SLOs) for the inflect-compliance platform. Each SLO specifies:

- **Exact objective** — the target value
- **Measurement formula** — how the SLO is computed
- **Scope** — what traffic/operations count
- **Exclusions** — what is intentionally excluded
- **Time window** — rolling evaluation period
- **Telemetry source** — which metric(s) power the measurement
- **Alert threshold** — when human attention is needed

These SLOs are designed to be immediately measurable using the OTel metrics
emitted by `src/lib/observability/metrics.ts` through `withApiErrorHandling`.

---

## Telemetry Inventory

The following OTel metrics are emitted at every API request completion:

| Metric Name | Type | Labels | Source |
|---|---|---|---|
| `api_request_count` | Counter | `http_method`, `http_route`, `http_status_code` | `metrics.ts` → `withApiErrorHandling` |
| `api_request_duration` | Histogram (ms) | `http_method`, `http_route`, `http_status_code` | `metrics.ts` → `withApiErrorHandling` |
| `api_request_errors` | Counter | `http_method`, `http_route`, `error_code` | `metrics.ts` → `withApiErrorHandling` |

> **Note**: OTel metric names use dots (`api.request.count`) but Prometheus
> convention converts these to underscores (`api_request_count`). All PromQL
> in this document uses the Prometheus-convention names.

### Health probes (separate from API SLO traffic):

| Endpoint | Purpose | Metric Coverage |
|---|---|---|
| `GET /api/livez` | Process liveness | HTTP status only (no OTel metrics) |
| `GET /api/readyz` | Dependency readiness | HTTP status + structured JSON checks |
| `GET /api/health` | Deprecated alias | Same as readyz |

---

## SLO 1: API Availability

### Objective

**≥ 99.9% of API requests return a non-5xx response** (rolling 30-day window).

### Measurement Formula

```
availability = 1 - (
  sum(api_request_count{http_status_code=~"5.."}) /
  sum(api_request_count)
)
```

### Scope

All HTTP requests that pass through `withApiErrorHandling` — this covers:

- All tenant-scoped API routes (`/api/t/[tenantSlug]/*`)
- All legacy API routes (`/api/controls`, `/api/risks`, etc.)
- Admin API routes (`/api/admin/*`)
- Auth API routes (`/api/auth/*`)
- SSO callback routes
- Webhook receivers (`/api/stripe/webhook`)

### Exclusions

| Excluded | Reason |
|---|---|
| `/api/livez` | Infrastructure probe — not user-facing |
| `/api/readyz` | Infrastructure probe — not user-facing |
| `/api/health` | Deprecated infrastructure probe |
| `/api/staging/seed` | Dev/staging-only endpoint |
| Client-side errors (4xx) | Expected application behavior |

### Time Window

**30-day rolling window**, evaluated continuously.

### Telemetry Source

- **Primary**: `api_request_count` counter with `http_status_code` label
- **Exporter**: OTel Collector → Prometheus remote-write
- **Dashboard**: "API Availability" panel in Grafana

### Alert Thresholds

| Severity | Condition | Window | Action |
|---|---|---|---|
| **Warning** | Availability < 99.9% (error rate > 0.1%) | 15 min | Investigate — check error logs |
| **Critical** | Availability < 99.5% (error rate > 0.5%) | 5 min | Page on-call — active incident |

### Error Budget

At 99.9% over 30 days:
- **Allowed downtime**: ~43 minutes/month
- **Allowed error count**: 1 in 1,000 requests

---

## SLO 2: API Latency — Reads (P95)

### Objective

**95th percentile of GET requests < 500ms** (rolling 30-day window).

### Why split read vs write

Reads and writes have fundamentally different cost profiles:
- Reads hit caches, denormalised columns, and read replicas. P95 < 500ms is achievable for the vast majority of read endpoints.
- Writes go through transaction commits, fan out to denormalised columns, sometimes trigger audit log writes + outbound webhook batches. A 500ms write target would be perpetually breached without delivering proportional user-experienced improvement.

OI-3 spec defines the two targets separately for exactly this reason. The previous single P95 SLO is split into SLOs 2a (reads) and 2b (writes); both are evaluated against `api_request_duration` filtered by HTTP method.

### Measurement Formula

```promql
p95_read_latency = histogram_quantile(
  0.95,
  sum by (le) (rate(api_request_duration_bucket{http_method=~"GET|HEAD"}[5m]))
)
```

### Scope

GET + HEAD requests through `withApiErrorHandling`. Per-route exclusions identical to the write SLO below.

### Exclusions

| Excluded | Reason |
|---|---|
| `/api/livez`, `/api/readyz`, `/api/health` | Infrastructure probes — trivially fast (would dominate the histogram and skew P95 down) |
| Report generation endpoints (`/api/t/*/reports/export`) | Expected to be slow (PDF generation on demand) |
| File upload endpoints (`/api/t/*/files`) | POST-only, but if a HEAD lands here it's bound by upload size |

### Telemetry Source

- **Primary**: `api_request_duration` histogram, filtered by `http_method=~"GET|HEAD"`
- **Dashboard**: `inflect-app-overview` (panel 5: "Latency percentiles")
- **Alert**: `ApiP95LatencyWarning` (>500ms 10m), `ApiP95LatencyCritical` (>2000ms 5m). Both currently match on full traffic; future PR splits the alert by method to avoid write-induced false positives on the read SLO.

---

## SLO 2b: API Latency — Writes (P95)

### Objective

**95th percentile of state-mutating requests < 1000ms** (rolling 30-day window).

### Measurement Formula

```promql
p95_write_latency = histogram_quantile(
  0.95,
  sum by (le) (rate(api_request_duration_bucket{http_method=~"POST|PUT|PATCH|DELETE"}[5m]))
)
```

### Scope

All POST/PUT/PATCH/DELETE through `withApiErrorHandling`.

### Exclusions

Same as SLO 2 (reads), plus:

| Excluded | Reason |
|---|---|
| `/api/auth/*` | NextAuth flows — bound by external IdP redirect, not server latency |
| `/api/stripe/webhook`, `/api/storage/av-webhook` | Inbound webhook receivers — bound by sender retry, not server latency |

### Telemetry Source

- **Primary**: `api_request_duration` histogram, filtered by `http_method=~"POST|PUT|PATCH|DELETE"`
- **Dashboard**: `inflect-app-overview` (panel 5: "Latency percentiles") — split by method via the panel's `legendFormat`
- **Alert**: same thresholds as SLO 2 today; per-method split is a follow-up

---

## SLO 3: API Error Rate

### Objective

**< 1% of API requests result in a 5xx error** (rolling 30-day window).

### Measurement Formula

```
error_rate = (
  sum(rate(api_request_count{http_status_code=~"5.."}[5m])) /
  sum(rate(api_request_count[5m]))
) * 100
```

### Scope

Same as SLO 1.

### Exclusions

Same as SLO 1.

### Time Window

**30-day rolling window**, evaluated over 5-minute rate windows.

### Telemetry Source

- **Primary**: `api_request_count` counter, partitioned by `http_status_code`
- **Secondary**: `api_request_errors` counter for error-code breakdown
- **Dashboard**: "Error Rate" panel in Grafana

### Alert Thresholds

| Severity | Condition | Window | Action |
|---|---|---|---|
| **Warning** | Error rate > 1% | 10 min sustained | Investigate error logs |
| **Critical** | Error rate > 5% | 5 min sustained | Page on-call — significant breakage |

---

## SLO 4: Health Check Availability

### Objective

**Readiness probe (`/api/readyz`) returns 200 at least 99.95% of the time** (rolling 7-day window).

### Measurement Formula

```
readyz_availability = (
  sum(probe_success{instance="inflect-compliance", job="readyz"}) /
  count(probe_success{instance="inflect-compliance", job="readyz"})
)
```

If using synthetic monitoring (e.g., Grafana Synthetic Monitoring, Blackbox Exporter):

```
readyz_availability = avg_over_time(probe_success{job="readyz"}[7d])
```

### Scope

- `GET /api/readyz` — checks PostgreSQL and Redis (when configured)
- `GET /api/livez` — checks process responsiveness

### Exclusions

None — if the probe fails, the service is unhealthy.

### Time Window

**7-day rolling window** — tighter window because probe failures indicate infrastructure problems, not traffic-dependent issues.

### Telemetry Source

- **Primary**: External synthetic monitoring (Blackbox Exporter or platform probe)
- **Secondary**: Container orchestrator health check results (K8s, Docker, Fly.io)
- **Dashboard**: "Health Check Status" panel in Grafana

### Alert Thresholds

| Severity | Condition | Window | Action |
|---|---|---|---|
| **Warning** | 2 consecutive readyz failures | 30s interval | Check DB/Redis connectivity |
| **Critical** | 3+ consecutive readyz failures | 45s | Page on-call — service degraded |
| **Critical** | Any livez failure | Immediate | Container should be restarted |

---

## SLO 5: Repository latency (Epic OI-3)

### Objective

**Repository-method P95 < 100ms** for all OI-3-instrumented methods (rolling 7-day window).

### Why

Repository methods are the dominant cost in API latency. A repo P95 over 100ms typically explains a corresponding API P95 spike. Tracking the repo SLO independently lets us catch DB-side regressions (slow query, missing index, lock contention) before they break the API SLO.

### Measurement Formula

```promql
repo_p95 = histogram_quantile(
  0.95,
  sum by (le, repo_method) (rate(repo_method_duration_bucket[5m]))
)
```

### Scope

All methods wrapped with `traceRepository(...)` from `src/lib/observability/repository-tracing.ts`. Today: 12 methods across `RiskRepository`, `ControlRepository`, `EvidenceRepository`. Future PRs extend coverage.

### Telemetry Source

- **Metric**: `repo_method_duration` histogram (Epic OI-3 part 2)
- **Dashboard**: `inflect-database` (panel 5: "Repo duration percentiles", panel 7: "Top slow repo methods (P95)")
- **Alert**: indirect — `DatabaseConnectionPoolExhausted` fires on Prisma error rate, which correlates with sustained slow queries

---

## SLO 6: RPO — Recovery Point Objective (Epic OI-3)

### Objective

**Maximum 1 hour of data loss** in a worst-case recovery scenario.

### Why 1 hour

Tighter (e.g. 5 minutes) requires synchronous cross-region replication — meaningful infrastructure cost increase + write-latency penalty. Looser (e.g. 24 hours) is unacceptable for a compliance SaaS where audit logs + evidence reviews are the work product. 1 hour reflects the AWS RDS automated-snapshot frequency floor + transaction-log shipping cadence; achievable within the existing OI-1 module without architectural changes.

> **⚠ NOT CURRENTLY MET — the target below is aspirational.**
> The 1-hour figure was written against an AWS RDS deployment with
> continuous transaction-log shipping. **The product does not run on
> RDS.** Production is a single GCE VM (`agrent`) with Postgres in a
> local Docker volume, and its backup is a **daily disk snapshot**.
> The achieved RPO is therefore **up to 24 hours**, not 1 hour.
>
> This was discovered on 2026-08-01, when production was found to have
> no automated backup of any kind — no cron, no timer, no snapshot
> schedule, zero snapshots. The daily schedule below closed that hole;
> closing the gap from 24h to 1h needs continuous archiving (WAL
> shipping to object storage, or a managed Postgres), which is not
> deployed. Treat 1 hour as the target to build toward and 24 hours as
> what the system delivers today.

### How it's met (as deployed, 2026-08-01)

| Layer | Mechanism | Recoverable to |
|---|---|---|
| Postgres (GCE VM `agrent`) | Daily GCE snapshot of the boot disk — resource policy `agrent-daily-snapshot`, 02:00 UTC, 14-day retention, `keep-auto-snapshots` on disk delete | The snapshot moment — **up to 24h of loss** |
| Encrypted column data | Same disk snapshot (ciphertext is in the same volume) | Same |
| Uploaded files | Same disk snapshot (`agrent-uploads` Docker volume, same disk) | Same |
| `DATA_ENCRYPTION_KEY` | **Not in the snapshot** — it lives in `/opt/agrent/.env`, which IS on the same disk. A snapshot restore recovers both together; an operator restoring elsewhere must carry the key separately or the restored ciphertext is unreadable. |

The snapshot is **crash-consistent**, not application-consistent: it
captures the volume mid-transaction and Postgres replays WAL on start.
That is a supported recovery mode, and the restore drill exercises it
on purpose — it boots a real Postgres over the restored directory
rather than merely checking the snapshot exists.

### Measurement / Verification

- **`infra/scripts/restore-test-gcp.sh`** runs **monthly** (and on
  demand) via `.github/workflows/restore-test.yml`. It restores the
  newest snapshot to a throwaway VM, boots the production Postgres
  image over the recovered data directory, and asserts: migrations
  applied, `Tenant`/`User` readable, `tenant_isolation` RLS policies
  present, `app_user` role present, recent `AuditLog` rows.
- It also asserts the snapshot **schedule is still attached to the
  disk** and that the newest snapshot is **< 26h old** — a detached
  resource policy stops backups silently, with no error anywhere.
- A failed drill fails the workflow. **An unconfigured drill also
  fails it**, loudly, rather than skipping: a restore test that did
  not run is indistinguishable from one that passed.

### Risk

Single disk, single zone. The snapshot is stored regionally (`eu`), so
a zone loss is survivable, but there is no cross-region copy and no
continuous archiving — a failure between two daily snapshots loses up
to a day of work. For a product whose work product is audit logs and
evidence reviews, that is a real gap, and it is the reason the 1-hour
target above is retained rather than quietly rewritten down to match
what is deployed.

---

## SLO 7: RTO — Recovery Time Objective (Epic OI-3)

### Objective

**Service restored within 4 hours** of a critical incident.

### Why 4 hours

Aligns with our compliance customers' standard SLAs (most enterprise SaaS contracts allow 4-hour MTTR for critical incidents). Also matches the realistic floor for a multi-step recovery: detection (alert) + triage (15-30 min) + restore-from-backup (RDS restore is 30-60 min for production-sized data) + smoke testing + DNS / traffic re-routing.

### Recovery scenarios mapped to RTO

| Scenario | Mechanism | Estimated RTO |
|---|---|---|
| Single pod failure | Kubernetes auto-restart | < 1 minute |
| Single AZ failure | RDS multi-AZ failover (production only) + ALB cross-AZ routing | 60-180 seconds |
| Bad deploy | `helm rollback` to prior revision | < 5 minutes |
| App-image bug requiring patched build | Deploy via `Deploy` workflow + build + smoke | 15-30 minutes |
| RDS instance corruption (single-region) | `restore-db-instance-from-db-snapshot` to new instance, point app's `DATABASE_HOST` at new endpoint | 60-120 minutes |
| Master KEK loss (within 30-day recovery window) | `aws secretsmanager restore-secret`, redeploy | 15-30 minutes |
| Master KEK loss (beyond recovery window) | DR rebuild from a backup-encrypted-with-known-KEK; cross-customer notification likely | hours-to-days; may exceed RTO |
| Regional AWS outage | Manual restore in alternate region from cross-region snapshot copy | 2-4 hours; cross-region replica deployment would shorten this |

### Measurement / Verification

- **Detection**: covered by the alert pipeline (Epic OI-3 part 3). Critical alerts page within ~10 seconds of trigger via PagerDuty.
- **Decision tree + runbook**: `docs/incident-response.md` walks operators through each scenario above.
- **Restore mechanism validation**: the monthly `restore-test-gcp.sh` exercises the snapshot-restore path end-to-end — disk from snapshot, VM, real Postgres, validation battery, teardown.
- The 4-hour SLA is the SUM of detection + triage + recovery time; the budget allocation per stage is documented in `docs/incident-response.md` § "Severity definitions".

### Risk

The RTO assumes operator availability at the time of the incident. Out-of-hours incidents extend MTTR by the on-call response time (typically 15 minutes via PagerDuty). The 4-hour SLA accommodates this; tighter targets would require follow-the-sun on-call coverage (out of scope for OI-3).

---

## SLO Summary Table

| SLO | Target | Window | Primary Metric / Mechanism |
|---|---|---|---|
| API Availability | ≥ 99.9% | 30 days | `api_request_count` |
| API Latency — Reads (P95) | < 500ms | 30 days | `api_request_duration` (GET/HEAD) |
| API Latency — Writes (P95) | < 1000ms | 30 days | `api_request_duration` (POST/PUT/PATCH/DELETE) |
| API Error Rate | < 1% | 30 days | `api_request_count` |
| Health Check Availability | ≥ 99.95% | 7 days | Synthetic probe of `/api/livez` |
| Repository Latency (P95) | < 100ms | 7 days | `repo_method_duration` (OI-3 part 2) |
| RPO (Recovery Point) | ≤ 1 hour *(target; **24h achieved** — see SLO 6)* | continuous | Daily GCE disk snapshot + monthly `restore-test-gcp.sh` |
| RTO (Recovery Time) | ≤ 4 hours | per incident | `deploy/apply.sh` rollback / disk-from-snapshot / runbook |

---

## Load-Test Validation of SLOs

The four SLOs above are **production targets** measured against live OTel
telemetry. The k6 scenarios in `tests/load/` are **synthetic validators**
that exercise the same code paths under controlled load to surface
regressions *before* they reach production. Together they form the
performance-governance loop:

```
production OTel  ──→  SLOs (this doc)  ──→  k6 thresholds  ──→  CI smoke
       ↑                                                              ↓
       └──────────── monthly full-baseline runs ←────────────────────┘
```

### Critical user journeys → k6 scenarios → SLOs

| Critical journey                   | k6 scenario             | Validates SLO        |
|------------------------------------|-------------------------|----------------------|
| Cold credentials login             | `tests/load/auth.js`    | SLO 1, 2, 3          |
| Authenticated controls/risks/evidence list reads | `tests/load/lists.js`   | SLO 1, 2, 3          |
| Control creation + evidence upload | `tests/load/mutations.js` | SLO 1, 2, 3        |

`/api/livez` and `/api/readyz` (SLO 4) are not k6-tested — they're the
job of synthetic probes (Blackbox Exporter or platform health checks).

### Per-scenario metric → SLO mapping

| k6 scenario      | k6 metric (tagged)                                    | Maps to        | What it tells you                        |
|------------------|-------------------------------------------------------|----------------|------------------------------------------|
| auth.js          | `http_req_duration{step:csrf}`                        | SLO 2          | CSRF endpoint p95.                       |
| auth.js          | `http_req_duration{step:login}`                       | SLO 2 (write)  | bcrypt-bound login latency.              |
| auth.js          | `http_req_duration{step:session}`                     | SLO 2          | Session-verify latency.                  |
| auth.js          | `auth_full_login_ms` (custom Trend)                   | SLO 2 (E2E)    | End-to-end login transaction.            |
| auth.js          | `http_req_failed{step:*}`                             | SLO 1, 3       | Per-step error rate.                     |
| lists.js         | `http_req_duration{endpoint:controls\|risks\|evidence}` | SLO 2 (read) | Per-endpoint read p95.                   |
| lists.js         | `http_req_failed{type:list}`                          | SLO 1, 3       | Aggregate read error rate.               |
| lists.js         | `list_success_rate` (custom Rate)                     | SLO 1          | Aggregate availability across reads.     |
| mutations.js     | `http_req_duration{op:create_control}`                | SLO 2 (write)  | Control INSERT + audit p95.              |
| mutations.js     | `http_req_duration{op:upload_evidence}`               | SLO 2 (write)  | File-write + 2 INSERTs + audit p95.      |
| mutations.js     | `http_req_failed{op:*}`                               | SLO 1, 3       | Per-op error rate.                       |
| mutations.js     | `mutation_loop_ms` (custom Trend)                     | SLO 2 (E2E)    | Full create + upload transaction.        |

### Why k6 thresholds are not identical to production SLOs

The production p95 SLO is **< 500ms across ALL API requests**. The k6
thresholds are intentionally **looser**:

| Reason                                                                                    | Effect                                            |
|-------------------------------------------------------------------------------------------|---------------------------------------------------|
| k6 runs against a single CI runner (4 vCPU, 16 GB RAM); production runs multi-replica.    | ~2× absolute latency floor.                       |
| k6 hits a freshly seeded DB with cold caches; production has warm caches + connection pools. | First-iteration latency dominated by cold paths. |
| Mutations write to RLS + audit log + encryption — all serialized at the row level.        | Mutation budget naturally wider than read budget. |
| The smoke profile (10 VUs × 30s) yields ~200 samples per op; production p95 is computed over millions. | A single retry can move a k6 rate noticeably.    |

The k6 budgets are calibrated as **regression detectors**, not as the
SLO itself: a breach implies a 2–3× regression that will *also* breach
the production SLO once the change ships and the cache warms up. They
are deliberately not a substitute for the production SLO measurement.

### CI smoke vs full-baseline thresholds

There are two performance gates with different jobs:

#### CI smoke — runs on every PR

`Load Smoke (k6)` job in `.github/workflows/ci.yml`. **10 VUs × 30s**.
Runs `tests/load/mutations.js` only — that's where regressions are most
likely (RLS + audit + encryption + storage all interact on the write
path). Auth and read-path baselines stay in the on-demand workflow.

| Metric                                       | CI smoke gate    | Behavior on breach |
|----------------------------------------------|------------------|--------------------|
| `http_req_failed{op:create_control}`         | rate < 2%        | **PR CI fails**    |
| `http_req_failed{op:upload_evidence}`        | rate < 2%        | **PR CI fails**    |
| `http_req_duration{op:create_control}`       | p95 < 1500ms     | **PR CI fails**    |
| `http_req_duration{op:create_control}`       | p99 < 3000ms     | **PR CI fails**    |
| `http_req_duration{op:upload_evidence}`      | p95 < 2000ms     | **PR CI fails**    |
| `http_req_duration{op:upload_evidence}`      | p99 < 4000ms     | **PR CI fails**    |
| `mutation_loop_ms`                           | p95 < 3000ms     | **PR CI fails**    |
| `checks{check:control_created}`              | rate > 98%       | **PR CI fails**    |
| `checks{check:evidence_uploaded}`            | rate > 98%       | **PR CI fails**    |

Sized for signal-per-dollar: ~5 minutes added to PR CI; ~200 samples
per op (enough for p95 to be meaningful without flaking).

#### Full baselines — manual `workflow_dispatch` + nightly main smoke

`Load Test (k6)` workflow at `.github/workflows/load-test.yml`. Runs
all three scenarios. The script-level thresholds in each scenario apply;
they are tighter than the CI smoke because the sample size is larger.

| Scenario     | Profile          | Tightest threshold                              | Closest production SLO                |
|--------------|------------------|-------------------------------------------------|---------------------------------------|
| auth.js      | 50 / 100 / 200 VUs × 2m | `http_req_duration{regime:latency,step:login}` p95 < 1500ms | SLO 2 (write — bcrypt is the floor)   |
| auth.js      | "                | `auth_full_login_ms{regime:latency}` p95 < 2000ms | SLO 2 (E2E)                          |
| auth.js      | "                | `http_req_failed{step:*}` rate < 1%              | SLO 1 + 3                             |
| auth.js      | "                | `auth_success_count{regime:saturation}` count floor | capacity collapse detector — see below |
| lists.js     | 50 / 100 / 200 VUs × 2m | `http_req_duration{regime:latency,endpoint:*}` p95 < 800ms | SLO 2 (read — looser than 500ms ceiling because of cold-cache + tenant RLS overhead in test env) |
| lists.js     | "                | `http_req_failed{type:list}` rate < 1%          | SLO 1 + 3                             |
| lists.js     | "                | `list_iterations{regime:saturation}` count floor | capacity collapse detector — see below |
| mutations.js | 50 / 100 / 200 VUs × 2m | `http_req_duration{op:create_control}` p95 < 1500ms | SLO 2 (write)                  |
| mutations.js | "                | `http_req_duration{op:upload_evidence}` p95 < 2000ms | SLO 2 (write — multipart + storage) |
| mutations.js | "                | `http_req_failed{op:*}` rate < 2%                | SLO 1 + 3                             |

### Calibrating the auth budgets — why latency is gated at ONE VU

Note the `regime:latency` tag on every latency threshold above. It is
load-bearing, and it is the reason the nightly load test spent 40
consecutive runs red while every functional check passed.

`auth.js` and `lists.js` each run **two scenarios, sequentially**:

| Regime       | Profile                    | What it can measure            | What it gates |
|--------------|----------------------------|--------------------------------|---------------|
| `latency`    | 1 VU, no think-time        | service time — nothing queues  | the p95/p99 budgets |
| `saturation` | ramping VUs + think-time   | capacity + behaviour under overload | error rate, check rate, a throughput floor |

The split exists because **a latency threshold on a saturated system
measures the arrival rate you chose, not the code.** A login is
bcrypt-bound, and `bcryptjs` is pure JavaScript on the Node main
thread, so one process serves one compare at a time and extra cores do
not help:

| Measurement                                   | Value        |
|-----------------------------------------------|--------------|
| serial `bcrypt.compare`, `BCRYPT_COST=12`     | ~405 ms      |
| single-process login capacity                 | ~2.4 logins/s |
| offered load at the nightly's 25 VUs          | ~25 logins/s |

At ~10x capacity, Little's Law puts p95 at ≈ VUs / capacity ≈ 10s
regardless of how fast the login path is — and the old single-scenario
file asserted p95 < 1500ms against exactly that queue. Measured on CI:
**p95 8.62s, 1554/1554 checks passing, zero HTTP failures.** The gate
was ~7x outside the implementation's physical capacity and could never
have gone green.

Uncontended, the same login measures **p95 ~794ms on a dev box** —
comfortably inside the published budget. Same code, same build; the
only difference is whether anything was queued in front of it. (CI is
faster still: ~355ms mean p95 across 11 nightlies — see "Re-validated
against CI" below. The 794 figure is kept here because it is the
number the 8.62s contended measurement was taken against, and the
contrast is the point.)

**Capacity floors are collapse detectors, not precision gates.**
Throughput on a shared runner is not a precise instrument: two
back-to-back runs on one dev box returned 176 then 113 completed
logins purely because the host's load average climbed. A 2x throughput
drop from a noisy neighbour is indistinguishable from a 2x code
regression, so the floors sit at ~30% of the observed line and fire
only on an unambiguous collapse. Precision belongs to the trend — the
per-run figures land in the summary artifact.

**When you add a latency threshold to a load scenario, tag it
`regime:latency`.** An untagged latency threshold silently spans both
regimes and re-creates this bug.

**Re-validated against CI, 2026-08-20.** The budgets above were set
from dev-box samples, and `tests/load/auth.js` carried a note asking
for them to be re-checked against real nightlies. Eleven consecutive
nightly runs (2026-08-10 → 08-20) have now been read out of the
summary artifacts:

| metric | CI p95 range | mean | budget | headroom |
|---|---|---|---|---|
| csrf | 3.0 – 4.7 ms | 3.9 ms | 500 ms | 106× |
| session | 5.6 – 8.6 ms | 7.3 ms | 500 ms | 58× |
| login p95 | 295.0 – 403.6 ms | 355.0 ms | 1500 ms | 3.7× |
| login p99 | 300.7 – 432.2 ms | 385.2 ms | 2500 ms | 5.8× |
| E2E p95 | 303.0 – 413.0 ms | 365.1 ms | 2000 ms | 4.8× |

Worst single login sample across the set: 763 ms.

**Correction (same day).** The first version of this table said *"all 143
auth threshold results reported `ok`"*. That is true and it was
misleading: **33 of those 143 carried no data at all.** The three
`checks{check:...}` thresholds in `auth.js` — and one in `lists.js` — were
keyed on `check`, a tag k6 sets *itself* to the individual check's name,
so the tag passed to `check()` never bound. Every one of those
sub-metrics recorded **zero samples in all eleven runs**, and k6 passes a
threshold that has no samples. They had never once been evaluated
against data.

The 110 thresholds that did carry data all reported `ok`, and the latency
figures above are unaffected — they come from `http_req_duration`, which
was always populated.

The check gates are fixed. The first fix was not: it put `count>0` on the
`checks{…}` thresholds, and `checks` is a **Rate**, which k6 permits only
`rate` on — so the Load Smoke job became a parse error and stopped running
across three merges to `main`. The floor now sits on a `check_runs`
**Counter** submetric, which fails at 0 when a tag stops binding, verified
locally against k6 v1.4.0. See `tests/load/README.md`.

**No number moved, and the reason is a choice worth stating.** These
are **SLO-conformance gates, not regression detectors** — 1500 ms is
the login budget this document publishes, so the gate sits on the
stated SLO rather than being fitted to whichever machine last ran it.
Fitting to CI would produce a tighter number that flakes on a dev box
(the same build measured 794 / 1150 / 1170 ms there purely on host
load) while catching nothing extra in CI.

The accepted cost: a `BCRYPT_COST` 12 → 14 bump (~4×) still trips
1500 ms; a 12 → 13 (~2×) would not. If we ever want that sensitivity,
the instrument is a **run-over-run delta check on the summary
artifact**, not a lower absolute budget. That is a different gate and
belongs in its own issue — lowering these numbers would quietly trade
a stable conformance gate for an unstable regression one.

Run cadence:
- **PR**: CI smoke (mutations only, 10 VUs × 30s) — automatic.
- **Nightly main**: 25 VUs × 1m smoke across both auth + lists for trend tracking — automatic via cron in `load-test.yml`. Failures don't block deploys but populate the trend graph.
- **On-demand**: 50/100/200 VU baselines via manual `workflow_dispatch`. Run before a release, after a major hot-path change, or when investigating a production p95 drift.

### How to read a k6 result

A k6 run produces three things you care about:

1. **Pass/fail status** — exit code 0 if every threshold held; non-zero if any breached. CI keys off this. The console output ends with either nothing (pass) or `error msg="thresholds on metrics '...' have been crossed"`.

2. **Per-metric stats** — for each metric the run prints `avg / min / med / max / p(90) / p(95) / p(99)`. Read **p(95)** for SLO comparison; p(99) is your tail-latency regression detector. Don't trust avg — it's pulled around by outliers in either direction.

3. **req/s and VUs** — `http_reqs / iterations` rate at the end shows sustained throughput. Compare against the previous baseline run for the same VU count: a drop of >15% req/s under the same VU is a throughput regression even if latency thresholds pass.

| Number you see       | What it means                                                  | Compare to                              |
|----------------------|----------------------------------------------------------------|-----------------------------------------|
| `p(95)` per metric   | 95th-percentile latency under the test load                    | The threshold for that metric.          |
| `http_req_failed`    | Fraction of requests that returned ≥ 4xx OR network-failed     | The error-rate threshold (1% or 2%).    |
| `checks` rate        | Fraction of correctness assertions that passed                 | Should be ~100%; <98% means broken.     |
| `http_reqs/s`        | Sustained throughput over the steady-state window              | Previous baseline run at same VU count. |
| `iterations/s`       | VU-loop completion rate                                        | Same.                                   |

The `tests/load/results/*-summary.json` files written by `handleSummary`
carry the full structured output for diff-against-baseline tooling.

### Operating procedure

#### When CI smoke fails on a PR

The Load Smoke job exited non-zero. Open the artifact at
`load-smoke-results-<run_id>` and the GitHub Actions log:

1. Identify the breached threshold from the trailing `error msg=...` line.
2. Pull `mutations-summary.json` from the artifact; the metric structure
   gives you avg/p95/p99 directly.
3. Compare against the most recent successful main-branch run's artifact
   (retention is 14 days). Look for the same metric.
4. Decide:
   - **Real regression** — the PR introduced a slower path. Fix or revert. Latency-cliff regressions usually trace to: a new sync DB call inside a loop, a missing index, a serialised audit-log write, or unintended encryption of a hot field.
   - **Flake** — single attempt only, no other CI signal. Re-run the job. Two failures in a row = treat as real.
   - **Infra noise** — the runner was on a slow shared VM. Check the same job's runtime: if `Wait for /api/health` took >30s, the runner was congested. Re-run.

If you must merge a PR with the smoke job failing (e.g. the regression is upstream of your change), document the reason in the PR description and open an issue tagged `slo:investigate`.

#### When the full baseline misses an SLO

The 50/100/200 VU `workflow_dispatch` run breached a threshold tighter than the CI smoke:

1. Re-run the same scenario against staging or another runner to rule out CI variance.
2. Pull production OTel data (`api_request_duration` histogram for the same `http_route`) for the prior week. If production p95 is also drifting → real regression in the running deploy. If production is healthy → CI-environment-only issue.
3. Open an SLO-watch ticket. Decide: tighten the k6 threshold (and fix the cause), refactor the hot path, or escalate the SLO target if user-facing expectations have shifted.

#### Updating thresholds

**Loosening a k6 threshold is a regression signal.** Don't do it to make a red CI green. The flow:

1. If the threshold is unrealistic for the workload, change the *production SLO* in this doc first. The k6 threshold then follows.
2. If the threshold is realistic but the code regressed, fix the code.
3. If neither — investigate before relaxing. A loosened threshold without an SLO update silently hides regressions from future PRs.

The k6 thresholds are calibrated as a >2× margin against the production
SLO. Tightening them as the codebase improves (and the absolute latency
floor drops) is the long-term direction; loosening them is a last resort.

### Cross-references

- **k6 runbook**: [`tests/load/README.md`](../tests/load/README.md) — install, env, run commands, threshold tables.
- **Workflows**:
  - PR smoke: `Load Smoke (k6)` job in `.github/workflows/ci.yml`.
  - Manual + nightly: `.github/workflows/load-test.yml`.
- **Production telemetry**: see SLO 1–3 above for the OTel metric names and PromQL.

---

## Metric Dependencies

### Available Today (Phase 1)

| Metric | Status | Source |
|---|---|---|
| `api_request_count` | ✅ Emitted | `metrics.ts` via `withApiErrorHandling` |
| `api_request_duration` | ✅ Emitted | `metrics.ts` via `withApiErrorHandling` |
| `api_request_errors` | ✅ Emitted | `metrics.ts` via `withApiErrorHandling` |
| Structured JSON logs | ✅ Emitted | Pino logger → stdout |

### Required Infrastructure

| Component | Purpose | Status |
|---|---|---|
| OTel Collector | Receives OTLP metrics/traces from the app | ⏳ Deploy alongside app |
| Prometheus | Stores metrics from OTel Collector | ⏳ Deploy alongside app |
| Grafana | Dashboard visualization and alerting | ⏳ Deploy alongside app |
| Blackbox Exporter | Synthetic health probe monitoring | ⏳ Optional |

### Pipeline

```
App (metrics.ts)
  → OTLP HTTP (:4318)
    → OTel Collector
      → Prometheus remote-write
        → Grafana (dashboards + alerts)
```

---

## Revision History

| Date | Change |
|---|---|
| 2026-04-18 | Initial SLO definitions (Epic 19 Phase 2) |
| 2026-04-27 | Epic OI-3: split SLO 2 into reads (<500ms) and writes (<1000ms); add SLO 5 (repository P95 from `repo_method_*` metrics); add SLO 6 (RPO 1h, met by RDS PITR + monthly `restore-test.sh`); add SLO 7 (RTO 4h, met by `helm rollback` / `restore-db-instance` paths documented in `docs/incident-response.md`) |
| 2026-04-28 | Added Load-Test Validation section: k6 scenario → SLO mapping, CI smoke vs full-baseline thresholds, operating procedure (GAP-11 closure). |
