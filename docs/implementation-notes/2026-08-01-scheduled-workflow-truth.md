# 2026-08-01 — the two scheduled workflows, and what their red meant

**Commit:** _(this change)_

Two non-blocking scheduled workflows had been red for a long time:
`Load Test (k6)` for **40 consecutive runs** since 2026-06-25, and
`Restore Test` on both of its runs. Neither gated a PR, so both had
become wallpaper. They turned out to mean two completely different
things, and only one of them was about the code.

## Design

### Load Test — a gate outside the implementation's physics

Every functional check passed: **1554/1554 checks, zero HTTP
failures.** Only latency thresholds failed — login p95 **8.62s**
against a `p95 < 1500ms` budget.

The cause is arithmetic, not a regression. `bcryptjs` is pure
JavaScript on the Node main thread, so a `compare` at `BCRYPT_COST=12`
costs ~405ms of single-thread CPU and extra cores do not help:

| Measurement | Value |
|---|---|
| serial `bcrypt.compare` | ~405 ms |
| single-process login capacity | ~2.4 logins/s (CI 2.47, dev box 2.4) |
| offered load at the nightly's 25 VUs | ~25 logins/s |

At ~10x capacity, Little's Law puts p95 at ≈ VUs/capacity ≈ 10s no
matter how fast the login path is. The gate sat ~7x outside what the
implementation can physically do; it could never have gone green.

The fix is to stop conflating two questions. `auth.js` and `lists.js`
now each run two scenarios **sequentially**:

```
login_latency      1 VU, no think-time      → nothing queues
                                              gates p95/p99
login_saturation   ramping VUs + think-time → 10x overload
                                              gates error rate,
                                              check rate, a
                                              throughput floor
```

Uncontended, the same login measures **p95 794ms** — comfortably inside
the published budget. Same code, same build; the only difference is
whether anything was queued in front of it.

### Restore Test — a true negative nobody read

It failed at "Configure AWS credentials (OIDC)" in **12 seconds**. The
workflow drilled AWS RDS point-in-time recovery. This product does not
run on RDS: production is one GCE VM with Postgres in a local Docker
volume. The AWS account it assumed does not exist, so
`infra/scripts/restore-test.sh` had **never executed once** — while
`tests/guards/oi-3-backup-restore.test.ts` held ~25 permanently-green
assertions about that script's flags.

What the noise concealed was worse than a broken workflow:

> **Production had no automated backup of any kind.** No cron, no
> systemd timer, no GCE snapshot schedule, zero snapshots. The only
> dumps on the box were four ad-hoc pre-deploy `pg_dump`s from 1–4
> July, sitting on the same disk as the database they backed up.

Fixed by creating the schedule, taking an immediate first snapshot, and
replacing the AWS drill with one that runs against the real thing.

## Files

| File | Role |
|---|---|
| `tests/load/auth.js` | Split into `login_latency` (1 VU, gates p95) + `login_saturation` (gates error rate + capacity floor). Budgets calibrated from a measured run. |
| `tests/load/lists.js` | Same split. Also fixes the per-VU login: k6 resets the cookie jar between iterations while module state survives, so every iteration after the first ran unauthenticated. |
| `tests/load/lib/config.js` | `toSeconds()` + `durationSec`/`rampUpSec`/`rampDownSec`/`latencyVus`/`latencySeconds` so scenarios can schedule sequentially and derive floors. |
| `infra/scripts/restore-test-gcp.sh` | **New.** The real drill: schedule-attached + freshness assertions, disk from snapshot, throwaway VM, real Postgres over the recovered data dir, validation battery, teardown from a trap. |
| `infra/scripts/restore-test.sh`, `pg-dump-to-s3.sh` | **Deleted.** AWS RDS / S3 tooling for infrastructure that does not exist. |
| `.github/workflows/restore-test.yml` | Re-pointed at the GCP drill; preflights its config and names what is missing. |
| `tests/guards/oi-3-backup-restore.test.ts` | Rewritten against the deployed posture; asserts the AWS scripts stay retired. |
| `docs/backup-restore.md` | **New.** Operator runbook: what the backup is, what it does not buy, how to drill it, how to recover. |
| `docs/slos.md`, `docs/incident-response.md`, `CLAUDE.md` | Corrected the RPO claim and the restore path. |

## Decisions

- **Latency is gated at 1 VU, not under load.** A latency threshold on
  a saturated system measures the arrival rate the script chose. The
  `regime:latency` tag is load-bearing; an untagged latency threshold
  spans both scenarios and re-creates the bug. Written into
  `docs/slos.md` and the load README as a rule for new scenarios.

- **Capacity floors are collapse detectors, not precision gates.** Two
  back-to-back runs on one dev box returned 176 then 113 completed
  logins purely because the host's load average climbed. On a shared
  runner a 2x throughput drop is indistinguishable from a 2x code
  regression, so the floors sit at ~30% of the observed line and fire
  only on an unambiguous collapse. Gating tightly would have shipped a
  new flaky red to replace the old permanent one.

- **The lists scenario was fixed to match its three siblings, not with
  `noCookiesReset`.** `mutations.js`, `ag-parcel-list.js` and
  `ag-inventory-pagination.js` already log in once in `setup()` and
  re-attach the cookie explicitly — each carrying a comment that the
  per-VU jar "does NOT reliably carry" the session. `lists.js` is
  simply the one that never got the fix, because the workflow's `if:`
  gate meant nothing ever ran it. A fourth approach would have been a
  fourth thing to learn.

- **Snapshots over `pg_dump` to GCS.** The VM's service account has
  read-only storage scope and the project has no bucket, so a dump
  pipeline needed a scope change — which needs a VM stop/start. A disk
  snapshot schedule needed neither and was live in minutes, which
  mattered when the starting position was zero backups. The tradeoff
  is crash-consistency rather than a logical dump; the drill boots a
  real Postgres over the restored directory precisely so that WAL
  recovery is exercised rather than assumed.

- **The RPO target was left at 1 hour and marked NOT MET, not quietly
  rewritten to 24h.** Daily snapshots with no WAL archive give an RPO
  of up to 24 hours. Editing the target down to match what is deployed
  would have made the doc self-consistent and the gap invisible.

- **An unconfigured restore drill FAILS rather than skips.** CI has no
  credentials for the production project yet, so the workflow cannot
  run the drill. It exits 1 with a step summary saying the drill did
  not run and that this is not a statement about the backup's health.
  A skipped restore test is indistinguishable from a passing one —
  the repo's own "green is not the same as executed" lesson.

- **Every bug in the new drill was found by running it**, four times,
  against the real snapshot: the VM/disk name collision (the implicit
  boot disk is named after the instance), the missing wait for sshd,
  the unprivileged `test -d` under `/var/lib/docker` (mode 0710, so it
  returns false for a path that exists — reading exactly like "the
  backup has no database in it"), and the wrong DB role. Shipping it
  unexecuted would have repeated the failure it replaces.

## Verification

The drill was run end-to-end against the production snapshot and
passed: **215 migrations applied, 150 `tenant_isolation` policies,
`app_user` present, 100 `AuditLog` rows in 14 days, Postgres accepting
connections 2s after WAL recovery**, `DATA_ENCRYPTION_KEY` present in
the restored `/opt/agrent/.env`, and no leaked VM or disk afterwards.

Both k6 scenarios were run at the nightly profile (25 VUs × 1m) against
a production build and exit 0.

## Still open

- **RPO is 24h against a 1h target.** Closing it needs continuous WAL
  archiving or a managed Postgres.
- **The drill cannot run from CI** until Workload Identity Federation
  is configured for the production GCP project. Until then the monthly
  workflow fails loudly and the drill must be run by hand.
