# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev               # Start Next.js dev server
npm run build             # Validate env + build
npm run typecheck         # tsc --noEmit
npm run lint              # Next.js lint

# Database
# The Prisma schema lives in a folder, not a single file:
#   prisma/schema/{base,enums,auth,compliance,vendor,audit,automation,schema}.prisma
# Prisma's `prismaSchemaFolder` preview feature (enabled in base.prisma)
# concatenates them at generate / migrate time. See prisma/schema/README.md.
npm run db:generate       # Regenerate Prisma client after schema changes
npm run db:push           # Push schema to DB (no migration file)
npm run db:migrate        # Create + apply a named migration interactively
npm run db:reset          # Drop, recreate, and reseed the DB

# Tests
npm test                  # Jest (parallel)
npm run test:ci           # Jest (sequential, used in CI)
npm run test:coverage     # Jest with coverage report
npm run test:e2e          # Playwright browser tests

# Run a single Jest test file
npx jest tests/unit/golden-path.test.ts

# Run a single Playwright test file
npx playwright test tests/e2e/core-flow.spec.ts

# Docker (local dev stack — PostgreSQL + Redis)
docker-compose up -d
```

## Production VM

The production deployment runs on a single GCP VM, and **Claude has
`gcloud` access to it** — project `hazel-design-419410`, instance
**`agrent`**, zone `europe-west1-b` (served at
`https://35-187-80-26.sslip.io`):

```bash
gcloud compute ssh agrent --zone europe-west1-b --command "…"
```

The VM hosts a Docker Compose stack at `/opt/agrent/`
(`docker-compose.vm.yml` — 7 services: app, worker, watchtower,
caddy, pgbouncer, redis, db). Docker commands on the VM need `sudo`.
`/opt/agrent/.env` and the Redis `--requirepass` value are real
secrets — **never echo them**.

**The repo is canonical; drift is DETECTABLE, not policy.** The compose
STRUCTURE lives at **`deploy/docker-compose.vm.yml`** in the repo and is
kept byte-identical to the VM. Watchtower auto-updates ONLY the `app` +
`worker` *images* (never the compose file); every STRUCTURAL change — a
new service, a resource limit, an env addition — lands in the repo file
and is applied with **`deploy/apply.sh`** (backup → scp → `docker compose
config` → `up -d` → health-verify `/api/readyz` + `/manifest.webmanifest`
+ `/sw.js`). **`deploy/check-drift.sh`** sha256-compares the repo file
against the VM (run it weekly); a mismatch means the VM was hand-edited
(reconcile it back into the repo) or the repo changed without an apply.
`deploy/env.prod.example` lists the prod-required env keys (parity with
`src/env.ts` is guarded by `tests/guardrails/deploy-env-parity.test.ts`).

**When a runtime change must be applied to the VM** — a one-off job run,
inspecting container logs, a manual restart — execute it directly via
`gcloud compute ssh`; do not ask the operator to do it by hand. But a
**structural** compose change goes through the repo + `deploy/apply.sh`,
NOT a hand-edit on the VM. Back up any file before editing it (the
`<file>.bak.<timestamp>` convention).

**Backups: one disk, one daily snapshot — per stack.** Postgres lives
in a local Docker volume on each instance's boot disk (`agrent-pgdata`
on agrent, `inflect_pgdata` on inflect-compliance) — no managed
database, no replica. Each disk carries a GCE snapshot schedule
(`agrent-daily-snapshot` 02:00 UTC, `inflect-daily-snapshot` 02:30 UTC;
both 14-day retention, `eu` storage, `keep-auto-snapshots`). So **RPO
is up to 24 hours**, not the 1 hour `docs/slos.md` targets, and the
snapshots are crash-consistent (Postgres replays WAL on restore).
Restores are drilled monthly by `infra/scripts/restore-test-gcp.sh`
via `.github/workflows/restore-test.yml`, which runs it once per
target from a job matrix — it boots a real Postgres over the restored
data directory rather than just checking a snapshot exists. The
`DATA_ENCRYPTION_KEY` sits on the same disk as the data it protects
(`/opt/agrent/.env`; `/opt/inflect/.env.prod`), so a whole-disk restore
recovers key and ciphertext together; a pgdata-only copy is NOT a
complete backup. **See `docs/backup-restore.md`** for the operator
runbook. Before 2026-08-01 NEITHER stack had any backup at all, and the
monthly restore test drilled AWS RDS — infrastructure neither product
runs.

> **The `inflect-compliance` VM is NOT this product and is NOT idle.**
> The same GCP project runs a second GCE instance, `inflect-compliance`
> (`/opt/inflect/`, host `inflect.34-140-180-255.sslip.io`), serving a
> DIFFERENT product from a DIFFERENT repo — its image is
> `ghcr.io/inflect-compliance/inflect-compliance`, which this repo never
> pushes to (we publish `…/agri-saas`). It is live: Watchtower still
> auto-deploys to it, and as of 2026-08-01 its database held 7 tenants,
> 18 users and audit rows written that day. Earlier wording here said
> the VM was "being retired as part of the Agrent rebrand"; that was
> intent, not fact, and reading it as fact nearly led to deleting a VM
> with live users on it. **Check what an instance is actually running
> before acting on a doc that says it is on its way out.** The only
> thing this repo shares with it is the GCP project and the backup
> tooling (see `docs/backup-restore.md`). `deploy/docker-compose.prod.yml` is the older
> inflect-branded manifest, retained because the GAP-03 encryption-key
> guardrail asserts its `:?`-fail-fast syntax; the live agrent stack uses
> `docker-compose.vm.yml`.

## Architecture

### Framework baseline

**Next.js 16.2.11** (App Router) + **React 19.2** + **TypeScript 6.0**.
The React 18 → 19 bump (#67) is complete: React 19 removed
`propTypes`, function-component `defaultProps`, string refs and
legacy context — the codebase carries none of those.
`forwardRef` still works in React 19 (which also accepts `ref` as a
plain prop); existing `forwardRef` call sites are fine and
modernising them is optional.
GAP-05 (2026-04-25) first migrated off the vulnerable `next@^14.2.0` line —
the two HIGH advisories (Image Optimizer DoS, RSC request
deserialization) were unfixable in 14.x. CI security gates restored
to their pre-workaround strictness, and on 2026-05-12 tightened one
further notch: npm audit blocks on **MODERATE+** (production deps),
Trivy blocks on `CRITICAL,HIGH` (container scan). The structural
ratchet at `tests/guardrails/security-gate-strictness.test.ts` fails
CI if either gate is silently re-lowered (`moderate` → `high` /
`critical`, or `CRITICAL,HIGH` → `CRITICAL`) or `next` is downgraded
back to 14.x.

Async-request-API: GAP-05 is **complete**. Every dynamic route
handler under `src/app/api` types `params` as `Promise<…>` and
`await`s it (the Next 16 contract, enforced by
`tests/guards/async-params-route-typing.test.ts`), the runtime
transparent-await shim was removed from `withApiErrorHandling`, and the
last vestige — the `AsyncifyParams` type transform that bridged the
sync-params middleware to the Promise-shaped export — is also gone.
`requirePermission` now resolves the params Promise once and forwards
the RESOLVED params to its inner handler (so handlers read `params.foo`
directly), and its returned `RouteHandler` types `params` as a Promise,
so `withApiErrorHandling` exports the Next-shaped signature with no type
bridge. Tests invoke wrapped routes with `{ params: Promise.resolve(...) }`.
See `docs/implementation-notes/2026-04-25-gap-05-next15-migration.md`
and `docs/implementation-notes/2026-06-17-gap-05-asyncify-removal.md`.

### Layer Structure

```
src/app/api/           → Next.js route handlers (HTTP boundary only — parse input, call usecases, return responses)
src/app-layer/usecases/→ Business logic orchestration (thin: validate → call policy → call repo → emit event)
src/app-layer/policies/→ Authorization checks (assertCanRead/Write/Admin/Audit) — always called before data access
src/app-layer/repositories/ → All Prisma queries (every query must filter by tenantId)
src/app-layer/jobs/    → BullMQ job definitions (background tasks)
src/app-layer/services/→ Cross-cutting domain services (library import, cross-framework traceability)
src/app-layer/events/  → Audit event writers (immutable, hash-chained audit trail)
src/lib/               → Shared infrastructure (auth, observability, storage, rate-limiting, permissions)
src/components/        → React components

prisma/schema/         → Multi-file Prisma schema (GAP-09):
                            base.prisma         — generator + datasource (sole owners)
                            enums.prisma        — every shared enum
                            auth.prisma         — Tenant/User/Membership/Session/SSO/Billing
                            compliance.prisma   — Control/Evidence/Framework/Policy/Asset/etc.
                            vendor.prisma       — Vendor + assessment graph
                            audit.prisma        — AuditCycle/Pack/Auditor + AuditLog
                            automation.prisma   — AutomationRule/Execution + Notification + Integration
                            schema.prisma       — transitional sediment file (currently empty)
                          See prisma/schema/README.md for the full layout + conventions.
                          Adding a new model: pick the matching domain file. Generator
                          and datasource ONLY live in base.prisma — Prisma rejects
                          duplicates across the folder.
```

### Request Context (`RequestContext`)

Every usecase and repository receives a `RequestContext` (defined in `src/app-layer/types.ts`) containing `userId`, `tenantId`, `role`, `permissions`, and `appPermissions`. This is propagated via AsyncLocalStorage — never thread through manually. Access via `getRequestContext()` from `src/lib/observability`.

### Multi-Tenant Isolation

Two layers, both load-bearing:

1. **PostgreSQL Row-Level Security** (Epic A.1). Every tenant-scoped
   table has `tenant_isolation` + `superuser_bypass` policies and
   `FORCE ROW LEVEL SECURITY`. Tenant context is bound per-transaction
   via `runInTenantContext` from `@/lib/db/rls-middleware`. The DB
   returns zero rows if the context is unset on an `app_user`
   session — isolation is architecturally impossible to bypass by
   accident. **See `docs/rls-tenant-isolation.md`** for the full guide
   including the bypass model, the policy shapes for nullable /
   ownership-chained tables, and how to add a new tenant-scoped model.

2. **Application-layer `tenantId` filters** — every repository query
   also filters by `tenantId`. Defence in depth; makes error messages
   clear when the app is working correctly.

Guard tests: `tests/guardrails/rls-coverage.test.ts` (DB-backed — CI
fails if a tenant table is missing RLS) and
`tests/unit/tenant-isolation-structural.test.ts` (code-pattern scanner).

### API Rate Limiting (Epic A.2 + GAP-17)

Three tiers, each scoped to a different traffic class. Full operator
runbook in `docs/rate-limiting.md`.

**Mutation tier** (Epic A.2). Every route wrapped with
`withApiErrorHandling` gets `API_MUTATION_LIMIT` (60/min) on
POST/PUT/DELETE/PATCH by default. Stricter presets (`LOGIN_LIMIT`,
`API_KEY_CREATE_LIMIT`, `EMAIL_DISPATCH_LIMIT`) are applied via
`{ rateLimit: { config, scope } }` options on specific routes. Keyed
`(IP, userId)`. Storage: in-process Map (Node runtime).

**Read tier** (GAP-17). Tenant-scoped GETs on `/api/t/<slug>/...` go
through `API_READ_LIMIT` (120/min) at the Edge middleware via
`src/lib/rate-limit/apiReadRateLimit.ts`. Keyed `(IP, userId,
tenantSlug)` for per-tenant + per-user isolation. Health probes
(`/api/health`, `/api/livez`, `/api/readyz`) and `/api/docs` are
explicitly excluded — operators must keep monitoring access during
attacks. Storage: Upstash + memory fallback (mirrors `authRateLimit.ts`).
The wire-up sits AFTER the JWT verify + tenant-access gate so
unauthorized requests get the cheaper 401/403 first; structural
ratchet at `tests/guardrails/api-read-rate-limit.test.ts` enforces
the ordering + exclusion list.

**Auth tier** (covered separately by `src/lib/rate-limit/authRateLimit.ts`).
Tiered per-endpoint policy at the Edge: 10/min for sign-in callbacks,
30/min for session probes, 60/min for csrf/providers. Keyed `(IP,
ua-hash)` because it runs pre-authentication.

429 responses carry `Retry-After` + `X-RateLimit-*` + `x-request-id`.
Body never contains IP/userId/tenantSlug. Bypass via
`RATE_LIMIT_ENABLED=0` env or inside tests (automatic). All presets
live in `src/lib/security/rate-limit.ts`; the Node wrapper is
`src/lib/security/rate-limit-middleware.ts`; the edge enforcement
modules live under `src/lib/rate-limit/`.

### Cold-start data cost (Roadmap-6 P3)

Three seams keep a PWA relaunch cheap on rural LTE — see
`docs/implementation-notes/2026-07-11-cold-start-datacost.md`.

- **Persistent SWR cache.** `providers.tsx` mounts ONE
  `<SWRConfig provider>` via `SWRPersistenceProvider`, backed by the
  per-tenant, disk-backed Map in `src/lib/swr/persistent-cache.ts`
  (localStorage sync-hydrate + IndexedDB backfill, versioned +
  24h-evicting, graceful fallback). It is KEYED by tenant slug so
  buckets never leak across tenants. **Never add a second
  `<SWRConfig provider>`** — extend this one.
- **Conditional revalidation.** Every hot list-read GET returns a weak
  ETag via `jsonWithETag(req, payload)` from `src/lib/http/etag.ts`
  (honors `If-None-Match` → 304). Wired into journal / farm-tasks /
  locations / exchange-listings. New cacheable list GETs SHOULD use
  `jsonWithETag` instead of `jsonResponse`.
- **Cursor-paginated journal.** The journal list server-renders a
  bounded first page (`JOURNAL_PAGE_SIZE = 50`) and pages forward over
  the `?limit`/`?cursor` path via `useCursorPagination` (its additive
  `reload()` reseeds the accumulator on a filter/optimistic change).
  The paginated `/journal` branch returns `{ rows, nextCursor }`; the
  bare `/journal` (no params) still returns a flat array (offline
  outbox replay depends on it).

### Auth Brute-Force Protection (Epic A.3)

`authenticateWithPassword` applies `LOGIN_PROGRESSIVE_POLICY`:
3 failures → 5s delay, 5 → 30s, 10 → 15-min lockout. Timing is
equalised via `dummyVerify` so lockout is indistinguishable from
wrong-password. Signup rejects known-breached passwords via
`checkPasswordAgainstHIBP` (k-anonymity, fail-open on HIBP outage).

**Password change + reset.** Three routes under `/api/auth/`:
`change-password` (authenticated — verifies the current password),
`forgot-password` (issues a token, enumeration-safe), and
`reset-password` (consumes the token). Reset tokens are
`SHA-256`-hashed at rest in `PasswordResetToken`, single-use
(conditional-`updateMany` claim), and expire after 1 hour. Both
set-password routes run `validatePasswordPolicy` + the HIBP check;
every success revokes ALL of the user's sessions (`sessionVersion`
bump + `UserSession.revokedAt`). Logic lives in
`src/lib/auth/password-management.ts`. Any future password-accepting
route MUST wire HIBP the same way — the Epic E.4 guardrail enforces
it.

**See `docs/epic-a-security.md`** for the unified operator runbook
(verification commands, rollback procedure, observability signals)
and `docs/rls-tenant-isolation.md` for the RLS deep dive.

### Field Encryption (Epic B)

Business-content fields (Finding.description, Finding.rootCause,
PolicyVersion.contentText, TaskComment.body, …) are encrypted at
rest by a Prisma `$extends({ query })` client extension (migrated
from the Prisma 5 `$use` middleware, which Prisma 7 removed — see
`src/lib/prisma.ts`). The manifest lives in
`src/lib/security/encrypted-fields.ts`; **never** add or remove
encrypted columns outside it. Add a model here ⇒ its manifest
fields encrypt on every write and decrypt on every read
transparently.

Key hierarchy: `DATA_ENCRYPTION_KEY` (master KEK) wraps a per-tenant
DEK on `Tenant.encryptedDek`. New tenants get a DEK at creation via
`createTenantWithDek` (from `src/lib/security/tenant-key-manager.ts`);
existing tenants get one via `scripts/generate-tenant-deks.ts`.
Ciphertexts carry `v1:` (global KEK, legacy) or `v2:` (per-tenant
DEK) envelope — the middleware dispatches per-value on read.

**GAP-03 — production fail-fast.** The master KEK is REQUIRED in
production. Three independent checks each refuse to start a prod
process whose `DATA_ENCRYPTION_KEY` is missing, shorter than 32
chars, or equal to the documented dev fallback:

  1. zod schema in `src/env.ts` — fires at module load, `superRefine`
     on the field reads `process.env.NODE_ENV` directly.
  2. startup hook in `src/instrumentation.ts` (web) +
     `scripts/worker.ts` (BullMQ worker) + `scripts/scheduler.ts`
     (deploy-time scheduler) — exits 1 with `[startup] FATAL: …`.
     The web tier additionally runs an encrypt → decrypt sentinel
     to catch keys that pass structural checks but break HKDF/AES.
  3. Compose `:?error` syntax in `docker-compose.prod.yml` /
     `docker-compose.staging.yml` / `deploy/docker-compose.prod.yml`
     — aborts container start before the app process is spawned.

Dev gets the in-source fallback key (`encryption-constants.ts`) with
a WARN log on every server start; test gets the same fallback
silently. The fallback is well-known + refused in prod, not secret.
The runtime + structural enforcement is unit-tested in
`tests/unit/security/startup-encryption-check.test.ts` +
`tests/unit/env.test.ts`, and the wiring across all five surfaces
is locked by `tests/guardrails/encryption-key-enforcement.test.ts`.

Master-KEK rotation: set `DATA_ENCRYPTION_KEY_PREVIOUS` alongside
the new primary. `decryptField` falls back transparently. Admins
trigger the v1→v2 re-encryption sweep via
`POST /api/t/{slug}/admin/key-rotation`, which enqueues the
background job in `src/app-layer/jobs/key-rotation.ts`. The job
re-encrypts every `v1:` ciphertext under the new primary KEK and
re-wraps the per-tenant DEK. When every tenant reports zero `v1:`
rows under the old key, remove `DATA_ENCRYPTION_KEY_PREVIOUS` from
env.

Per-tenant DEK rotation (generating a fresh DEK for a single
compromised tenant without touching the global KEK) is implemented
at `rotateTenantDek` in `src/lib/security/tenant-key-manager.ts`.
The admin surface is `POST /api/t/:slug/admin/tenant-dek-rotation`,
gated by `admin.tenant_lifecycle` (OWNER-only). The flow:
atomic UPDATE moves the old wrapped DEK into
`Tenant.previousEncryptedDek` and writes a fresh wrapped DEK to
`Tenant.encryptedDek`; the response is 202 + a job id for the
`tenant-dek-rotation` BullMQ sweep that re-encrypts every v2
ciphertext under the new DEK and clears `previousEncryptedDek` on
completion. Mid-flight reads remain correct via
`decryptWithKeyOrPrevious` in the encryption layer — primary first,
fall back to previous on AES-GCM auth failure. The per-tenant DEK
fallback is locked in by
`tests/guardrails/tenant-dek-rotation-fallback.test.ts`.

**See `docs/epic-b-encryption.md`** for deployment order,
rotation runbook, observability signals, rollback procedure, and
the full test coverage map.

### Defense-in-Depth (Epic C)

Five complementary controls. Treat them as one system — each
sub-epic has the others as backstops.

**C.1 — API permission middleware.** Wrap every privileged API
handler with `requirePermission(<key>, …)` from
`@/lib/security/permission-middleware`. The key is a typed dotted
literal (`'admin.scim'`, `'risks.create'`, …) derived from
`PermissionSet`. Denials emit a hash-chained `AUTHZ_DENIED` audit
entry (`category: 'access'`) and surface as a generic 403 — the
key itself is never echoed to the client. The route ↔ map sync is
guarded by `tests/guardrails/api-permission-coverage.test.ts`;
new admin/privileged routes MUST add a rule in
`src/lib/security/route-permissions.ts` and use
`requirePermission(...)`. Avoid the legacy
`requireAdminCtx` helper for new code — it still works but the
permission-key model is the canonical pattern.

**C.2 — Secret detection.** Local pre-commit hook
(`.husky/pre-commit` → `scripts/detect-secrets.sh`) scans staged
files; CI guardrail (`tests/guardrails/no-secrets.test.ts`) walks
the whole tree. Both load patterns from `.secret-patterns` (one
source of truth). Carve-outs: inline
`// pragma: allowlist secret` for one-off lines, or move fixtures
under `tests/fixtures/secrets/` (auto-skipped). Pre-existing
placeholder fixtures live in `REPO_BASELINE` in the guardrail; add
to that array only with a written `reason`.

**C.3 — Session hardening.** A `UserSession` row is minted on every
sign-in (NextAuth `jwt` callback → `recordNewSession`) carrying
`ipAddress`, `userAgent`, `expiresAt`, `lastActiveAt`. Every JWT
pass calls `verifyAndTouchSession` — revoked or expired rows
short-circuit as `SessionRevoked`. Per-tenant policy lives on
`TenantSecuritySettings.maxConcurrentSessions` (overflow → revoke
oldest by `lastActiveAt` ASC) and `sessionMaxAgeMinutes` (caps
`expiresAt` at insert time). The admin UI lives at
`/admin/members` — Sessions column + modal + per-row revoke,
backed by `GET/DELETE /api/t/:slug/admin/sessions`. The pre-Epic-C
endpoints (`security/sessions/revoke-current` etc.) and the
`User.sessionVersion` bump still work as the coarse-grained
backstop.

**C.4 — Audit event streaming.** Every committed audit row is
fired through `streamAuditEvent` into a per-tenant in-memory
buffer (lazy-imported by `appendAuditEntry` so cold-start cost is
zero for tenants without streaming configured). Flush happens on
100 events OR 5 seconds, HMAC-SHA256-signed
(`X-Inflect-Signature: sha256=<hex>`), POSTed to
`TenantSecuritySettings.auditStreamUrl`. The HMAC secret is on
the same row (`auditStreamSecretEncrypted`), encrypted at rest via
the Epic B field-encryption manifest. Fail-safe — the audit row is
already committed, so a broken SIEM never undoes the write.
Privacy-aware payload — free-text `details` is dropped, only
structured `detailsJson` ships; actor is opaque `userId` +
`actorType`, never email. Each batch delivery gets up to 3 attempts
(original + 2 retries) with linear backoff (1 s, 2 s). Kill-switch
via `AUDIT_STREAM_RETRY_ENABLED=0`.

**C.5 — Server-side rich-text sanitisation.** Use
`sanitizeRichTextHtml` / `sanitizePlainText` /
`sanitizePolicyContent` from `@/lib/security/sanitize` BEFORE
persisting any user-supplied rich-text. Already wired into
`policy.createPolicy`, `policy.createPolicyVersion`,
`task.addTaskComment`, `issue.addIssueComment`. New write paths
that accept HTML or comment text MUST sanitise at the usecase
layer (not just at render time) — render-time sanitisation alone
would leave the row dangerous to PDF export, audit-pack share
links, and future SDK consumers reading the row verbatim. The
allowlist (tags, attributes, link schemes) is in
`src/lib/security/sanitize.ts`; do not widen it without a security
review.

**See `docs/epic-c-security.md`** for the unified operator
runbook (env vars, verification commands, rollback procedures,
failure modes) and `SECURITY.md` for the responsible-disclosure
policy.

### Isolation & Sanitisation Completeness (Epic D)

Epic D closed three concrete gaps left after Epic C. Each is now
guarded by a CI ratchet so the regression surface is small.

**D.1 — `UserSession` RLS.** The Epic C.3 `UserSession` table
shipped without RLS policies. It now carries a single asymmetric
`tenant_isolation` policy (`USING (tenantId IS NULL OR own) WITH
CHECK (own)`) plus the canonical `superuser_bypass`, with `FORCE
ROW LEVEL SECURITY` enabled. The single-policy form is mandatory
because `tenantId` is nullable: a split `tenant_isolation_insert`
policy would be a permissive sibling that lets `app_user` UPDATE a
NULL row to any tenantId. `UserSession` is listed in
`SINGLE_POLICY_EXCEPTIONS` in `tests/guardrails/rls-coverage.test.ts`,
where the post-loop sanity check verifies the asymmetric `qual` +
`with_check` shape is real — a future "simplify" PR that strips
either clause fails CI. See migration
`prisma/migrations/20260423150000_epic_d1_user_session_rls/` and
`tests/integration/user-session-rls.test.ts` for the seven
behavioural assertions (own-INSERT accepts; foreign-INSERT rejects;
NULL-INSERT-under-app_user rejects; NULL-row-claim-to-other-tenant
rejects; etc.).

**D.2 — Encrypted-field write paths sanitised.** Five usecase
files (`finding`, `risk`, `vendor`, `audit`, `control-test`) wrote
to encrypted free-text columns without server-side sanitisation.
(`risk` and `control-test` were deleted by the 2026-08 risk +
control-exoskeleton uproot; the rule below is unchanged for the
surfaces that remain.)
Encryption protects confidentiality at rest; sanitisation protects
every downstream renderer (UI, PDF export, audit-pack share link,
SDK consumer reading the row verbatim) that decrypts and reads the
field. All five now route user-supplied free text through
`sanitizePlainText` (or, for surfaces that share the call shape,
the per-file `sanitizeOptional` helper that preserves the
undefined/null/string three-state contract). The
`tests/guardrails/sanitize-rich-text-coverage.test.ts` ratchet no
longer keeps a numeric floor — it derives the rich-text inventory
from `ENCRYPTED_FIELDS` and requires every encrypted
business-content model to be CLASSIFIED (sanitised / not-rich-text /
a named gap), so a NEW unsanitised write path fails rather than
sliding under an "at least N". The companion
`tests/unit/security/sanitize-write-paths.test.ts` carries 20
write-path assertions — one positive XSS-strip per call site.

**D.3 — Legacy `requireAdminCtx` migrated to `requirePermission`.**
Seven tenant API routes (billing × 3, security/sessions × 2,
security/mfa/policy PUT, sso) used the legacy role-tier guard,
which threw a 403 but **did not write an `AUTHZ_DENIED` audit
row** and was invisible to the Epic C.1 permission guardrail. All
seven now use `requirePermission(...)` — denials audit cleanly,
and `tests/guardrails/api-permission-coverage.test.ts` now treats
`billing/`, `sso/`, and `security/` as privileged roots with five
self-service routes (own MFA enrolment, own session revocation)
explicitly listed in `EXCLUDED_ROUTES` with written reasons. The
canonical pattern for new admin routes is
`requirePermission('<key>', handler)` — now the *only*
admin-authorization guard: the legacy `requireAdminCtx` /
`requireWriteCtx` / `requireRoleCtx` helpers were removed
(2026-05-21) once every route had migrated, and the ratchet
`tests/guardrails/no-legacy-admin-guard.test.ts` keeps them from
returning.

**See `docs/epic-d-completeness.md`** for the Epic D operator
runbook (verification commands, rollback procedures, the five
self-service security carve-outs, the asymmetric-RLS rationale).

### Observability & Operational Hardening (Epic E)

Three remediations that close the operational gaps left after Epic D.
Treat them as one subsystem — each protects a different blast-radius
class for the same deploy event.

**E.2 — Audit-stream retry + idempotency key.** `deliverBatch` in
`src/app-layer/events/audit-stream.ts` now attempts each batch up
to 3 times (original + 2 retries) on `408 / 429 / 5xx / network
throw`. Linear backoff (1 s, 2 s). Every attempt carries the SAME
`X-Inflect-Batch-Id` header — deterministic from
`(tenantId, schemaVersion, eventIds)` via `computeBatchId` in
`src/app-layer/events/webhook-headers.ts`. The same id doubles as
`X-Inflect-Idempotency-Key`, so consumer SIEMs dedupe retries with
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
`computeBatchId(...)` — never spell `X-Inflect-*` header names
inline, never hand-roll dedupe keys.

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
a `password` / `newPassword` / `currentPassword` Zod field without
registering — define password schemas inline in the route file so
the scan sees them.

**See `docs/epic-e-observability.md`** for the Epic E operator
runbook (verification commands, rollback procedures, how to add a
new password-handling route, how to add a new outbound webhook).

### Finishing Touches (Epic F)

Small, independent remediations that close the long tail after
Epic E. Each landed as a focused PR; treating them as one "epic"
was purely a scheduling convenience.

**F.2 — `rotateTenantDek` reserved (since superseded).** Originally
landed as a stub at
`src/lib/security/tenant-key-manager.ts::rotateTenantDek(tenantId)`
that threw a runbook-carrying error pointing at the master-KEK
rotation workaround. The reservation included a new
`Tenant.previousEncryptedDek String?` column from migration
`20260424010000_add_tenant_previous_encrypted_dek`, paired with a
CHECK constraint (`previousEncryptedDek IS NULL OR !=
encryptedDek` — silent key-mixing guard) and a partial index for
the eventual sweep-rotations query.

The real implementation has since landed (see the "Field
Encryption" section above). The reservation paid off: the
implementation slotted in without a schema change and without any
caller-signature break (the function now takes an options object
instead of a single id; the only previous caller was the stub
test itself). Integration test renamed to
`tests/integration/tenant-dek-rotation.test.ts` — happy-path swap
+ double-rotation rejection + the original CHECK-constraint
assertion preserved verbatim.

**F.3 — `HttpMethod` union + sentinel comment.** The route
permission matcher previously did
`rule.methods.map((m) => m.toUpperCase()).includes(upperMethod)`
per gated-route request. The new `type HttpMethod = 'GET' | 'POST'
| 'PUT' | 'PATCH' | 'DELETE'` union enforces uppercase at compile
time, so the hot path drops the `.map(...)` allocation.
Ratchet: `tests/guardrails/route-permissions-uppercase.test.ts`
catches `as` casts, lowercase union-member additions, and type
widening back to `readonly string[]`. Separately, `encryption.ts:139`
now carries a three-state sentinel comment explaining that
`_lastPreviousKeySource: string | null | undefined` uses all three
states deliberately (undefined = never checked, null = checked-no-key,
string = checked-with-key-source).

**F.4 — SECURITY.md + detect-secrets.** `SECURITY.md` now documents
GitHub Security Advisories as the private-by-default primary
reporting channel (no fabricated security email). `scripts/detect-secrets.sh`
uses `git diff --cached --name-only --diff-filter=ACMR` so renamed
files with staged secrets still get scanned.

**See `docs/epic-f-finishing-touches.md`** for the Epic F operator
runbook (verification commands, rollback procedures, how to add a
new DEK-lifecycle verb to `tenant-key-manager`).

### Access Control & Tenant Onboarding (Epic 1)

Closes the audit's GAP-01 (Critical): OAuth sign-in no longer
silently grants ADMIN on the oldest tenant. Authentication and
tenant membership are now orthogonal — sign-in alone authenticates
the user; tenant access requires an explicit grant via one of the
allowlisted paths.

**Role model.** The `Role` enum now has five values:
`OWNER | ADMIN | EDITOR | READER | AUDITOR`. OWNER is strictly
superior to ADMIN — it gains `admin.tenant_lifecycle` (delete
tenant, rotate DEK, transfer ownership) and `admin.owner_management`
(invite/remove OWNERs, assign OWNER role). ADMIN has every other
admin flag but explicitly denies those two. The `PermissionSet`
resolution in `src/lib/permissions.ts` enforces the distinction at
compile time; `getPermissionsForRole('ADMIN').admin.tenant_lifecycle`
is `false` by type.

**Membership creation is explicit.** Only three modules can write a
`TenantMembership` row today (the first of them via two entry points):
(a) `src/app-layer/usecases/tenant-invites.ts`, which has TWO entry
points, both requiring an admin-created `TenantInvite`:
`redeemInvite` is token-bound and email-bound, atomically consumed
via an `updateMany` with `acceptedAt IS NULL AND expiresAt > now()`
predicate (a leaked token is burnt on email mismatch); and
`redeemPendingInvitesByEmail` matches a pending invite against an
**IdP-verified** sign-in email, which is what makes the emailed link
optional. The second is **OAuth-only** — `src/auth.ts` passes
`emailVerifiedByIdp: account.provider !== 'credentials'`, because the
credentials provider's email is self-asserted and honouring an invite
there would hand a tenant to whoever guessed an invited address. It is
still not auto-join: no invite ⇒ no membership. Both share
`finalizeInviteRedemption`.
(b) `createTenantWithOwner` in `src/app-layer/usecases/tenant-lifecycle.ts` —
platform-admin tenant bootstrap, gated by `PLATFORM_ADMIN_API_KEY`
(constant-time compared via `verifyPlatformApiKey`).
(c) `/api/auth/register` — credentials self-service signup. The
`Credentials()` provider is registered unconditionally in `src/auth.ts`
and the route itself has no test-mode gate; what actually hides the
signup UI in production is `AUTH_CREDENTIALS_UI_HIDDEN`, a request-time
flag read by `src/app/api/auth/ui-config/route.ts` that the login page
uses to hide the email/password form while leaving the backend route
reachable for API / tests / future admin tooling.
Plus the legitimate SSO + SCIM provisioning paths. Every site is
allowlisted in `tests/guardrails/no-auto-join.test.ts` with a
one-line reason; a fourth-not-listed site fails CI.

**Middleware tenant-access gate.** `/t/:slug/**` and
`/api/t/:slug/**` require the JWT's `tenantSlug` claim to match the
URL's slug. Mismatch → `/no-tenant` (web) or `403 no_tenant_access`
(API). Uses the JWT claim only — no per-request DB hit. Carve-outs
for `/invite/<token>`, `/api/invites/**`, and `/no-tenant` itself.
Logic lives in `src/lib/auth/guard.ts::checkTenantAccess`.

**Last-OWNER protection — two layers.** Usecase layer
(`updateTenantMemberRole`, `deactivateTenantMember`) counts ACTIVE
OWNERs and throws `forbidden('Cannot demote/deactivate the last
OWNER...')`. DB trigger `tenant_membership_last_owner_guard` is the
backstop — raises SQLSTATE P0001 on any UPDATE or DELETE that would
leave a tenant with zero ACTIVE OWNERs, catching bypass attempts
(raw `deleteMany`, code paths that forget the check). The two-step
`transferTenantOwnership` flow uses this: promote the new OWNER
first (count=2), then demote the old (count=1, trigger satisfied).

**Invitation flow — the link is OPTIONAL.** Admin POSTs to
`/api/t/:slug/admin/invites` → `createInviteToken` creates a 256-bit
base64url token with 7-day expiry. There are then two ways in, and
neither is privileged over the other:

  1. **Just sign in.** An OAuth sign-in whose IdP-verified email
     matches a pending invite provisions the membership on the spot
     (`redeemPendingInvitesByEmail`). This is the path most invitees
     actually take — email delivery is unreliable, and a user who
     clicks "Sign in with Microsoft" should not be stranded on
     `/no-tenant` because an SMTP relay dropped a message.
  2. **Follow the link.** User clicks `/invite/<token>` → preview page
     → "Sign in to accept" sets a 10-min HttpOnly cookie and redirects
     to `/login`.

Both are claimed atomically against the same row, so a link-click
racing a login cannot double-redeem; the loser skips.
After OAuth, redemption runs in the **`jwt` callback** (NOT `signIn`)
via `redeemPendingInvites` in `src/lib/auth/invite-redemption.ts`,
which reads the cookie and resolves the persisted `User.id` **by
email** before calling `redeemInvite`. This is load-bearing: in the
`signIn` callback a first-time OAuth user's `user.id` is the
identity-provider subject, not our `User.id` (the Prisma adapter
creates the row only after `signIn` returns), so redeeming there wrote
a membership against a non-existent `User` FK and stranded the invitee
on `/no-tenant`. The `jwt` callback fires after the row exists.
Step 1 (atomic claim) commits standalone so Step 2 (email binding) can
burn the invite on mismatch without rolling back the claim — leaked
tokens are unusable on first failed attempt.

**See `docs/epic-1-access-control.md`** for the Epic 1 operator
runbook (verification commands, rollback procedures, how to add a
new tenant-membership creation path).

### RBAC & Permissions

- `src/lib/permissions.ts` — `PermissionSet` (granular UI flags) resolved from the user's role
- Built-in roles: `OWNER`, `ADMIN`, `EDITOR`, `READER`, `AUDITOR` (Prisma enum `Role`)
- Custom roles: `TenantCustomRole` model with `permissionsJson` overrides, referenced via `TenantMembership.customRoleId`
- `appPermissions` on `RequestContext` is already custom-role–aware

### Observability

All structured logging, tracing, and metrics flow through `src/lib/observability/index.ts` (barrel export). Use `log(ctx, level, message, fields)` or `logger.info(...)` for logging. Use `traceUsecase()` / `traceOperation()` for OpenTelemetry spans. Never `console.log` in application code.

### Auth

NextAuth v4.24.14 (stable) is configured in `src/auth.ts`. Providers: Google OAuth, Microsoft Entra ID (via the v4 `azure-ad` provider — same OAuth endpoints, Microsoft renamed the product), SAML (via `src/app/api/auth/sso/`), and Credentials. The JWT carries `tenantId`, `role`, `mfaPending`, `memberships[]`, and the Epic C.3 `userSessionId`. Token refresh logic lives in `src/lib/auth/refresh.ts`.

**Bounded JWT membership payload.** The JWT is a fixed-size cookie credential — `memberships[]` / `orgMemberships[]` are capped at `MAX_JWT_MEMBERSHIPS` (50) in the `jwt` callback. Over the cap, `membershipsTruncated` / `orgMembershipsTruncated` is set and the middleware's `checkTenantAccess` / `checkOrgAccess` defers a slug-miss to the authoritative DB-backed server gate (`TenantLayout` / `getTenantCtx`) instead of denying. UI that needs the COMPLETE list (the `/tenants` picker) does its own server-side DB lookup — the JWT list is a bounded fast-path, not the source of truth. Old sessions (pre-cap, no flag) degrade gracefully: an absent flag reads as `false`, so they behave exactly as before until natural re-mint. Locked by `tests/guardrails/jwt-membership-bound.test.ts`.

**GAP-04 — type augmentation pattern.** `src/auth.ts` declares two module augmentations: `next-auth` for `Session.user` (id/tenantId/role/mfaPending/memberships) and `next-auth/jwt` for the full JWT shape (every custom field the codebase stores). Middleware reads typed `token.role` / `token.memberships` directly via `getToken({ req, secret })`. There are zero `as any` casts in the auth-critical path; the structural guardrail at `tests/guardrails/auth-stack-pinning.test.ts` fails CI if any are reintroduced.

**Compat shims.** `auth()` returns `Session | null` (alias for `getServerSession(authOptions)`) and `signOut({ redirectTo })` redirects to `/api/auth/signout?callbackUrl=…`. Both keep the 15+ server-component import sites stable across the v5→v4 migration. New code should import `getServerSession(authOptions)` directly to make the dependency explicit at each call site.

### Environment Validation

`src/env.ts` uses `@t3-oss/env-nextjs` for type-safe env vars. Tests set `SKIP_ENV_VALIDATION=1` to bypass this. Never add raw `process.env` access — add the var to `env.ts` first.

### Background Jobs (BullMQ)

Job definitions are in `src/app-layer/jobs/`. The executor registry is `src/app-layer/jobs/executor-registry.ts`. Jobs run inside `traceUsecase` spans and inherit request context.

### Billing & entitlements (GAP-18)

The codebase has two billing modes, decided by a single env var:

  • `STRIPE_SECRET_KEY` set → **SaaS mode**. Per-tenant plan
    (`FREE` / `TRIAL` / `PRO` / `ENTERPRISE`) is read from
    `BillingAccount.plan` and enforced at the mutation boundary
    via `assertWithinLimit(ctx, resource)` from
    `src/lib/billing/entitlements.ts`. SaaS tenants without a
    `BillingAccount` row resolve to `FREE`.

  • `STRIPE_SECRET_KEY` unset/empty → **self-hosted mode**.
    Every tenant resolves to `ENTERPRISE` and per-resource limits
    are unlimited. No DB query happens for plan resolution.

The decision is read once at module load. Today only `control`
creation is gated (FREE: 10, TRIAL/PRO: 100, ENTERPRISE: unlimited).
Adding a new gated resource is a one-line change in `PLAN_LIMITS`,
a `switch` arm in `getCurrentCount`, and one
`await assertWithinLimit(ctx, '<resource>')` call at the create-site.

**See `docs/billing.md`** for the full operator + developer runbook,
the reasoning behind plan limits, the failure-shape contract
(`forbidden('plan_limit_exceeded: …')` → 403), and the "what NOT to
do" list (no UI-only gating, no second mode-detection mechanism, no
duplicating the limits table).

## Testing Conventions

- **Unit tests**: Mock dependencies with `jest.mock()` declared **before** imports. Use `buildRequestContext()` helper from `tests/helpers/make-context.ts` to construct test contexts.
- **Integration tests**: Use `prismaTestClient()` and `resetDatabase()` from `tests/helpers/db.ts`. Hit a real DB — do not mock Prisma in integration tests.
- **Guard tests** (`tests/guards/`): Static analysis tests that enforce architectural rules (no `as any`, no unsafe patterns). These are regular Jest tests that scan source files with regex. They assert on source TEXT and contribute **no runtime coverage** — see "Green is not the same as executed" below before treating one as proof a feature works.
- **Rendered tests run as a PHONE by default.** `tests/rendered/setup.ts`
  stubs `matchMedia` to answer `matches: false` to every query, and
  `useMediaQuery` derives the device from two `min-width` probes — both
  false resolves to `isMobile: true`. That default is deliberate (this is
  a mobile-first product), but it decides which branch a test executes:
  `<DataTable mobileFallback="card">` renders `<MobileCardList>` on a
  phone, and `MobileCardList` **omits every column without
  `meta.mobileCard`**. So a test that means to assert the desktop
  `<table>` MUST call `setViewport('desktop')` from
  `tests/rendered/viewport.ts` before `render`, with
  `afterEach(restoreViewport)`. Tests that mean the phone branch should
  call `setViewport('mobile')` rather than inherit the default silently.
  Note `useMediaQuery` starts at `device = null`, so DataTable paints the
  table first and swaps to cards on the mount effect — render *counts*
  cannot tell you which branch a test saw, only the final DOM can. The
  mechanism is executed (not just asserted about) by
  `tests/rendered/viewport-helper.test.tsx`; the audit that found three
  suites green about a branch they never ran is
  `docs/implementation-notes/2026-07-30-rendered-suite-viewport-audit.md`.
- **E2E tests**: Playwright in serial mode (`workers: 1`). CI cuts
  wall-clock by CROSS-JOB sharding, not intra-run parallelism: the
  `e2e-shard` matrix in `ci.yml` runs `--shard=i/2` on two runners (each
  with its own isolated DB, each still serial), aggregated by the `E2E`
  gate job — `workers>1` was tried and reverted for flaking timing-
  sensitive specs. **Structural isolation, not shared state** (`chore/e2e-isolation`):
    - **Read-only specs** (list pages, filters, a11y, theme, tooltips,
      responsive, display checks — navigate + assert, never
      create/edit/delete) keep the SHARED seeded tenant via
      `loginAndGetTenant(page)` / `DEFAULT_USER`. They need the seed
      data and read-only access cannot cascade.
    - **Mutating specs** (anything that creates/edits/deletes) import
      `{ test, expect }` from `./fixtures` and declare the
      `isolatedTenant` / `authedPage` fixture. Each `test()` gets its
      own fresh, EMPTY tenant via `createIsolatedTenant` — writes can
      never touch the shared tenant or another test. An isolated
      tenant starts empty: the spec creates the resources it needs in
      its own body or a `beforeEach`.
    - **No cross-test `let` cascade.** A `let`/`var` assigned inside
      one `test()` and read by another is banned — a failed setup
      step would cascade. Make each test self-contained, or collapse
      a true sequence into ONE `test()` with `test.step(...)`
      sub-steps. Assigning a top-level `let` in a `beforeEach` /
      `beforeAll` is fine. Enforced by
      `tests/guards/e2e-isolation.test.ts`.
    - Use existing HTML `id` attributes — do NOT add `data-testid`
      attributes.
    - Scope `#id` / role locators to `getByRole('main')` where a
      Next streaming duplicate of the page could match — never a
      bare page-level locator (the lesson came from the since-removed
      risk-matrix E2E spec).
  See `docs/implementation-notes/2026-05-21-e2e-isolation.md` and
  `tests/e2e/fixtures.ts`.
- `SKIP_ENV_VALIDATION=1` is set in `jest.setup.js` to prevent env loader crash in unit tests.
- Coverage thresholds: 60% global (branches, functions, lines, statements); checked on `npm run test:coverage`.

### Green is not the same as executed

Three mechanisms in this repo let a check pass without verifying anything.
All read as green forever, so all are named here.

**Guards assert on source text, not behaviour.** Every file under
`tests/guards/` — and most of `tests/guardrails/` — `readFileSync`s a
source file and matches a regex. They execute the *test*, never the
*subject*, so they contribute **zero runtime coverage**: a heavily-guarded
file can sit at 0%. Two measured examples. `FilterRangePanel` was named by
eight guards while every decision point inside it was unexercised, until a
rendered test took it 0% → 88.76% branches
(`docs/implementation-notes/2026-07-28-coverage-wave-14.md`).
`tests/guardrails/jwt-membership-bound.test.ts` greps `src/auth.ts` for
`.slice(0, MAX_JWT_MEMBERSHIPS)` — it proves the JWT membership cap exists
in source and never once runs it (wave 15). A guard is the right tool for
"this pattern is present / this banned token is gone". When you need the
guarantee that the code *behaves*, write an executing test under
`tests/unit/`, `tests/rendered/`, or `tests/integration/`. The four-tier
model is `docs/frontend-assurance-model.md`; the curated structural-ratchet
↔ rendered-test pairing is
`tests/guards/behavioural-coverage-registry.test.ts`.

**A skipped suite is indistinguishable from a passing one.** The
`const describeFn = DB_AVAILABLE ? describe : describe.skip` gate used
across `tests/integration/**` means a run gets *greener* by running less —
observed live on `tests/guardrails/rls-coverage.test.ts`, which failed six
assertions against a stale DB and then went silent when that DB became
unreachable. If you add such a gate, keep the skip derived from a flag (a
hard `describe.skip(` never re-arms) and make the non-execution visible:
`rls-coverage.test.ts` carries an always-running execution-status test that
prints a banner naming what did not run, plus the
`RLS_GUARDRAIL_REQUIRE_DB=1` escalation for environments that guarantee a
database. The structural half of that contract lives in
`tests/guards/rls-coverage-skip-visibility.test.ts`, modelled on
`tests/guards/tooltip-kill-switch-consistency.test.ts`.

**Under jsdom the app is a PHONE, so a whole branch may be unreachable.**
`tests/rendered/setup.ts` stubs `matchMedia` to answer `matches: false` to
*every* query. `useMediaQuery` derives the device from two `min-width`
probes, and both false resolves to `isMobile: true`. Two consequences that
have each cost real time:

- `<DataTable mobileFallback="card">` renders **cards**, and
  `MobileCardList` omits every column without `meta.mobileCard`. The
  desktop `<table>` branch never mounts, so a suite can be green about a
  branch it has never executed. The 2026-07-30 audit found **three** such
  suites — `ag-pages-a11y` (the WCAG axe sweep: four of its six surfaces
  are card-fallback, so the table markup its docblock names had never been
  through axe), `org-drilldown-load-more`, and `grain-contracts-error-state`
  — plus one outright broken (`access-reviews-list`, asserting rows against
  a hidden sidecar of empty `<span>`s). Searching for table SELECTORS finds
  almost none of this: the damage is in suites whose stated purpose is the
  table, not in their locators. Only a dynamic probe settles which branch
  ran, and note `useMediaQuery` starts at `device = null`, so DataTable
  paints the table first and swaps to cards on the mount effect — render
  counts are ambiguous, only the final DOM is authoritative.
- Any component branching on a coarse-pointer or hover media query has
  that branch dead under jsdom. This is how a tooltip touch regression
  shipped: tap-to-toggle was added, `tooltip.test.tsx` passed, and the
  coarse-pointer path it added had never executed
  (`docs/implementation-notes/2026-07-29-tooltip-touch-uniformity.md`).

The phone default is deliberate — a phone is the operator's real device on
this product — so do not flip it globally. When a test genuinely means to
assert the desktop branch, override the stub for that test and restore it
in `afterEach`; the established `setViewport('desktop')` helper is in
`tests/rendered/inventory-client.test.tsx`. If you assert on a media-query
branch, say in the test which viewport it is asserting, or the next reader
cannot tell whether the pass was earned.

### Index & query-shape guardrails

Two structural guardrails enforce database-performance hygiene. Both
read the LIVE Prisma schema / `src/app-layer` source — no DB, no
migration-file coupling. The structured schema parser they stand on
is `tests/helpers/prisma-schema-models.ts` (`parseSchemaModels()`).

- `tests/guardrails/schema-index-coverage.test.ts` — four index
  layers. **A** (auto): every model with a `tenantId` field must have
  a `tenantId`-leading `@@index`/`@@unique`/`@@id`. **B** (auto):
  every foreign-key scalar field must be indexed — leading an index,
  or (on a tenant model) the 2nd column of a `[tenantId, fk]`
  composite. **C**
  (curated): `LIST_QUERY_INDEXES` — composite indexes backing
  specific list filter+sort shapes. **C-completeness** (auto): every
  tenant-scoped model that is `findMany`'d in `src/app-layer` must be
  in `LIST_QUERY_INDEXES` or `LIST_MODELS_TENANT_INDEX_SUFFICIENT`.

- `tests/guardrails/query-shape-guardrails.test.ts` — two query
  layers. **D1**: no Prisma READ call inside a loop (N+1).
  **D2**: a one-way-down budget on unbounded (`take:`-less)
  repository `findMany` calls.

**When you add a model:** Layers A/B/C-completeness fire
automatically. If the model has a `tenantId`, add a
`@@index([tenantId])` (or a tenantId-leading composite). Index every
FK column (a `[tenantId, fk]` composite counts) or expect Layer B to
flag it. The first `findMany` on the
model forces a Layer C-completeness triage — add it to
`LIST_QUERY_INDEXES` (with a real composite index) or to
`LIST_MODELS_TENANT_INDEX_SUFFICIENT` (with a written reason).

**When you add a `findMany`:** keep it bounded with `take:`. An
unbounded repository `findMany` must either add `take:` or carry
`// guardrail-allow: unbounded` with a reason. A read inside a loop
trips D1 — hoist it to one `findMany({ where: { id: { in: [...] } } })`
plus an in-memory map, or (for an intentional bounded-loop
idempotency check) add `// guardrail-allow: n+1` or a
`KNOWN_N_PLUS_ONE` entry with a reason.

All exempt/baseline maps carry a written reason per entry and a
"no stale entries" test — when a real index lands or an N+1 is
fixed, delete the entry in the same diff.

### Codebase-hygiene ratchets

Three codebase-hygiene invariants are held by structural guardrails
— **see `docs/codebase-hygiene.md`** for the contributor guide:

- **`as any` stays on a downward ratchet.** The `src/` count is 4
  (documented staged debt). `tests/guardrails/no-explicit-any-ratchet.test.ts`
  caps it via `CURRENT_BASELINE` with a drift sentinel (slack cannot
  accumulate); `tests/guards/no-explicit-any-ratchet.test.ts` caps
  `: any` / `<any>` / `as any` / `@ts-ignore`. Removing casts ⇒
  lower the baseline/caps in the same PR. `@typescript-eslint/no-explicit-any`
  is intentionally `warn` (a large `: any` debt makes `error`
  infeasible) — the ratchet is the enforcement.
- **Logging discipline applies to adapted code too.** No `console.*`
  in server code (`tests/guardrails/logging-import-hygiene.test.ts`);
  `src/lib/dub-utils/` is NOT exempt.
- **Route handlers type `params` as `Promise<…>`.** Next 15+
  contract; `tests/guards/async-params-route-typing.test.ts` blocks
  a regression. The old transparent-await shim is retired.

`tests/guards/codebase-hygiene-integrity.test.ts` is the meta-ratchet
over these four guardrails.

## Failing tests

A failing test on a branch is a failing test, full stop. "Pre-existing on
main" is a diagnosis, not a license to bypass it. The rule:

- **Run the affected test suites before claiming a task is done.** Don't
  rely on "my changes only touch X" — Jest projects, structural ratchets,
  and import graphs catch surprising regressions.

- **When a test fails, find the root cause first.** Check whether your
  change broke it; if not, check whether it's failing on `main` too. The
  goal is to know what the failure means, not to assign blame.

- **Pre-existing failures must be fixed, not bypassed.** If a suite is
  red on `main`, that's a bug — open a focused fix PR, link it from the
  current PR, and either (a) include the fix in the current PR if it's
  small and on-scope, or (b) explicitly call out the blocker in the PR
  description. Never silently admin-merge through a red test.

- **Never use `gh pr merge --admin` to push past failing CI** without
  the user's explicit authorisation for that specific PR. Required
  checks exist for a reason; the cost of pausing is low, the cost of
  shipping a regression to main is high.

- **Apply the same standard to dependency PRs.** A dependabot bump that
  breaks a test on `main` still needs the underlying breakage fixed,
  even though the bump itself is mechanical.

The exception: if the user has explicitly said "merge despite the
failures, I know what they are" for a specific PR, that authorisation
stands for that PR only — not as a precedent.

## Key Conventions

- **Zod schemas** for all API input validation live in `src/app-layer/schemas/` (backend) and `src/lib/schemas/` (shared).
- **Audit trail**: Call `logEvent()` from `src/app-layer/events/audit.ts` after mutating state. Entries are hash-chained — never write directly to the `AuditLog` table.
- **Error classes**: Use typed errors from `src/lib/errors/` rather than throwing raw `Error`.
- **i18n**: UI strings go through `next-intl`. Message files are in
  `messages/`. Server components use `getTranslations()`, client components
  use `useTranslations()`. **Every user-facing string is added to BOTH
  `en.json` AND `bg.json` in the same PR** — with a real Bulgarian
  translation, not the English value pasted in. Three guards enforce this so
  Bulgarian can't silently fall behind:
    - **No-new-hardcoded-string ratchet**
      (`tests/guards/no-hardcoded-ui-strings.test.ts`) — an AST scan of
      `src/app` + `src/components` caps hard-coded JSX text + user-facing
      string attributes at `CURRENT_BASELINE`; a new raw string fails CI.
      Every extraction PR lowers the baseline in the same diff. Error
      boundaries (`error`/`global-error`/`not-found.tsx`) are allowlisted.
    - **Key parity** (`tests/guardrails/i18n-completeness.test.ts` +
      `node scripts/i18n-diff.mjs --check`) — MISSING / ORPHAN /
      PLACEHOLDER-DRIFT between locales.
    - **Untranslated-copy** (same two files) — a `bg` value byte-identical
      to `en` that reads like prose is flagged; legitimately-identical values
      (brand, unit, deliberately bilingual) go in `UNTRANSLATED_ALLOWLIST`
      with a reason.
  `i18n-diff.mjs --check` runs in CI (the `Lint` job) and `.husky/pre-commit`.
- **Path alias**: `@/` maps to `src/`. Always use this alias — never relative paths crossing layer boundaries.
- **Two `DATABASE_URL` vars**: `DATABASE_URL` points to PgBouncer (transaction-mode, used at runtime). `DIRECT_DATABASE_URL` points directly to Postgres (used for Prisma migrations).
- **Page-section rhythm** (Roadmap-5 PR-9): the spacing scale
  (`tight` / `compact` / `default` / `section` / `page`) is rich, but
  vertical page rhythm wants only TWO answers most of the time.
    - **`space-y-section`** — between top-level page regions (page
      header, filter toolbar, primary table, footer toast). The
      24-32 px breath that says "this is a different kind of thing".
    - **`space-y-default`** — inside a card, between sibling fields,
      between rows in a panel. The 16 px breath that says "same kind
      of thing, next instance".
  Use `space-y-tight` / `space-y-compact` only inside dense field
  groups where the children are micro-elements (icon + label, status
  pills). The semantic-scale ratchet at
  `tests/guards/spacing-scale-discipline.test.ts` already bans raw
  numerics; this convention guides the choice between `default` and
  `section`.
- **Border tone discipline** (Roadmap-5 PR-10): three semantic
  border tones, each with a clear role.
    - **`border-border-subtle`** — DEFAULT. Structural separators
      (form-field outlines, table-cell separators, quiet panel
      boundaries, sidebar item dividers). If you have to ask
      "default or subtle?", the answer is subtle.
    - **`border-border-default`** — Reserved for surfaces that need
      explicit containment: card outer border, table outer border,
      modal/sheet boundary, popover/tooltip outline. The "this is a
      discrete surface" statement.
    - **`border-border-emphasis`** — Reserved for state: selected
      card, active panel, focused field, hovered click target. Tone
      that says "this is the one you mean".
  Forward enforcement at `tests/guards/border-tone-budget.test.ts`
  (budget ratchet that locks the current count and only ratchets
  down).
- **Action button vocabulary** (revised 2026-05-28). The label on a
  primary "create" header button is JUST the entity noun. The `+`
  glyph rides the `icon` slot — never as text. So an entity list page's
  header trigger reads:

  ```tsx
  <Button variant="primary" icon={<Plus />} onClick={…}>Asset</Button>
  ```

  not `+ Asset` (in text) and not `Create Asset` / `New Asset` /
  `Add Asset` (verb-prefixed). The verb is dead weight once the Plus
  glyph is doing the work, and the Button primitive's icon-balance ghost
  optically centres `[+] Asset` as one symmetric unit.

  Caveats — where verbs still belong:
    - **Modal/dialog confirm buttons** keep their verbed form
      (`Create asset`, `Add document`, `Save policy`) — confirmation
      surfaces need to declare the action, not just the subject.
    - **Detail-page "+ child entity" affordances** that attach to an
      open parent ("Add Document" on vendor detail, "Add Comment" on
      a task) follow this same icon-slot rule, but if you keep a verb
      it's `Add {Entity}` (the child-attachment register).
    - **Traceability / cross-entity association** uses
      `Link {Entity}` (`Link Asset`, `Link Control`) — the verb
      changes the meaning (associating, not creating).

  Forward enforcement:
    - `tests/guards/action-label-vocabulary.test.ts` — bans literal
      `+ Word` text in JSX/source.
    - `tests/guards/action-button-canonical-entity-label.test.ts` —
      asserts the canonical entity-page header buttons render
      `icon={<Plus />}` + bare noun, AND that the header-action
      i18n keys (`addAsset`, `addEvidence`, `newAudit`,
      `newFinding`) hold just the noun, not a verb-prefixed string.
- **Destructive-action vocabulary** (Roadmap-4 PR-9): every
  `<ConfirmDialog tone="danger">` confirmLabel MUST start with one of
  the canonical verbs below. Pick the one that matches the actual
  effect — the verb is the user's last clue before they commit.
    - **`Delete {Entity}`** — permanent erasure of a top-level entity
      or configuration (`Delete configuration`). The data is gone.
    - **`Remove {Item}`** — detach an item from a parent OR turn off
      an enrollment (`Remove MFA`, `Remove document`). Source row may
      live on.
    - **`Revoke {Credential}`** — invalidate an authority / credential
      (`Revoke API key`, `Revoke SCIM token`, `Revoke session`).
    - **`Discard {Draft}`** — abandon unsaved or draft state.
    - **`Archive {Entity}`** — soft delete with history preserved.
    - **`Unlink {Entity}`** / **`Detach {Entity}`** — break an
      association without deleting either side.
    - **`Reject {Request}`** — refuse an approval request or finding.
  Forward enforcement at `tests/guards/destructive-vocabulary.test.ts`.
- **Search placeholder vocabulary** (PR-9): every `<FilterToolbar
  searchPlaceholder>` value follows `Search {entityPlural}…`. One
  ellipsis (`…`, single character — not `...`). NEVER append a
  parenthetical hint like `(Enter)` / `(Press Enter)` — the
  FilterToolbar search is **live** (typing filters the table on a
  short debounce, no Enter required), so an Enter hint would be
  actively wrong. Forward enforcement at
  `tests/guards/search-placeholder-vocabulary.test.ts`. The same
  format applies to i18n `searchPlaceholder` values in `messages/`.
  Free-text search lives **inside the Filter dropdown**, NOT in a
  separate search bar: passing `searchPlaceholder` turns the Filter
  popover's top input into a live content search (the categories stay
  listed below it). Every standard list page MUST wire `searchId` +
  `searchPlaceholder` (the R14-PR7 kill sweep was reversed 2026-05-30,
  then the search was moved into the filter bar per user directive);
  presence is locked by `tests/guards/r14-no-page-searchbars.test.ts`.

## Implementation notes

**This file is a contract, not a scrapbook: a PR that invalidates a claim in
CLAUDE.md updates that claim in the same diff.** A stale operating manual is
worse than none — it sends the next engineer (or agent) down a path the code no
longer supports. If your change moves a file, renames a symbol, flips a default,
or supersedes a documented mechanism, fix the sentence here too.

Every substantive prompt — architectural decisions, new features, security
or infrastructure changes, anything worth revisiting in six months — lands
a short markdown file in `docs/implementation-notes/<YYYY-MM-DD>-<slug>.md`
alongside the code + tests. Commit messages carry the `what + why`; these
notes carry the `design + decisions + tradeoffs` in a grep-friendly form.

**Default structure** (skip any section that doesn't apply):

```markdown
# YYYY-MM-DD — <feature name>

**Commit:** `<sha> <commit subject>`

## Design
<architectural shape — diagrams or prose, 10-30 lines>

## Files
<table of files changed with one-line role per file>

## Decisions
<bullet list of non-obvious tradeoffs and why they went the way they did>
```

**Do NOT include a "Tests added" section** — the test files themselves
are the durable record. Duplicating counts into docs creates rot when the
test list moves.

**Skip** for small UI tweaks, config bumps, bug fixes that don't shift
architecture. The bar is "would a future engineer need the context?"

Existing examples: `docs/implementation-notes/2026-04-22-*.md`.

## UI Platform — Epics 51–60

The following epics established shared primitives, guardrail tests, and
contributor guides. **Always use the platform primitives** — never
hand-roll a replacement. Each section points to its decision-tree doc.

### Epic 51 — Design Tokens & Theme System

Use semantic token classes (`bg-bg-default`, `text-content-muted`,
`border-border-subtle`) instead of raw Tailwind color scales
(`bg-slate-800`, `text-slate-400`). Use `<Button>`, `<StatusBadge>`,
and `<EmptyState>` components instead of legacy `.btn` / `.badge` CSS
classes. See `docs/token-cheatsheet.md` and `docs/ui-buttons.md`.

### Epic 52 — DataTable Platform

Every list page must use `<DataTable>` from `@/components/ui/table`.
Never add raw `<table>` elements in app pages. Use the
`useListPagination` adapter for cursor-based APIs. See
`tests/guards/epic52-datatable-ratchet.test.ts`.

**List-page layout (the viewport-clamped scroll pattern):**
Wrap the page in `<ListPageShell>` from `@/components/layout/ListPageShell`
and pass `fillBody` to the primary `<DataTable>`. Result: the table
card fits the viewport, only the table body scrolls — page header,
filter toolbar, and pagination footer stay anchored. On mobile (<md)
the shell is a no-op and natural document scroll resumes.

```tsx
<ListPageShell>
  <ListPageShell.Header>...</ListPageShell.Header>
  <ListPageShell.Filters><FilterToolbar ... /></ListPageShell.Filters>
  <ListPageShell.Body>
    <DataTable fillBody data={...} columns={...} />
  </ListPageShell.Body>
</ListPageShell>
```

A new app page that imports `DataTable` MUST either wrap in
`<ListPageShell>` OR add itself to `EXEMPTIONS` in
`tests/guards/list-page-shell-coverage.test.ts` with a written
reason. Exemptions exist for multi-section dashboards (Coverage,
admin/api-keys, admin/notifications, admin/integrations) and
detail-page sub-tables / wizards where viewport-clamping doesn't fit. See `docs/epic-52-list-page-shell.md` for the
decision tree.

### Entity-page architecture (`EntityListPage` + `EntityDetailLayout`)

Two composition shells live in `src/components/layout/` —
`EntityListPage` (list pages) and `EntityDetailLayout` (detail
pages). Both carry **layout, not business content**. Reach for them
whenever you build a new entity page; never re-introduce the inline
`<ListPageShell> + <FilterToolbar> + <DataTable>` block or the
inline back-link / title / tab-bar / loading-skeleton dance.

```tsx
// List page — controls reference impl: ControlsClient.tsx
<EntityListPage<Row>
  header={{ title, count, actions }}
  filters={{ defs, searchId, searchPlaceholder, toolbarActions }}
  table={{ data, columns, getRowId, onRowClick, emptyState, … }}
>
  {/* page-level modals/sheets sit as children */}
</EntityListPage>

// Detail page — controls reference impl: controls/[controlId]/page.tsx
<EntityDetailLayout
  back={{ href, label }}
  title={…}
  meta={…}
  actions={…}
  loading={…}
  error={…}
  empty={…}
  tabs={…}
  activeTab={…}
  onTabChange={…}
>
  {/* active-tab content owned by the page */}
</EntityDetailLayout>
```

The shells are reusable; the pages stay opinionated. Column defs,
filter defs (including runtime-derived options), data fetching,
mutations, optimistic updates, modals, sheets, permission gates,
and domain-specific tab bodies (e.g. `TraceabilityPanel`,
`LinkedTasksPanel`, `TestPlansPanel`) all stay in the page.

**When NOT to reach for these shells.**

  - Multi-section dashboards (already in the Epic 52 `EXEMPTIONS`
    list — Coverage, admin/api-keys, admin/notifications,
    admin/integrations).
  - Wizards / multi-step flows where the page isn't a single list or
    detail.
  - Sub-tables nested inside a detail tab — `<DataTable>` directly
    is the right primitive there, not `<EntityListPage>`.

**Adoption ratchet.** Each adoption is locked by a structural test
that asserts the page mounts the shell and doesn't hand-roll the
inline composition: `controls-client-shell-adoption.test.ts` (list)
and `control-detail-shell-adoption.test.ts` (detail). When you
migrate a new entity page (policies / vendors / audits /
…), add a sibling `*-shell-adoption.test.ts` next to the existing
two — same shape, same regression-class lock.

See `docs/implementation-notes/2026-04-30-entity-page-architecture.md`
for the unified architecture rationale and
`docs/implementation-notes/2026-04-30-entity-detail-layout-extraction.md`
for the detail-shell extraction.

### Epic 53 — Enterprise Filter System

Use `FilterToolbar` + `FilterProvider` + `useFilterContext` from
`@/components/ui/filter/` for list-page filtering. Never build ad-hoc
`useState` + manual URL sync. See
`src/components/ui/filter/GUIDE.md` and `docs/filters.md`.

**A `multiple: true` facet has a REQUIRED server-side counterpart.**
`filterStateToUrlParams` comma-joins a multi-select facet into ONE
param (`?status=DRAFT,ACTIVE`), so a route that reads it with a bare
`searchParams.get(key)` receives the literal string `"DRAFT,ACTIVE"`.
Passing that to Prisma as an enum equality throws a
`PrismaClientValidationError` — a 500 the list page renders as its
EMPTY state, i.e. a confident claim of zero matching rows in response
to a crash. Parse such params with `parseCsvEnumParam` from
`@/lib/validation/query-params` (validates each member against
`z.nativeEnum(...)`, 400 on any invalid one), type the usecase's
filter field as an ENUM ARRAY — never `string` plus a cast — and query
with `{ field: { in: [...] } }` guarded on `.length` so a cleared
facet omits the filter instead of emitting `{ in: [] }` (which matches
nothing). Reference: `grain/contracts` route + `listContracts`.

**A failed list read must never fall through to the empty state.**
`<DataTable>` / `EntityListPage` accept `error` — wire it. Gate it on
having nothing to show (`isError && rows.length === 0`) so a failed
BACKGROUND refetch keeps stale rows on screen: `error` renders
*instead of* the table, so raising it unconditionally blanks good
data. See `docs/implementation-notes/2026-07-25-grain-contract-defect-fixes.md`.

### Epic 54 — Modal & Sheet Strategy

Use `<Modal>` for quick create/edit/confirm flows and `<Sheet>` for
inspect-and-edit without losing list context. Never hand-roll a
`fixed inset-0 bg-black/…` overlay. See `docs/modal-sheet-strategy.md`.

### Epic 55 — Combobox & Form Primitives

Use `<Combobox>` for selection lists, `<UserCombobox>` for people
pickers, `<RadioGroup>` for 2–5 visible choices, and wrap every
field with `<FormField>`. Never use raw `<select>` or
`<input className="input">` in app pages. See
`docs/combobox-form-strategy.md`.

### Epic 56 — Tooltip & Copy Primitives

Use `<Tooltip>` for hover/focus hints, `<InfoTooltip>` for help icons,
`<CopyButton>` / `<CopyText>` / `useCopyToClipboard` for clipboard.
Never use raw `navigator.clipboard` or add new `title=` attributes.
See `docs/tooltip-and-copy-strategy.md`.

**Tooltips carry TWO open gestures and exactly ONE behaviour.** Since
#449 the primitive drives `open` itself on a coarse pointer — tap
toggles, dismissing on the next outside tap, on scroll, or after
`TOUCH_AUTO_DISMISS_MS` — because Radix gives touch users nothing and a
desktop-only tooltip is decoration on a mobile-first product. Content,
surface, side/align/offset are identical for both; only the gesture
differs. That second path lives **inside `src/components/ui/tooltip.tsx`
and nowhere else**: never re-implement it at a call site
(`matchMedia('(pointer: coarse)')`, `'ontouchstart' in window`,
`onTouchStart` on a trigger), never add a prop that forks or disables it
(`disabled` is the sanctioned escape hatch and short-circuits for
everyone), and never drop one of the four dismissal paths (outside tap,
scroll, Escape, timeout).

**The tap handler must never call `preventDefault()`.** #449 shipped it on
the trigger's `onPointerDown` + `onClick` to make Radix's
`composeEventHandlers` skip its composed close-handlers; it also cancelled
the default action of whatever the tooltip wrapped, so on touch a
`<Tooltip>` around a `<Link>` (Next's app-dir Link returns early on
`e.defaultPrevented`) or an `<a href download>` did nothing but show its
own tooltip — ~17 inline call sites plus every collapsed-sidebar nav item.
Radix's close requests are declined in `handleTouchOpenChange` instead:
because the coarse path already passes `open` + `onOpenChange`, every
close arrives as a call we own rather than a DOM event we have to
suppress. Declining a close is invisible to the wrapped element;
preventing an event is not. Escape became ours for the same reason —
Radix's DismissableLayer dismissal is declined along with every other
close — and is wired through the Content's `onEscapeKeyDown`, which runs
before that dismissal and rides Radix's own document-level listener, so
Epic 57's ban on raw `keydown` listeners still holds.

`tests/guards/tooltip-touch-uniformity.test.ts` enforces the shape and
`tests/rendered/tooltip-touch.test.tsx` the behaviour — the latter
installs a coarse-pointer `matchMedia` per test, because the project-wide
jsdom stub answers `matches: false` and left the whole branch unexecuted.
See `docs/implementation-notes/2026-07-29-tooltip-touch-uniformity.md`.

### Epic 57 — Keyboard Shortcuts & Command Palette

Register shortcuts via `useKeyboardShortcut` — never
`document.addEventListener('keydown', …)`. Always supply a
`description`. See `docs/keyboard-shortcuts.md`.

### Epic 58 — Date Pickers

Use `<DatePicker>` for single dates and `<DateRangePicker>` for
ranges. Use `formatDate` / `formatDateTime` from `@/lib/format-date`
for display. Never use `<input type="date">` or raw
`toLocaleDateString`. See `docs/date-picker.md`.

### Epic 59 — Dashboard Charts

When adding or modifying charts/visuals on any dashboard page,
always use the shared chart platform. See `docs/charts.md` for the
decision tree. Never use raw `<svg>`, `<polyline>`, or inline
`style={{ width: \`\${pct}%\` }}` progress bars.

### Epic 60 — Shared Hooks & Polish Primitives

Import shared hooks from `@/components/ui/hooks` (barrel): `useLocalStorage`,
`useOptimisticUpdate`, `useEnterSubmit`, `useInputFocused`, `useScroll`,
`useScrollProgress`, `useInViewport`, etc. Use the polish primitives
`<Accordion>`, `<TabSelect>`, `<ToggleGroup>`, `<Slider>`,
`<NumberStepper>` for dense interaction areas. Never hand-roll a tab
bar, segmented filter row, `localStorage` cache, Enter-submit handler,
or `<input type="number">` stepper — reach for the shared primitive. See
`docs/epic-60-shared-hooks-and-polish.md` and the ratchet
`tests/guards/epic60-ratchet.test.ts`.

### Epic 60 — Automation Events & Dispatch (backend)

The event-driven backbone the rule-builder epic will stand on.
Import everything from `@/app-layer/automation` (single barrel).
Emit via `emitAutomationEvent(ctx, input)` — never construct
`AutomationExecution` rows directly from a usecase. When adding a
new event: add to `events.ts`, add the typed variant to
`event-contracts.ts`, emit from the usecase (or audit emitter), and
write a wiring test. Action handlers, rule-builder UI, and filter
DSL evolution all plug into clearly-marked seams — don't bypass
them. See `docs/automation-events.md` for the full contributor
guide and the decision-tree for extensions.

### Epic 67 — Destructive-action undo-toast convention

Every delete / unlink / remove flow in the product MUST use
`useToastWithUndo()` from `@/components/ui/hooks`. The hook returns
a stable `trigger` function that schedules the destructive commit
to fire 5 seconds after the click; during that window a custom
toast renders with an Undo button + animated countdown bar. Click
Undo and the timer is cancelled — the destructive write never
happens. The pending state lives at module scope (NOT in component
state) so commits survive client-side navigation, mirroring Gmail's
"undo send" UX.

The wired sites today: cross-entity unlink in `TraceabilityPanel`,
control-evidence + control-requirement unlink on the control detail
page, task link removal on the task detail page, and vendor
document removal on the vendor detail page. The structural ratchet
at `tests/guards/epic-67-rollout-coverage.test.ts` locks the wiring
in — adding a new site means appending it to `SITE_CONTRACTS`.

Never write a `confirm()` blocking dialog or a fire-and-forget
direct DELETE for a routine destructive action — those are the
anti-patterns Epic 67 replaces. Top-level entity deletion (tenant,
organization, framework) is the documented exception: cascading
consequences mean the 5-second window is too short, so use a
typed-confirmation modal there instead.

See `docs/destructive-actions.md` for the canonical wiring (snapshot
+ optimistic remove + trigger), the four invariants every site must
satisfy, message-tone rules, when NOT to use the pattern, and the
test layout (hook hardening at
`src/components/ui/hooks/__tests__/use-toast-with-undo.test.ts`,
baseline + UI tests under `tests/rendered/`, structural ratchet
under `tests/guards/`).

### Epic 68 — List virtualization

Single shared windowing primitive (`<VirtualizedList>`) wraps
`react-window` + `react-virtualized-auto-sizer`. Don't import
`react-window` directly — the primitive is the only seam.

Two production rollouts:

- **`<DataTable>` rows** — auto-virtualizes when `data.length > 1000`.
  Threshold raised from 100 → 1000 in a follow-up to scope auto-
  virtualization to genuinely large unpaginated tables (the lower
  threshold caused click-intercept regressions on medium-sized
  tables in Playwright). `virtualize={false}` opts out (Controls
  page contract). `virtualize={{ threshold: N }}` customises.
  Pages that legitimately need virtualization on smaller datasets
  should opt in explicitly. Falls back to the standard `<Table>`
  automatically when pagination, column resizing, column pinning,
  or empty/error/loading chrome is requested.
- **`<Combobox>` / `<UserCombobox>` dropdowns** — auto-virtualize
  when visible options exceed `COMBOBOX_VIRTUALIZE_THRESHOLD = 50`.
  cmdk's nav (which assumes items live in the DOM) is bypassed in
  the virtualized branch via a bespoke capture-phase keyboard layer
  bound to the search input — ArrowDown / ArrowUp / Home / End /
  Enter all flow through there with `aria-activedescendant` tracking.
  `<UserCombobox>` is a thin wrapper over `<Combobox>` so it gets
  virtualization for free.

Performance contract: any list above the threshold renders ≤30 row /
option nodes regardless of dataset size. The benchmark test in
`tests/rendered/combobox-virtualize.test.tsx` locks both the
DOM-count invariant AND a wall-clock budget (1000 options + open in
<2s on CI) so accidental regressions are caught.

See `docs/list-virtualization.md` for the rollout decision tree
(when to use the primitive directly vs reach for `<DataTable>` /
`<Combobox>`), the four `VirtualizedList` contract rules, the
DataTable + Combobox preserved/dropped feature lists, and the test
layout.
