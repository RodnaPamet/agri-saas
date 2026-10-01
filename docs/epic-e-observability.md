# Epic E — Observability & Operational Hardening (operator + contributor index)

> Three remediations that close the operational gaps left after Epic D.
> Read the source files linked below for details; come back here for
> the architecture summary, verification commands, and rollback
> procedures.

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  E.2 — Audit-stream delivery guarantees                               │
│        src/app-layer/events/audit-stream.ts::deliverBatch             │
│          ─ up to 3 attempts on 408 / 429 / 5xx / network throw        │
│          ─ linear backoff (1 s, 2 s)                                  │
│          ─ deterministic X-Inflect-Batch-Id = Idempotency-Key         │
│              → consumer SIEM dedupes retries without our help         │
│          ─ kill-switch env AUDIT_STREAM_RETRY_ENABLED=0               │
│        Headers / batch-id convention lives in                         │
│          src/app-layer/events/webhook-headers.ts                      │
│          → re-used by every future outbound webhook                   │
│                                                                       │
│  E.3 — Graceful shutdown                                              │
│        src/lib/observability/shutdown.ts::installShutdownHandlers     │
│          SIGTERM / SIGINT                                             │
│            └─ flushAllAuditStreams()  ≤ SHUTDOWN_AUDIT_FLUSH_MS       │
│            └─ shutdownTelemetry()     ≤ SHUTDOWN_OTEL_MS              │
│            └─ shutdownSentry()        ≤ SHUTDOWN_SENTRY_MS            │
│          ─ NO process.exit — next start owns the HTTP lifecycle       │
│          ─ idempotent install (guard + process.once)                  │
│          ─ per-stage Promise.race — no drain can hang the container   │
│        Budgets in src/lib/observability/shutdown-budget.ts            │
│                                                                       │
│  E.4 — HIBP coverage ratchet                                          │
│        tests/guardrails/hibp-coverage.test.ts                         │
│          ─ curated HIBP_REQUIRED_ROUTES (today: register only)        │
│          ─ structural scan: any route.ts that parses a                │
│              password-shaped Zod field must register here             │
│          ─ regression proof: mutates register/route.ts in memory      │
│              and asserts the guardrail catches the removal            │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

| Layer | Source of truth | Companion tests |
|---|---|---|
| E.2 — retry + idempotency | `src/app-layer/events/audit-stream.ts` (retry loop around `postFn`), `src/app-layer/events/webhook-headers.ts` (`buildOutboundHeaders`, `computeBatchId`) | `tests/unit/audit-stream.test.ts` (cases A–D — happy retry, double-fail, network throw, kill-switch), `tests/unit/webhook-headers.test.ts` (header shape + determinism) |
| E.3 — SIGTERM drain | `src/lib/observability/shutdown.ts` (`installShutdownHandlers`), `src/lib/observability/instrumentation.ts` (`shutdownTelemetry`), `src/lib/observability/sentry.ts` (`shutdownSentry`), `src/lib/observability/shutdown-budget.ts` | `tests/unit/observability/shutdown.test.ts` (order, idempotence, partial-failure isolation), `tests/unit/observability/shutdown-helpers.test.ts` (timeout + noop paths), `tests/guardrails/shutdown-budget-sanity.test.ts` (sum ≤ ceiling) |
| E.4 — HIBP guardrail | `tests/guardrails/hibp-coverage.test.ts` + the curated `HIBP_REQUIRED_ROUTES` constant inside it, over the import-following detector in `tests/helpers/password-schema-graph.ts` | Self-contained; extends `src/app/api/auth/register/route.ts` as the seed entry |

## Why each design choice

### E.2 — Retry-in-`deliverBatch`, not retry-in-`defaultPost`

`postFn` is an injected seam that tests mock. If the retry loop lived
inside `defaultPost`, every existing test that mocks `postFn` would
*bypass* the retry logic — tests would pass while production behaved
differently. Placing the loop in `deliverBatch` means the single-POST
seam stays simple *and* tests exercise the full retry path by setting
mock responses per-call via `__setStreamPost`.

Network throws are converted inline to `{ ok: false, status: 0 }`
so the loop's retry decision runs against a uniform shape. `0` is
added to `isRetryable` for this reason.

### E.2 — Deterministic batch id as idempotency key

A retry re-sends the same body. `computeBatchId` is a SHA-256 over
`(tenantId, schemaVersion, eventIds)` — the inputs are stable across
the retry window, so the header is stable too. Consumer SIEMs that
store idempotency keys can safely drop the second delivery on the
floor without coordinating with our retry policy. This is why the
batch-id function is marked load-bearing in the module docstring and
hashes *ids only* (not event bodies) — payload-format tweaks must
not change the id.

### E.3 — No `process.exit` in our handler

`next start` is PID 1 in the container (the Dockerfile entrypoint
uses `exec`, replacing the shell). Next.js installs its own
SIGTERM handler that closes the HTTP server and exits naturally.
Our handler runs *in parallel* and drains observability. If we
called `process.exit(0)` we would amputate Next's HTTP drain
mid-request. Both handlers finish, the event loop empties, Node
exits — that's the contract.

### E.3 — Per-stage `Promise.race` bounds

A SIEM that goes unresponsive can block `flushAllAuditStreams` for
minutes. Under Kubernetes' default 30 s `terminationGracePeriodSeconds`
that means Next's HTTP drain gets SIGKILL'd before it finishes. We
wrap each stage with `Promise.race` against a per-stage budget from
`shutdown-budget.ts`. The sum (7 s today) must fit under the
`SHUTDOWN_TOTAL_CEILING_MS` (20 s) — asserted by
`tests/guardrails/shutdown-budget-sanity.test.ts`, so no future PR
can blow the envelope.

### E.4 — Curated list + structural scan, not just one or the other

The sanitisation guardrail (Epic C.5 / D.2) proved the template:
curated list with per-entry reasons gives self-documenting failures,
structural scan catches things the list forgot. Glob-only would let
`// checkPasswordAgainstHIBP` in a comment pass. `toContain`-style
substring matching would let an unused import pass. The HIBP test
pairs a regex-based import detector with a post-strip-comments call
detector, plus a mutation-based regression proof (clone the register
route in memory, remove HIBP, assert the detector catches it).

## Verification commands

### E.2 — audit-stream retry
```bash
# Unit tests for all four retry cases
SKIP_ENV_VALIDATION=1 npx jest tests/unit/audit-stream.test.ts --no-coverage

# Module-level idempotency helper
SKIP_ENV_VALIDATION=1 npx jest tests/unit/webhook-headers.test.ts --no-coverage

# Confirm kill-switch is recognised by the env loader
node -e "process.env.AUDIT_STREAM_RETRY_ENABLED='0'; import('./src/env.ts').then(m => console.log(m.env.AUDIT_STREAM_RETRY_ENABLED))"
# → '0'
```

### E.3 — graceful shutdown
```bash
# Unit — SIGTERM triggers ordered drain, idempotence, partial-failure isolation
SKIP_ENV_VALIDATION=1 npx jest tests/unit/observability/shutdown.test.ts --no-coverage

# Unit — paired shutdown helpers noop + timeout contracts
SKIP_ENV_VALIDATION=1 npx jest tests/unit/observability/shutdown-helpers.test.ts --no-coverage

# Guardrail — sum of stage budgets stays under the ceiling
SKIP_ENV_VALIDATION=1 npx jest tests/guardrails/shutdown-budget-sanity.test.ts --no-coverage
```

Local smoke test the handler order on a running dev server:
```bash
# Terminal 1
npm run dev

# Terminal 2 — find the next-server pid and send SIGTERM
pkill -TERM -f "next-server"

# Look for these lines in Terminal 1 in order:
# "graceful shutdown initiated" { signal: "SIGTERM" }
# "graceful shutdown complete"   { signal: "SIGTERM" }
```

### E.4 — HIBP guardrail
```bash
SKIP_ENV_VALIDATION=1 npx jest tests/guardrails/hibp-coverage.test.ts --no-coverage
# → 4 tests, all green
```

## Rollback

### E.2 retry
Set `AUDIT_STREAM_RETRY_ENABLED=0` in the deployed env and redeploy
(or hot-reload via your runtime). The code falls back to single-POST
behaviour identical to the pre-Epic-E.2 state. No migration involved.

### E.3 shutdown handlers
Revert the `installShutdownHandlers()` call in `src/instrumentation.ts`.
The three drain helpers (`flushAllAuditStreams`, `shutdownTelemetry`,
`shutdownSentry`) continue to exist but are never wired to signals —
SIGTERM goes back to terminating without flushing. No data structure
or schema rollback needed.

### E.4 guardrail
The test has no production impact — it's CI-only. Remove the file to
stop enforcement.

## Adding a new password-handling route

When the first password-change / reset / recovery route lands:

1. Import and call `checkPasswordAgainstHIBP` in the route handler.
   Match the shape used by `src/app/api/auth/register/route.ts`
   (fail-open on HIBP outage, hard-fail on a known breach).
2. Add the route to `HIBP_REQUIRED_ROUTES` in
   `tests/guardrails/hibp-coverage.test.ts`, with a `field` note
   saying which password field the route accepts.
3. Run `SKIP_ENV_VALIDATION=1 npx jest tests/guardrails/hibp-coverage.test.ts`.
   Both the curated-list integrity check AND the structural scan
   should pass.

The structural scan resolves the route's imports per symbol
(`tests/helpers/password-schema-graph.ts`, #1166), so it finds the
password field whether the schema is declared in the route file or in
`@/lib/schemas`. Import it **by name** — a namespace import has no
symbol to follow, and the guard fails on one in any route file.

## Adding a new outbound webhook

`src/app-layer/events/webhook-headers.ts` is the canonical module. Any
new outbound webhook (SCIM push, billing fanout, per-tenant SIEM
pluralisation) should:

1. Call `buildOutboundHeaders({ batchId, signatureHex, userAgent, schemaVersion })`
   — never spell the `X-Inflect-*` header names inline.
2. Compute `batchId = computeBatchId({ tenantId, schemaVersion, eventIds })`.
   Retries MUST carry the same id (the whole point of the idempotency
   convention).
3. Route through `fetchWithRetry` from `src/lib/http/fetch-with-retry.ts`
   — do not hand-roll retry logic.
