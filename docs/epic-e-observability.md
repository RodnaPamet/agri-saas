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


---

## Observability & Operational Hardening (Epic E) — the reasoning

Relocated from CLAUDE.md (#1334). **Read this before changing the audit stream, the shutdown handler, or adding a password-accepting route.** It carries the retry/idempotency contract, the per-stage shutdown budgets and why they must fit under the container grace period, and the #1166 history of the HIBP scan — which was blind to the shape the primary signup route already had.

Three remediations that close the operational gaps left after Epic D.
Treat them as one subsystem — each protects a different blast-radius
class for the same deploy event.

**E.2 — Audit-stream retry + idempotency key.** `deliverBatch` in
`src/app-layer/events/audit-stream.ts` now attempts each batch up
to 3 times (original + 2 retries) on `408 / 429 / 5xx / network
throw`. Linear backoff (1 s, 2 s). Every attempt carries the SAME
`X-Agrent-Batch-Id` header — deterministic from
`(tenantId, schemaVersion, eventIds)` via `computeBatchId` in
`src/app-layer/events/webhook-headers.ts`. The legacy `X-Inflect-*`
names are still dual-emitted alongside the canonical set with identical
values, so the 2026-07 rename did not break existing SIEM integrations;
`AUDIT_STREAM_LEGACY_HEADERS=0` drops them once every consumer has
migrated. The same id doubles as
`X-Agrent-Idempotency-Key`, so consumer SIEMs dedupe retries with
zero retry-aware code on our side. Kill-switch via
`AUDIT_STREAM_RETRY_ENABLED=0` (force single-POST for debugging a
misbehaving SIEM without redeploy). Delivery is fully instrumented
with OTel metrics — `deliverBatch` calls `recordAuditStreamDelivery`
once per batch (success/failure counter + an attempts histogram for
retry pressure + a duration histogram), `streamAuditEvent` calls
`recordAuditStreamBufferOverflow` when a per-tenant buffer sheds an
event at the hard cap, and an `audit_stream.buffer.depth` observable
gauge reports backlog. Audit-stream failures deliberately do NOT
gate `/api/readyz` — the path is out-of-band + fail-safe (the audit
row is already committed); escalation is alert-based on the metrics.
See `docs/implementation-notes/2026-05-21-audit-stream-observability.md`.

`webhook-headers.ts` is the canonical module for any future outbound
webhook in the repo (SCIM push, billing fanout, per-tenant SIEM
pluralisation). Every caller uses `buildOutboundHeaders(...)` and
`computeBatchId(...)` — never spell an outbound header name inline
(`X-Agrent-*` is canonical; `X-Inflect-*` is the legacy alias, still
dual-emitted with identical values by default), never hand-roll dedupe
keys. The dual-emit is `buildOutboundHeaders`'s business, not a
caller's: it drops to the canonical set alone under
`AUDIT_STREAM_LEGACY_HEADERS=0`, read from `process.env` directly so an
operator can flip it without a redeploy once every consumer SIEM has
migrated.

**E.3 — Graceful shutdown.** On a rolling deploy the process receives
SIGTERM. Without a drain handler, three observability surfaces lose
data: per-tenant audit-stream buffers (irreversible — events never
reach the SIEM), OTel span batches still in the `BatchSpanProcessor`,
and Sentry errors still in the transport queue.
`installShutdownHandlers()` in `src/lib/observability/shutdown.ts`
drains all three in the order most-to-least critical for audit
correctness: audit buffers first, then OTel, then Sentry. Each stage
is `Promise.race`'d against its per-stage budget from
`src/lib/observability/shutdown-budget.ts` so a slow exporter never
blocks past the container's grace period (k8s default 30 s). The
three stage budgets (3 s + 2 s + 2 s = 7 s) fit under the 20 s
ceiling — leaving 10+ s for Next.js's own HTTP-drain handler
running in parallel. The handler never calls `process.exit` —
`next start` owns the process lifecycle. Registration happens in
`src/instrumentation.ts::register()`, after all `init*` calls, and
is idempotent under HMR via a module-level flag. SIGINT gets the
same treatment. A second SIGTERM falls through to Node's default
(via `process.once`) so an escalating runtime can always terminate.

Paired shutdown helpers live beside their init counterparts:
`shutdownTelemetry` in `src/lib/observability/instrumentation.ts`,
`shutdownSentry` in `src/lib/observability/sentry.ts`. Both are
bounded, idempotent, never throw — the handler composes them as
stable contracts.

**E.4 — HIBP guardrail.** `tests/guardrails/hibp-coverage.test.ts`
locks in the invariant that every API route ingesting a
user-chosen password MUST import AND call
`checkPasswordAgainstHIBP`. Mirrors the
`sanitize-rich-text-coverage.test.ts` template: a curated
`HIBP_REQUIRED_ROUTES` list (`auth/register`, `auth/change-password`,
`auth/reset-password`) paired with a structural scan of
`src/app/api/**/route.ts` for password-shaped Zod fields. An
in-memory mutation regression proof confirms the detector catches
removals. The structural scan auto-fails any new route that parses
a `password` / `newPassword` / `currentPassword` /
`confirmPassword` Zod field without registering.

**The scan FOLLOWS IMPORTS** (`tests/helpers/password-schema-graph.ts`,
#1166), and the sentence that used to end this paragraph — *"define
password schemas inline in the route file so the scan sees them"* — is
gone because following it cost you the API contract. The scan was a
regex over route FILES, so a field declared in a shared schema module
was invisible: `auth/change-password` and `auth/reset-password` scored
2 and 1 matches, and **`auth/register` — the primary signup route —
scored 0**, because it imports `AuthActionSchema` from `@/lib/schemas`.
Nothing was exposed (the curated list names it and asserts the call),
but the half of the guard that catches a route nobody registered was
blind to the shape the most important password route already had. The
inline convention could not be followed either:
`scripts/openapi-build.ts` registers components by walking the
`@/lib/schemas` module namespace, so moving `AuthRegisterSchema` into
the route file drops `AuthRegisterRequest` from
`src/generated/openapi.json` — measured, it reddens the full-spec
drift check in `tests/contracts/api-schemas.test.ts` and orphans that
schema's contract snapshot. The two inline password schemas are
absent from the spec for exactly that reason. **So declare a request
schema in `@/lib/schemas` as GAP-10 says, and import it by NAME** —
resolution is per-symbol, and a namespace import
(`import * as s from '@/lib/schemas'`) has no symbol to follow, which
the guard asserts no route file uses.

**It matches the field NAME, not the field's spelling.** The regex
required a literal `z.` after the colon, so it read
`password: z.string().min(8)` and was blind to
`password: PwFieldSchema` — which is this repo's normal idiom for a
reusable Zod field (23 uses across 12 files in `src/lib/schemas` and
`src/app-layer/schemas`: `category: CostCategorySchema`,
`geometry: PolygonGeometrySchema`, …). No password route happened to
use it, so the flagged set is **3 of 374 route files before and
after** and no measurement of the live tree could have shown the gap;
a probe did — an unregistered route parsing
`z.object({ password: PasswordFieldSchema })` left the guard green at
13/13 while the inline-shaped probe beside it was reported by name.
So there is no longer a shape this guard requires you to use. Name
matching is gated on the declaration being Zod-shaped, and that gate
is CORRECTNESS here rather than cost (it is cost on the composition
walk): ungated it also flags `api/staging/seed`, which returns
`login: { password: 'password123' }` — a hardcoded seed credential on
a handler that 403s in production.

**See `docs/epic-e-observability.md`** for the Epic E operator
runbook (verification commands, rollback procedures, how to add a
new password-handling route, how to add a new outbound webhook).
