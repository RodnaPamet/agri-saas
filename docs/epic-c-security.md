# Epic C — Defense-in-Depth (operator + contributor index)

> Five layers, one defense-in-depth story. Read the source files
> linked below when you need details; come back here for the
> architecture summary, env-var reference, and verification runbook.

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│ Request                                                               │
│   ─▶ withApiErrorHandling (src/lib/errors/api.ts)                     │
│        ─▶ requirePermission(<key>, handler)                           │
│             ├─ getTenantCtx → resolves session + tenant + perms       │
│             ├─ hasPermission(appPermissions, key)                     │
│             │    ─ allowed → handler(req, args, ctx)                  │
│             │    ─ denied  → AUTHZ_DENIED audit + throw forbidden     │
│             ─▶ usecase                                                │
│                  ─ Epic C.5 — sanitize* before persist                │
│                  ─▶ runInTenantContext (Epic A.1)                     │
│                  ─▶ Prisma queries                                    │
│                  ─▶ appendAuditEntry                                  │
│                       └─ streamAuditEvent  ─ ─ ─▶  per-tenant buffer  │
│                                                    ↓ 100 events / 5s  │
│                                              POST <tenant SIEM>       │
│                                              X-Inflect-Signature: …   │
│                                                                       │
│   Sign-in flow (Epic C.3)                                             │
│        NextAuth jwt callback                                          │
│             ─ recordNewSession (caps expiresAt, evicts oldest if      │
│                                  over maxConcurrentSessions)          │
│             ─ verifyAndTouchSession on every JWT pass                 │
│                  └─ revoked or expired → SessionRevoked               │
└──────────────────────────────────────────────────────────────────────┘

  Local dev path                       CI / pre-merge path
  ──────────────                       ───────────────────
  .husky/pre-commit                    npm run test:ci
    └─ scripts/detect-secrets.sh         ├─ tests/guardrails/
         (staged files only)             │    api-permission-coverage.test.ts
                                         ├─ tests/guardrails/no-secrets.test.ts
                                         └─ tests/unit/security/*
```

| Layer | What it does | Source of truth |
|---|---|---|
| C.1 — API permission middleware | `requirePermission(<key>, handler)` enforces a granular `PermissionKey` against `RequestContext.appPermissions`. Composes with `withApiErrorHandling`. Audit on denial. | `src/lib/security/permission-middleware.ts` |
| C.1 — Route → permission map | Declarative map from URL regex to `PermissionKey`. Single source of truth for which routes need which keys; a CI guardrail keeps it in sync with the filesystem. | `src/lib/security/route-permissions.ts` |
| C.2 — Local secret-detection | `.husky/pre-commit` runs `scripts/detect-secrets.sh` against staged files only. Inline `pragma: allowlist secret` carve-out. | `scripts/detect-secrets.sh`, `.husky/pre-commit`, `.secret-patterns` |
| C.2 — CI secret-detection | `tests/guardrails/no-secrets.test.ts` walks `git ls-files` with the same patterns; `REPO_BASELINE` lists known-placeholder fixtures. | `tests/guardrails/no-secrets.test.ts` |
| C.3 — Session metadata + lifecycle | `UserSession` table (sessionId, ip, ua, expiresAt, lastActiveAt, revokedAt). NextAuth `jwt` callback records on first mint; touches throttled to 5min; honours revoked + expired as `SessionRevoked`. | `src/lib/security/session-tracker.ts` |
| C.3 — Concurrent-session + max-duration policy | `TenantSecuritySettings.maxConcurrentSessions` (revoke-oldest on overflow); `sessionMaxAgeMinutes` caps `expiresAt` at insert. | same module + `prisma/schema.prisma` |
| C.3 — Admin sessions UI | Sessions column + modal on `/admin/members`. Uses `GET /admin/sessions[?userId=]` + `DELETE /admin/sessions`. | `src/app/t/[tenantSlug]/(app)/admin/members/page.tsx` |
| C.4 — Audit event streaming | Best-effort outbound stream of every committed audit row to a tenant-configured webhook. Per-tenant buffer, 100-event / 5-second flush, HMAC-SHA256 signed, fail-safe. | `src/app-layer/events/audit-webhook.ts` |
| C.5 — Server-side sanitisation | `sanitizeRichTextHtml` / `sanitizePlainText` / `sanitizePolicyContent`. Wired into `policy.createPolicyVersion`, `task.addTaskComment`, `issue.addIssueComment` — sanitise before persist. | `src/lib/security/sanitize.ts` |
| Disclosure | Coordinated disclosure policy + safe-harbour. | `SECURITY.md` |

## Environment variables

Epic C does not introduce any new global env vars. All policy is
**per-tenant** through `TenantSecuritySettings`:

| Field | Default | Effect when set |
|---|---|---|
| `sessionMaxAgeMinutes` | `null` (NextAuth default — 30 days) | Hard cap on `UserSession.expiresAt`. |
| `maxConcurrentSessions` | `null` (unlimited) | When the user is at the cap, the oldest session (by `lastActiveAt` ASC) is revoked with `revokedReason: 'policy:concurrent-limit'` to make room. |
| `auditWebhookUrl` | `null` (streaming disabled) | HTTPS endpoint that audit batches POST to. |
| `auditWebhookSecretEncrypted` | `null` | HMAC-SHA256 secret. **Stored encrypted** via the Epic B field-encryption manifest — write/read round-trips through the middleware automatically. |

There are no kill-switch env vars; degraded behaviour is built into
each layer (see "Failure modes" below).

## Verification runbook

Run the whole Epic C test bundle locally before promoting:

```bash
npx jest \
  tests/unit/security/ \
  tests/unit/audit-webhook.test.ts \
  tests/guardrails/api-permission-coverage.test.ts \
  tests/guardrails/admin-route-coverage.test.ts \
  tests/guardrails/no-secrets.test.ts \
  --no-coverage
```

Expected: every suite green. Reference run-time on this repo: ≈ 3s.

### V.1 — Permission denied flow (C.1)

**Goal:** prove that an unprivileged session is rejected at the API
boundary AND that the denial is recorded.

```bash
# Sign in as a READER, then probe an admin endpoint.
curl -i -X GET https://app.example.com/api/t/<slug>/admin/scim \
     -H "cookie: next-auth.session-token=<reader session cookie>"
```

Expected:

- `HTTP/2 403`
- Body: `{"error":{"code":"FORBIDDEN","message":"Permission denied", …}}`
- The message is **generic** — the response never echoes the
  `admin.scim` key (response-side hardening; the audit row carries the
  key for security review).
- A new row in `AuditLog`:
  ```sql
  SELECT entity, "entityId", action, "detailsJson"
  FROM "AuditLog"
  WHERE action = 'AUTHZ_DENIED'
  ORDER BY "createdAt" DESC LIMIT 1;
  ```
  `entity = 'Permission'`, `entityId = 'admin.scim'`,
  `detailsJson.category = 'access'`,
  `detailsJson.event = 'authz_denied'`.

### V.2 — Secret detection (C.2)

**Goal:** prove both the local hook and the CI guardrail catch a
planted secret.

Local (Husky pre-commit):

```bash
echo 'const k = "AKIAIOSFODNN7EXAMPLE";' > /tmp/leak.ts  # pragma: allowlist secret — AWS canonical "this-is-fake" placeholder used in AWS's own docs
git add /tmp/leak.ts            # not in repo, but the hook scans staged files
git commit -m 'leaks AWS key'
# Expected:
#   ✖ Possible secrets detected in staged changes
#   :  AWS Access Key ID
git restore --staged /tmp/leak.ts
rm /tmp/leak.ts
```

CI guardrail:

```bash
npx jest tests/guardrails/no-secrets.test.ts --no-coverage
```

Expected: green. If a real new secret has slipped in, the failure
message names the file + pattern + line and tells the developer how to
fix it (rotate, allowlist, or move to `tests/fixtures/secrets/`).

### V.3 — Concurrent session enforcement (C.3)

**Goal:** prove that a 4th sign-in evicts the oldest session when
`maxConcurrentSessions = 3`.

```sql
-- Set the policy on a test tenant.
UPDATE "TenantSecuritySettings"
SET "maxConcurrentSessions" = 3
WHERE "tenantId" = '<tenant-id>';
```

```bash
# Sign in 4 times for the same user from 4 different curl/browser
# sessions. After the 4th sign-in:
SELECT "sessionId", "lastActiveAt", "revokedAt", "revokedReason"
FROM "UserSession"
WHERE "userId" = '<user-id>'
  AND "tenantId" = '<tenant-id>'
ORDER BY "createdAt" DESC;
```

Expected: 3 rows with `revokedAt IS NULL`, 1 row with
`revokedReason = 'policy:concurrent-limit'` and a `revokedAt`
timestamp matching the 4th sign-in.

Max-duration enforcement:

```sql
UPDATE "TenantSecuritySettings"
SET "sessionMaxAgeMinutes" = 60
WHERE "tenantId" = '<tenant-id>';
```

Then sign in. The new `UserSession.expiresAt` should be ≈ 60 minutes
out, NOT 30 days.

### V.4 — Audit event streaming (C.4)

**Goal:** prove a committed audit row reaches the configured SIEM with
a verifiable signature.

```sql
-- One-time setup — point a test tenant at a webhook.site bucket.
UPDATE "TenantSecuritySettings"
SET "auditWebhookUrl" = 'https://webhook.site/<bucket-uuid>',
    "auditWebhookSecretEncrypted" = 'shhh-test-secret'
WHERE "tenantId" = '<tenant-id>';
-- Note: the field-encryption middleware encrypts on write.
```

Trigger any audited action (deny a permission, revoke a session,
create a control). Within 5 seconds, the bucket should receive a POST:

```jsonc
{
  "schemaVersion": 1,
  "tenantId": "<tenant-id>",
  "sentAt": "...",
  "count": 1,
  "events": [{ "id": "...", "action": "...", "actorType": "USER", ... }]
}
```

Header `X-Inflect-Signature: sha256=<hex>` must equal
`computeHmacSha256(<body>, 'shhh-test-secret', 'hex')` — the existing
`verifyHmacSha256` helper in `src/app-layer/integrations/webhook-crypto.ts`
verifies it.

To exercise the batch-by-count path (100 events), drive a load test
that emits ≥100 audit-relevant actions for a single tenant in <5s; the
single resulting POST will carry `count: 100`.

### V.5 — Sanitisation before storage (C.5)

**Goal:** prove that a hostile rich-text payload lands clean in the
database, not just clean in the rendered UI.

```bash
# Create an HTML policy version with an embedded <script>.
curl -X POST https://app.example.com/api/t/<slug>/policies/<id>/versions \
     -H 'cookie: ...' -H 'content-type: application/json' \
     -d '{"contentType":"HTML","contentText":"<h1>Title</h1><script>alert(1)</script>","changeSummary":"v1"}'
```

Then read the row directly:

```sql
SELECT "contentText"
FROM "PolicyVersion"
ORDER BY "createdAt" DESC LIMIT 1;
```

Expected: `<h1>Title</h1>` — the `<script>` tag and its body must be
absent. Verify the same is true for task / issue comments via
`addTaskComment` / `addIssueComment`.

## Failure modes (by design)

Each layer degrades gracefully rather than failing closed when its
telemetry / outbound surface is unavailable:

| Layer | Degradation | Why |
|---|---|---|
| C.1 | If `appendAuditEntry` for the AUTHZ_DENIED row fails, the 403 still reaches the client and a `logger.warn` records the audit failure. | Telemetry side; never trade a working denial for a broken audit. |
| C.2 | A pre-commit bypass (`git commit --no-verify`) is intentional — the CI guardrail catches anything that escapes locally. | Developer ergonomics + final CI gate. |
| C.3 | `recordNewSession` swallows DB failures and returns a placeholder rowId so a Prisma blip can't lock users out at sign-in. `verifyAndTouchSession` is fail-open on DB errors. The classic `User.sessionVersion` check remains as a backstop. | Sign-in is on the hot path; transient DB unavailability must not sign every active user out. |
| C.4 | Outbound POST failures (timeout, non-2xx, connection reset) log a warning and drop the batch. Subsequent events are still buffered. | The audit row is already committed — streaming is a side-view. |
| C.5 | `sanitize*` returns `''` for null / undefined / non-string. A future TS-loose call site can't bypass sanitisation. | Defensive defaults; never throw out of a sanitiser. |

## Rollback procedure

Use only in a genuine incident. Each sub-epic rolls back independently.

### C.1 — Permission middleware

If a specific permission key is mis-mapped, hot-fix the rule in
`src/lib/security/route-permissions.ts` and the corresponding
`requirePermission(<key>, …)` call site. The change is just a
TypeScript edit + redeploy — the guardrail at
`tests/guardrails/api-permission-coverage.test.ts` will block a
regression.

If the entire layer needs to be disabled for one route in a 5-alarm
fire, `git revert` the commit that wrapped it with
`requirePermission`. The legacy `requireAdminCtx` swap-back is gone —
the helper was deleted 2026-05-21. Do NOT swap to unguarded
`getTenantCtx`; that drops the role check entirely.

### C.2 — Secret detection

Local hook: `git commit --no-verify` (per-commit). If the hook itself
is wedged, `git config core.hooksPath ''` disables Husky entirely —
the CI guardrail still runs.

CI guardrail: an emergency PR bypass is **not** provided. If
`tests/guardrails/no-secrets.test.ts` is failing CI for a known-safe
fixture, add it to `REPO_BASELINE` with a written `reason` in the same
PR.

### C.3 — Session limits

Set `maxConcurrentSessions = NULL` and/or `sessionMaxAgeMinutes = NULL`
on `TenantSecuritySettings` for the affected tenant. Existing
`UserSession` rows with `revokedAt` set stay revoked — clear them only
if you're certain a row was wrongly evicted:

```sql
UPDATE "UserSession"
SET "revokedAt" = NULL, "revokedReason" = NULL
WHERE "tenantId" = '<id>'
  AND "revokedReason" = 'policy:concurrent-limit'
  AND "revokedAt" > NOW() - INTERVAL '10 minutes';
```

### C.4 — Audit streaming

Set `auditWebhookUrl = NULL` to disable streaming for a tenant. The
in-process buffer drops un-flushed events on the next flush attempt
(the resolver returns null → silent drop) — the audit table itself is
never affected.

### C.5 — Sanitisation

Sanitisation is purely a write-path transformation; rolling back means
either deleting the call site (allowing raw input through) OR leaving
it in place and accepting cleaner-than-required content. There is no
operator action to take — sanitisation never fails the request.

## Remaining non-blocking caveats

1. **The audit-stream buffer is per-process.** In a multi-instance
   deployment, each Node process has its own buffer. This is fine for
   at-least-once-per-process semantics but means a slow consumer can't
   coalesce across instances. Future hardening: move the buffer into
   Redis (the swap point is `getBuffer` in
   `src/app-layer/events/audit-webhook.ts`).

2. **Session `lastActiveAt` is throttled to 5 minutes.** Activity
   bursts within a 5-minute window touch the row only once. This is
   intentional — the alternative (a write per request) would dominate
   the row's WAL footprint. Consequence: the admin "last active"
   timestamp can be up to 5 minutes stale.

3. **The OpenAI / Anthropic regex tightness assumes today's key
   prefixes.** If either provider rotates their format, update the
   pattern in `.secret-patterns` and add a positive case in
   `tests/unit/security/detect-secrets.test.ts`.

4. **Revoke-oldest is the chosen overflow policy.** A future tenant
   with strict access-control posture may prefer "deny new" — switch
   the strategy in `evictOldestSessionsToFit` (one function, ~15
   lines). The unit test fixtures cover both shapes.

5. **`category: 'access'` is the canonical audit-details category for
   authn/authz events.** The audit-details schema is closed
   (`entity_lifecycle | data_lifecycle | status_change | relationship | access | custom`); a new event type that doesn't fit needs to land
   in `src/app-layer/schemas/json-columns.schemas.ts` first or it
   will be silently dropped by `validateAuditDetailsJson`.

6. **The sanitiser allowlist is conservative on purpose.** If the
   product needs additional formatting (footnotes, KaTeX, embedded
   images), widen `RICH_TEXT_ALLOWED_TAGS` / `RICH_TEXT_ALLOWED_ATTRS`
   in `src/lib/security/sanitize.ts` and add positive + negative test
   cases in `tests/unit/security/sanitize.test.ts`. Do not add `style`,
   `class`, `id`, `<svg>`, `<iframe>`, `<object>`, `<embed>` without a
   security review.

## SCIM at the Edge (2026-08-19)

`/api/scim/` is in `PUBLIC_PATH_PREFIXES`, which looks alarming and is not.

A SCIM bearer is an opaque token compared against a SHA-256 hash in
`TenantScimToken`. The Edge middleware runs on the Edge runtime with no
database, and `getToken()` understands only a NextAuth JWE — so the Edge
**cannot** verify a SCIM credential. Before the carve-out it did the only thing
it could: `getToken()` returned `null` and every SCIM request was answered
`401 {"error":"Unauthorized"}`. Provisioning had never worked for anyone, since
the feature shipped, and CI could not see it because the SCIM tests import
`authenticateScimRequest` directly and never cross the middleware.

**Authentication for these routes lives in the handlers**, via
`authenticateScimRequest`. That is not a convention anyone has to remember:

| control | what it holds |
|---|---|
| `tests/guards/scim-routes-self-authenticate.test.ts` | Fail-closed. Derives the route inventory from the filesystem, so a NEW route under `/api/scim` is covered the moment it exists. One written exemption: `ServiceProviderConfig` (RFC 7644 §4 discovery metadata, no DB access), and the guard fails if that file ever grows a database call. |
| `tests/unit/scim-edge-reachability.test.ts` | Executing. Drives the real middleware; asserts SCIM passes and that a normal tenant route with the same unusable bearer still 401s. |
| `tests/e2e/scim-provisioning.spec.ts` | Real HTTP. A bad token must return the **SCIM Error schema**, not the Edge's generic body — that is the difference between "the handler rejected you" and "the handler never ran". |
| `src/lib/rate-limit/scimRateLimit.ts` | Budget. See below. |

**Tenant isolation is stronger here than a URL slug, not weaker.**
`authenticateScimRequest` resolves the tenant from the token itself, so a token
can only ever act on its own tenant; there is no slug in the path to mismatch.

**The token-minting route is NOT covered by the carve-out.**
`POST /api/t/:slug/admin/scim` stays behind the session gate and
`requirePermission('admin.scim')` — the trailing slash on `/api/scim/` is what
keeps the carve-out from widening, and both the unit test and the e2e assert a
SCIM bearer cannot reach it.

### Rate limiting

SCIM had **no** tier at all: the read tier requires an `/api/t/` prefix, and the
mutation tier lives in `withApiErrorHandling`, which the SCIM handlers do not
use. Now that these routes are anonymous at the Edge, they are the one API
surface where an unauthenticated caller reaches a token comparison — a
brute-force oracle if unbudgeted.

`SCIM_LIMIT` (300/min per bearer) and `SCIM_IP_LIMIT` (600/min per IP) in
`src/lib/security/rate-limit.ts`. **Both are required.** Per-bearer alone does
nothing against the attack: a caller who sends a fresh guess each request gets a
fresh bucket each request and is never limited. Per-IP alone would throttle
innocent tenants, because Entra egresses several tenants' syncs from one
Microsoft IP pool — hence the ceiling being double the per-tenant budget. The
bearer is hashed into the rate-limit key so a live credential never lands in
Redis or a log.

Operator knobs: `RATE_LIMIT_ENABLED=0` bypasses (all tiers),
`RATE_LIMIT_MODE=memory` forces the in-process store. Fail-open on backend
error — an Upstash outage must not take provisioning down.


## Signed webhooks at the Edge (2026-08-20)

Three endpoints join SCIM in `PUBLIC_PATH_PREFIXES`:

| route | credential |
|---|---|
| `/api/stripe/webhook` | Stripe signature via `constructWebhookEvent` |
| `/api/storage/av-webhook` | HMAC-SHA256 over the raw body, `timingSafeEqual` |
| `/api/integrations/webhooks/:provider` | per-connection secret via `processIncomingWebhook` |

**They had never been delivered.** Their senders — Stripe, the AV scanner, a
third-party service — cannot carry a NextAuth session cookie, so `getToken()`
returned null and the middleware answered `401 {"error":"Unauthorized"}` before
any handler ran. Verified by driving the real middleware.

Latent rather than live on the current deployment (Stripe unconfigured, AV
scanning disabled), which is exactly what let it survive: it fails **silently**
the day either is enabled. Set `STRIPE_SECRET_KEY` and subscription state
simply never updates — payments succeed, plans never change, nothing errors.

**Every handler fails CLOSED with no secret configured**, which is what makes
opening the Edge safe: Stripe throws (`STRIPE_WEBHOOK_SECRET is not
configured`), the AV webhook 500s in production, integrations 401. The AV
webhook has an explicit dev-only bypass, gated on `NODE_ENV !== 'production'`.

### The guard is general, not per-route

`tests/guards/public-routes-self-authenticate.test.ts` enforces **both**
directions of one rule, derived from the filesystem:

- **A** — a route reading a credential header and verifying it must be
  reachable. Six instances of this failing shipped (`token.error`, `iflk_`,
  SCIM, and these three).
- **B** — a route behind a public prefix must verify something.

Either alone is worse than none: A without B turns dead endpoints into
anonymous ones; B without A leaves them dead. When first run it flagged
`/api/staging/seed` and the integrations webhook — both legitimate, and the
DETECTOR was widened rather than the routes exempted, because an exemption
would hide the next genuinely-anonymous route added under either prefix.

`tests/unit/webhook-edge-reachability.test.ts` is the behavioural half: it
drives the real middleware, and includes a negative control plus assertions
that the neighbouring paths (`/api/stripe/customers`,
`/api/integrations/connections`, `/api/storage/upload`) are still gated.

### Rate limiting

They share the SCIM tier (`SCIM_LIMIT` 300/min per credential, `SCIM_IP_LIMIT`
600/min per IP). Same traffic class — machine-to-machine, signed, bursty on
retry — and a separate budget would be a number nobody could justify
differently. The point is the same as SCIM's: an anonymous caller reaching a
signature comparison is unbounded database and log load, since every handler
logs a warn on a bad signature.


---

## Defense-in-Depth (Epic C) — the reasoning behind the five controls

Relocated from CLAUDE.md (#1334), which keeps the rules as imperatives. **Read this before touching `requirePermission`, `PUBLIC_PATH_PREFIXES`, the secret-detection patterns, session revocation, the audit stream or `sanitizeRichTextHtml`.** It records why each control is shaped the way it is — including three separate occasions when a complete, unit-tested mechanism was severed at the Edge and nobody noticed: SCIM provisioning had NEVER worked for anyone, no CSP violation report ever reached the store, and all three signed-webhook senders had never been delivered.

Five complementary controls. Treat them as one system — each
sub-epic has the others as backstops.

**C.1 — API permission middleware.** Wrap every privileged API
handler with `requirePermission(<key>, …)` from
`@/lib/security/permission-middleware`. The key is a typed dotted
literal (`'admin.scim'`, `'tasks.create'`, …) derived from
`PermissionSet`. Denials emit a hash-chained `AUTHZ_DENIED` audit
entry (`category: 'access'`) and surface as a generic 403 — the
key itself is never echoed to the client. The route ↔ map sync is
guarded by `tests/guardrails/api-permission-coverage.test.ts`;
new admin/privileged routes MUST add a rule in
`src/lib/security/route-permissions.ts` and use
`requirePermission(...)`. The legacy `requireAdminCtx` /
`requireWriteCtx` / `requireRoleCtx` helpers no longer exist —
`src/lib/auth/require-admin.ts` was deleted (2026-05-21) once every
route had migrated (see D.3), and the ratchet
`tests/guardrails/no-legacy-admin-guard.test.ts` fails CI if the module
or any of the three identifiers reappears under `src/`.

**C.1a — SCIM authenticates in the HANDLER, not at the Edge.**
`/api/scim/` is in `PUBLIC_PATH_PREFIXES` on purpose. A SCIM bearer is an
opaque token compared against a hash in `TenantScimToken`, the Edge runtime
has no database, and `getToken()` understands only a NextAuth JWE — so the
Edge cannot verify one. It used to do the only thing it could: return `null`
and 401 every request, which meant **SCIM provisioning had never worked for
anyone** while its integration tests stayed green (they import
`authenticateScimRequest` directly and never cross the middleware). Every
data-bearing handler under `/api/scim` therefore calls
`authenticateScimRequest` itself, held FAIL-CLOSED by
`tests/guards/scim-routes-self-authenticate.test.ts`, which derives the route
list from the filesystem so a new route is covered the moment it exists. The
one exemption is `ServiceProviderConfig` (RFC 7644 §4 discovery metadata), and
the guard fails if that file ever touches the database. The trailing slash on
the prefix was LOAD-BEARING — `'/api/scim'` would also have opened
`/api/scimulator` — and since 2026-10-02 it is belt-and-braces instead:
`matchesPublicPrefix` requires a public-prefix match to end at `/`, `?`, `#` or
the end of the string, so a sibling sharing a spelling is refused whether or
not the entry carries a slash. **Keep writing the slash** on a prefix entry; it
states the intent, and `'/api/scim/'` still correctly declines to open the bare
`/api/scim`. What changed is that the OTHER 20 bare entries — `/api/metrics`,
`/api/readyz`, `/api/admin/tenants` and the rest — are no longer one forgotten
character away from publishing `/api/metrics-internal`. A convention that holds
only where each of 27 authors remembered it was not a convention; measured
across all 464 route paths under `src/app`, the narrowing costs zero real
routes. See `tests/guards/public-prefix-segment-boundary.test.ts`.
SCIM has its own rate tier (`SCIM_LIMIT` + `SCIM_IP_LIMIT`) because it is the
one API surface an anonymous caller can use to reach a token comparison; the
per-IP ceiling is the half that actually stops a brute force, since a caller
rotating a fresh guess per request gets a fresh per-bearer bucket every time.
**When you add an auth scheme that is not the session cookie, add an HTTP-level
test that crosses the middleware** — `token.error`, the `iflk_` API key and
SCIM were all complete, unit-tested mechanisms severed at that seam.
See `docs/epic-c-security.md`.

**C.1c — Uncredentialed browser beacons are the OTHER half of the reachable
class, and the C.1a/C.1b guard is blind to it.** A browser posts a CSP
violation report, a web-vitals beacon and a manifest fetch with **no
credentials** — so `getToken()` returns null and the Edge 401s them, exactly as
it did to SCIM and the webhooks. `tests/guards/public-routes-self-authenticate.test.ts`
does not catch these: its direction A derives from routes that READ and VERIFY
a credential, and a beacon sink verifies nothing. That blind spot cost five
months — `/api/security/csp-report` was never in `PUBLIC_PATH_PREFIXES`, so
**no CSP violation report ever reached the store** while `middleware.ts` itself
advertised the path in `Report-To` and `Reporting-Endpoints` a few hundred
lines below the gate that refused it. The class is small and closed — the CSP
sink, `/api/metrics`, the PWA manifest — and is enumerated in
`tests/unit/csp-edge-reachability.test.ts`. **Spell such an entry as the
CONSTANT that goes into the header** (`CSP_REPORT_PATH`), never a literal: the
same value feeds three response headers, and the duplicated-literal shape is
what produced the bug. Opening a beacon prefix opens EVERY method on it —
`isPublicPath` matches on prefix — so gate the privileged methods in the
handler FIRST, in the same diff. Here that was the summary `GET`, which returns
whole `CspViolation` objects (`clientIp`, `userAgent`) from a global un-tenanted
ring; it now requires `PLATFORM_ADMIN_API_KEY`, held by
`tests/unit/csp-summary-gate.test.ts` because direction B could not — its
`VERIFIES` check matches file TEXT, so a commented-out gate stays green.

**C.1b — Signed webhooks are public at the Edge, and verify themselves.**
`/api/stripe/webhook`, `/api/storage/av-webhook` and
`/api/integrations/webhooks/` are in `PUBLIC_PATH_PREFIXES` for the same
reason SCIM is: their senders cannot carry a session cookie, so `getToken()`
returns null and the Edge refused them — all three had NEVER been delivered.
Each verifies its own signature and fails CLOSED with no secret configured.
The rule is enforced in BOTH directions by
`tests/guards/public-routes-self-authenticate.test.ts`: a route that verifies
a credential must be REACHABLE, and a route behind a public prefix must
VERIFY. Either half alone is worse than neither — the first without the second
turns dead endpoints into anonymous ones. Both are derived from the
filesystem, so a new route is covered the moment it exists. See
`docs/epic-c-security.md`.

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
(`X-Agrent-Signature: sha256=<hex>` — the legacy `X-Inflect-Signature`
is dual-emitted at an identical value by default and dropped by
`AUDIT_STREAM_LEGACY_HEADERS=0`), POSTed to
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
`task.addTaskComment`, `issue.addIssueComment`, and
`knowledge.createArticle` / `knowledge.createArticleVersion` (via the
local `sanitizeContent` helper in `src/app-layer/usecases/knowledge.ts`,
which picks `sanitizeRichTextHtml` for `HTML` and `sanitizePlainText`
for `MARKDOWN`). The `policy.*` write paths this list used to name went
with the GRC teardown, and `sanitizePolicyContent` now has no production
caller at all — reach for the other two. New write paths
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


---

## Isolation & Sanitisation Completeness (Epic D) — the reasoning

Relocated from CLAUDE.md (#1334). **Read this before changing `UserSession` RLS, an encrypted-field write path, or any admin authorization guard.** The asymmetric single-policy RLS form on `UserSession` in particular is mandatory rather than stylistic, and the reason is written out here.

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
(All five have since been deleted — `risk` and `control-test` by the
2026-08 risk + control-exoskeleton uproot (#501), `finding` / `vendor` /
`audit` by GRC teardown phase 2 (#547) — so the paragraph below is
history; the RULE it states is unchanged for the encrypted surfaces
that remain.)
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
`tests/unit/security/sanitize-write-paths.test.ts` carried 20 write-path
assertions when Epic D landed; the GRC teardown deleted the policy /
finding / risk / vendor / audit / control-test blocks along with their
usecases, so it now drives the two surviving comment call sites —
`addTaskComment` and `addIssueComment` — with a script-strip plus an
entity-decode assertion each. `Task.description` / `Task.resolution` are
covered by the sibling `tests/unit/security/sanitize-task-fields.test.ts`,
split out because those paths need the full `WorkItemRepository` mocked
rather than just `TaskCommentRepository.add`.

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
