# 2026-09-24 — zero-success route check

**Commit:** `feat(observability): report API routes that failed with zero successes`

## Design

An iOS client called `POST /api/t/{slug}/insurance/leads` with a body missing
a required field. Every request 400'd, for weeks, and nobody noticed.
Production alerting is one GCP Cloud Monitoring uptime check on
`/api/readyz`; to that check a route failing 100% of the time and a route
nobody calls are the same observation.

### What already recorded outcomes — and why it could not answer

`withApiErrorHandling` calls `recordRequestMetrics({ method, route, status,
durationMs })` on **every** response — success, thrown error, and
rate-limited — so the observation point already existed. Where it went did
not survive:

| Sink | Why it cannot answer "did this route ever succeed today?" |
| --- | --- |
| OTel `api.request.count` / `.errors` | `initTelemetry` is hard-gated on `OTEL_ENABLED === 'true'` with an OTLP collector at `OTEL_EXPORTER_OTLP_ENDPOINT`. Neither appears anywhere under `deploy/`, so the instruments are created against the noop meter and discarded. |
| Pino `request completed` / `request failed` | Container stdout. Nothing inside the app can query it. |
| `AuditLog` / `OrgAuditLog` | Domain mutations, not HTTP outcomes — no status code, no route. |
| Sentry `captureError` | 5xx only (`captureError` skips 4xx), and outbound. The bug was a 4xx. |

No Prisma model records per-route outcomes, and none was added: the data has
no tenant axis (the route label deliberately collapses the tenant slug), and
a model would owe RLS policies, a migration and an index-coverage entry for
a rolling 24h counter that wants a TTL, not a table.

### What was added

`src/lib/observability/route-outcomes.ts` — one Redis hash per UTC hour:

```
key    api:route-outcome:v1:<YYYY-MM-DDTHH>
field  <status>|<METHOD> <route>       e.g. 400|POST /api/t/:tenantSlug/insurance/leads
value  request count
```

`recordRequestMetrics` increments it in the same call that feeds the OTel
counter — one pipeline (HINCRBY + EXPIRE), one round trip, fire-and-forget,
never awaited on the response path and never able to reject into it. Redis
is already a hard dependency (BullMQ, list cache, rate limiting) and every
compose file pins `--maxmemory-policy noeviction`
(`tests/guards/redis-eviction-policy.test.ts`), so these counters cannot be
evicted out from under the reader.

`src/app-layer/jobs/zero-success-route-check.ts` — daily at 06:45 UTC, folds
the last 24 hourly buckets and reports every `(method, route)` with **at
least 5 responses ≥ 400 and ZERO responses < 400**, worst first, capped at
20 routes, as one `logger.warn('api routes failing with zero successes', …)`
carrying a flat `failingRoutes` list plus a per-route status breakdown.

## Files

| File | Role |
| --- | --- |
| `src/lib/observability/route-outcomes.ts` | Field encoding, the fire-and-forget recorder, the window reader, and the pure fold |
| `src/lib/observability/metrics.ts` | `recordRequestMetrics` also writes the durable counter (the single seam) |
| `src/lib/observability/index.ts` | Barrel re-export |
| `src/app-layer/jobs/zero-success-route-check.ts` | `detectZeroSuccessRoutes` (pure) + the `runJob`-wrapped run |
| `src/app-layer/jobs/types.ts` | `ZeroSuccessRouteCheckPayload`, `JobPayloadMap`, `JOB_DEFAULTS` |
| `src/app-layer/jobs/schedules.ts` | `ALL_SCHEDULES` entry, `45 6 * * *` |
| `src/app-layer/jobs/executor-registry.ts` | `executorRegistry.register('zero-success-route-check', …)` |
| `tests/unit/zero-success-route-check.test.ts` | Encoding, recorder, fold, reader, rule, job, registration |
| `tests/unit/job-scope-audit.test.ts`, `tests/unit/job-tenant-isolation-regression.test.ts`, `tests/regression/infrastructure-guards.test.ts` | The four test-side registrations a new job owes |

## Decisions

- **Zero successes, not a failure RATE.** A route erroring 40% of the time is
  a bug report. A route that has never once succeeded in a day while being
  called repeatedly is a broken CONTRACT — a client sending a shape the
  server will never accept. The rate threshold would have to be tuned per
  route; "no success at all" needs no tuning and is exactly the observed bug.

- **Any status ≥ 400 is a failure, 401 and 429 included.** A client
  hammering into auth failures or rate limits with no successful call in a
  day is the same class of broken. The `minFailures = 5` floor is what keeps
  a route probed twice by a scanner out of the report.

- **The recorder lives inside `recordRequestMetrics`, not at the three call
  sites in `withApiErrorHandling`.** One seam means the OTel counter and the
  durable counter cannot disagree about which requests they saw, and a
  future response path added to the wrapper is covered automatically.

- **A failed probe is UNKNOWN, never clean.** `readRouteOutcomeWindow`
  returns `available: false` for no-Redis and for a read error, and the job
  logs a distinct warn for that and for "Redis answered but nothing was
  counted". A check that silently stops checking is how the original bug
  survived weeks; reporting an empty probe as "clean" would rebuild it.

- **No model, no migration, no alerting infrastructure.** The deliverable is
  a structured log line. `infra/alerts/rules.yml` describes an Alertmanager
  stack this deployment does not run, so a rule added there would be
  decoration.

- **Numeric path segments are collapsed on top of `normalizeRoute`.** That
  helper collapses UUIDs, the tenant slug and 20+ char opaque ids but leaves
  `/parcels/1234` alone, which would grow one hash field per entity. Every
  bucket also carries a TTL, so any remaining cardinality surprise self-heals
  within a day rather than growing forever.

- **Ties are broken explicitly.** `dominantStatus` resolves a tie to the
  LOWEST status code and the finding sort falls through failures → route →
  method, so the same window always produces the same report and the
  `maxReported` slice is never a coin toss between two tied routes.
